import { DatabaseSync } from 'node:sqlite';

const slug = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const monthPattern = /^\d{4}-(0[1-9]|1[0-2])$/;

export class MeterError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MeterError';
    this.code = code;
  }
}

function identifier(value, name) {
  if (typeof value !== 'string' || !slug.test(value)) {
    throw new MeterError('INVALID_INPUT', `${name} must be 1-128 letters, digits, dots, underscores, colons or hyphens and start with a letter or digit`);
  }
  return value;
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new MeterError('INVALID_INPUT', `${name} must be a safe integer >= ${min}`);
  }
  return value;
}

function monthValue(value) {
  if (typeof value !== 'string' || !monthPattern.test(value)) {
    throw new MeterError('INVALID_INPUT', 'month must be YYYY-MM');
  }
  return value;
}

function utcNow(clock) {
  const date = clock();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new MeterError('INVALID_CLOCK', 'clock must return a valid Date');
  }
  return date.toISOString();
}

function csvCell(value) {
  const text = String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

/** A durable, per-tenant event ledger with UTC calendar-month quotas. */
export class UsageLedger {
  #db;
  #clock;

  constructor({ path = ':memory:', clock = () => new Date() } = {}) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new MeterError('INVALID_INPUT', 'path must be a non-empty string');
    }
    if (typeof clock !== 'function') {
      throw new MeterError('INVALID_INPUT', 'clock must be a function');
    }
    this.#clock = clock;
    this.#db = new DatabaseSync(path);
    this.#db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS limits (
        tenant TEXT NOT NULL,
        meter TEXT NOT NULL,
        monthly_limit INTEGER NOT NULL CHECK (monthly_limit >= 0),
        PRIMARY KEY (tenant, meter)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        tenant TEXT NOT NULL,
        meter TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        occurred_at TEXT NOT NULL,
        month TEXT NOT NULL,
        UNIQUE (tenant, meter, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS events_period ON events (tenant, meter, month, id);
    `);
  }

  close() { this.#db.close(); }

  setLimit({ tenant, meter, monthlyLimit }) {
    identifier(tenant, 'tenant');
    identifier(meter, 'meter');
    integer(monthlyLimit, 'monthlyLimit');
    this.#db.prepare(`
      INSERT INTO limits (tenant, meter, monthly_limit) VALUES (?, ?, ?)
      ON CONFLICT (tenant, meter) DO UPDATE SET monthly_limit = excluded.monthly_limit
    `).run(tenant, meter, monthlyLimit);
    return this.summary({ tenant, meter });
  }

  record({ tenant, meter, idempotencyKey, quantity = 1 }) {
    identifier(tenant, 'tenant');
    identifier(meter, 'meter');
    identifier(idempotencyKey, 'idempotencyKey');
    integer(quantity, 'quantity', 1);
    const occurredAt = utcNow(this.#clock);
    const month = occurredAt.slice(0, 7);

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.#db.prepare(`
        SELECT id, quantity, occurred_at, month FROM events
        WHERE tenant = ? AND meter = ? AND idempotency_key = ?
      `).get(tenant, meter, idempotencyKey);
      if (prior) {
        if (prior.quantity !== quantity) {
          throw new MeterError('IDEMPOTENCY_CONFLICT', 'key already exists with a different quantity');
        }
        this.#db.exec('COMMIT');
        return { id: prior.id, tenant, meter, idempotencyKey, quantity, occurredAt: prior.occurred_at, month: prior.month, duplicate: true };
      }

      const { used } = this.#db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS used FROM events
        WHERE tenant = ? AND meter = ? AND month = ?
      `).get(tenant, meter, month);
      const limit = this.#db.prepare(`SELECT monthly_limit FROM limits WHERE tenant = ? AND meter = ?`).get(tenant, meter);
      if (!Number.isSafeInteger(used) || !Number.isSafeInteger(used + quantity)) {
        throw new MeterError('OVERFLOW', 'usage exceeds JavaScript safe integer range');
      }
      if (limit && used + quantity > limit.monthly_limit) {
        throw new MeterError('LIMIT_EXCEEDED', `monthly limit of ${limit.monthly_limit} exceeded`);
      }
      const result = this.#db.prepare(`
        INSERT INTO events (tenant, meter, idempotency_key, quantity, occurred_at, month)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(tenant, meter, idempotencyKey, quantity, occurredAt, month);
      this.#db.exec('COMMIT');
      return { id: Number(result.lastInsertRowid), tenant, meter, idempotencyKey, quantity, occurredAt, month, duplicate: false };
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  summary({ tenant, meter, month = utcNow(this.#clock).slice(0, 7) }) {
    identifier(tenant, 'tenant');
    identifier(meter, 'meter');
    monthValue(month);
    const { used, event_count: eventCount } = this.#db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS used, COUNT(*) AS event_count FROM events
      WHERE tenant = ? AND meter = ? AND month = ?
    `).get(tenant, meter, month);
    const limit = this.#db.prepare(`SELECT monthly_limit FROM limits WHERE tenant = ? AND meter = ?`).get(tenant, meter);
    return {
      tenant, meter, month, used, eventCount,
      monthlyLimit: limit?.monthly_limit ?? null,
      remaining: limit ? Math.max(0, limit.monthly_limit - used) : null
    };
  }

  listEvents({ tenant, meter, month = utcNow(this.#clock).slice(0, 7) }) {
    identifier(tenant, 'tenant');
    identifier(meter, 'meter');
    monthValue(month);
    return this.#db.prepare(`
      SELECT id, tenant, meter, idempotency_key AS idempotencyKey,
             quantity, occurred_at AS occurredAt, month
      FROM events WHERE tenant = ? AND meter = ? AND month = ? ORDER BY id
    `).all(tenant, meter, month);
  }

  exportCsv({ tenant, meter, month }) {
    const events = this.listEvents({ tenant, meter, month });
    const header = ['id', 'tenant', 'meter', 'idempotency_key', 'quantity', 'occurred_at', 'month'];
    const lines = events.map(event => [event.id, event.tenant, event.meter, event.idempotencyKey, event.quantity, event.occurredAt, event.month]
      .map(csvCell).join(','));
    return [header.join(','), ...lines].join('\n') + '\n';
  }
}
