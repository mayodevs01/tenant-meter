import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeterError, UsageLedger } from '../src/index.js';

const fixed = () => new Date('2026-01-31T23:59:59.000Z');

test('records usage, enforces quotas, and isolates tenants', () => {
  const ledger = new UsageLedger({ clock: fixed });
  ledger.setLimit({ tenant: 'acme', meter: 'api-calls', monthlyLimit: 3 });
  assert.equal(ledger.record({ tenant: 'acme', meter: 'api-calls', idempotencyKey: 'req-1', quantity: 2 }).duplicate, false);
  ledger.record({ tenant: 'other', meter: 'api-calls', idempotencyKey: 'req-1', quantity: 100 });
  assert.deepEqual(ledger.summary({ tenant: 'acme', meter: 'api-calls' }), {
    tenant: 'acme', meter: 'api-calls', month: '2026-01', used: 2, eventCount: 1, monthlyLimit: 3, remaining: 1
  });
  assert.throws(() => ledger.record({ tenant: 'acme', meter: 'api-calls', idempotencyKey: 'req-2', quantity: 2 }),
    error => error instanceof MeterError && error.code === 'LIMIT_EXCEEDED');
  assert.equal(ledger.summary({ tenant: 'acme', meter: 'api-calls' }).used, 2);
  ledger.close();
});

test('identical retries return the original event even after the quota is full', () => {
  const ledger = new UsageLedger({ clock: fixed });
  ledger.setLimit({ tenant: 'acme', meter: 'seats', monthlyLimit: 2 });
  const first = ledger.record({ tenant: 'acme', meter: 'seats', idempotencyKey: 'purchase-1', quantity: 2 });
  const retry = ledger.record({ tenant: 'acme', meter: 'seats', idempotencyKey: 'purchase-1', quantity: 2 });
  assert.equal(retry.id, first.id);
  assert.equal(retry.duplicate, true);
  assert.equal(ledger.summary({ tenant: 'acme', meter: 'seats' }).eventCount, 1);
  assert.throws(() => ledger.record({ tenant: 'acme', meter: 'seats', idempotencyKey: 'purchase-1', quantity: 1 }),
    error => error.code === 'IDEMPOTENCY_CONFLICT');
  ledger.close();
});

test('UTC month rollover starts a fresh quota while retaining history', () => {
  let time = '2026-01-31T23:59:59.000Z';
  const ledger = new UsageLedger({ clock: () => new Date(time) });
  ledger.setLimit({ tenant: 'acme', meter: 'images', monthlyLimit: 1 });
  ledger.record({ tenant: 'acme', meter: 'images', idempotencyKey: 'jan' });
  time = '2026-02-01T00:00:00.000Z';
  ledger.record({ tenant: 'acme', meter: 'images', idempotencyKey: 'feb' });
  assert.equal(ledger.summary({ tenant: 'acme', meter: 'images', month: '2026-01' }).used, 1);
  assert.equal(ledger.summary({ tenant: 'acme', meter: 'images' }).used, 1);
  const retry = ledger.record({ tenant: 'acme', meter: 'images', idempotencyKey: 'jan' });
  assert.equal(retry.month, '2026-01');
  assert.equal(retry.duplicate, true);
  ledger.close();
});

test('persists across connections and exports ordered CSV', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-meter-'));
  const path = join(dir, 'meter.db');
  try {
    const first = new UsageLedger({ path, clock: fixed });
    first.record({ tenant: 'acme', meter: 'emails', idempotencyKey: 'send-1', quantity: 3 });
    first.close();
    const second = new UsageLedger({ path, clock: fixed });
    assert.equal(second.summary({ tenant: 'acme', meter: 'emails' }).used, 3);
    assert.match(second.exportCsv({ tenant: 'acme', meter: 'emails', month: '2026-01' }),
      /^id,tenant,meter,idempotency_key,quantity,occurred_at,month\n"1","acme","emails","send-1","3","2026-01-31T23:59:59.000Z","2026-01"\n$/);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two connections to one file observe the same quota', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-meter-'));
  const path = join(dir, 'meter.db');
  try {
    const one = new UsageLedger({ path, clock: fixed });
    const two = new UsageLedger({ path, clock: fixed });
    one.setLimit({ tenant: 'acme', meter: 'tasks', monthlyLimit: 1 });
    one.record({ tenant: 'acme', meter: 'tasks', idempotencyKey: 'a' });
    assert.throws(() => two.record({ tenant: 'acme', meter: 'tasks', idempotencyKey: 'b' }),
      error => error.code === 'LIMIT_EXCEEDED');
    assert.equal(two.summary({ tenant: 'acme', meter: 'tasks' }).used, 1);
    two.close();
    one.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects unsafe values and malformed periods', () => {
  const ledger = new UsageLedger({ clock: fixed });
  assert.throws(() => ledger.record({ tenant: '=SUM(1)', meter: 'calls', idempotencyKey: 'x' }),
    error => error.code === 'INVALID_INPUT');
  assert.throws(() => ledger.record({ tenant: 'acme', meter: 'calls', idempotencyKey: 'x', quantity: 0 }),
    error => error.code === 'INVALID_INPUT');
  assert.throws(() => ledger.summary({ tenant: 'acme', meter: 'calls', month: '2026-13' }),
    error => error.code === 'INVALID_INPUT');
  ledger.close();
});
