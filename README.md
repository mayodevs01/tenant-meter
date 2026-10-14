# Tenant Meter

A small, durable usage ledger for SaaS applications. Record billable events by tenant and meter, safely retry with an idempotency key, enforce a UTC calendar-month quota, and export the event trail as CSV.

This is an early open-source project. It has no claimed production users, downloads, or external contributors.

## Why this exists

Metered products need a reliable answer to questions like “How many API calls did this customer use this month?” and “Did this request already count?” Tenant Meter keeps the answer in a local SQLite file, with a unique key for each event and an atomic read/check/write transaction for quota enforcement.

## Requirements

- Node.js 24 or newer
- A writable local filesystem for durable use

No install-time dependencies are needed. Clone the repository and run:

```sh
npm test
npm run example
```

The example creates `example.db` in the current directory. It is ignored by Git.

## Library use

```js
import { UsageLedger } from 'tenant-meter';

const ledger = new UsageLedger({ path: './usage.db' });
try {
  ledger.setLimit({ tenant: 'team-42', meter: 'api-calls', monthlyLimit: 10_000 });

  // Use a stable ID from the request/job so a retry does not double count.
  const event = ledger.record({
    tenant: 'team-42',
    meter: 'api-calls',
    idempotencyKey: 'request-abc123',
    quantity: 1
  });

  console.log(event.duplicate); // false for a new event, true for an identical retry
  console.log(ledger.summary({ tenant: 'team-42', meter: 'api-calls' }));
} finally {
  ledger.close();
}
```

Until this package is published to a registry, use a local checkout: import from `./src/index.js`, or add this repository as a Git dependency after it has been published. `examples/basic.js` runs directly from a checkout.

### API

| Method | Purpose |
| --- | --- |
| `new UsageLedger({ path, clock? })` | Open/create a SQLite database. `path` defaults to `:memory:` for tests; pass a file path for persistence. |
| `setLimit({ tenant, meter, monthlyLimit })` | Set one limit for every UTC calendar month. Zero blocks new events. |
| `record({ tenant, meter, idempotencyKey, quantity? })` | Record a positive integer quantity. Defaults to 1. Identical retries return the original event with `duplicate: true`. |
| `summary({ tenant, meter, month? })` | Return usage, count, limit and remaining capacity. The month defaults to the current UTC month. |
| `listEvents({ tenant, meter, month? })` | Return the period's events in insertion order. |
| `exportCsv({ tenant, meter, month? })` | Return a CSV event trail. |
| `close()` | Close the database connection. |

Errors from validation and quota checks are `MeterError` with a `code`: `INVALID_INPUT`, `INVALID_CLOCK`, `IDEMPOTENCY_CONFLICT`, `LIMIT_EXCEEDED`, or `OVERFLOW`.

### Behavior and boundaries

- Periods are UTC calendar months (`YYYY-MM`). The server clock assigns event time; callers cannot backdate events.
- Idempotency keys are unique within a tenant and meter **across all months**. A retry in a later month returns the original event and does not consume the new month's quota.
- A missing limit means usage is tracked without a quota. Lowering a limit below recorded usage does not delete past events; it blocks further events until the next month or a higher limit is set.
- `BEGIN IMMEDIATE` serializes competing writers to the same SQLite file. SQLite's busy timeout is 5 seconds; callers should retry a busy-database error with backoff.
- This library does not authenticate tenants, bill customers, handle refunds, or sync across machines. Derive `tenant` from trusted server-side auth, not a client-supplied ID. Store the SQLite file on persistent storage, back it up, and keep it private.
- The synchronous SQLite API is suitable for small services and background jobs. It can block a Node event loop under heavy load. For distributed or high-volume systems, use a server database and a corresponding transactional adapter.

## CLI

Run the CLI from a checkout with `node bin/tenant-meter.js`. Set `TENANT_METER_DB` to select a file; otherwise it uses `./tenant-meter.db`.

```sh
node bin/tenant-meter.js limit demo api-calls 1000
node bin/tenant-meter.js record demo api-calls request-1 1
node bin/tenant-meter.js summary demo api-calls
node bin/tenant-meter.js export demo api-calls 2026-10
```

Use your current UTC month for the export command. CSV output contains one row per accepted event. Keep the same stable idempotency key when retrying an operation.

## Development

```sh
node --test
```

Tests cover tenant isolation, quota rejection, retries, month rollover, persistence, CSV export, and invalid input. Contributions and bug reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Security reports should follow [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
