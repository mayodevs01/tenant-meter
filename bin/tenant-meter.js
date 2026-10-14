#!/usr/bin/env node
import { UsageLedger, MeterError } from '../src/index.js';

const [command, tenant, meter, ...args] = process.argv.slice(2);
const path = process.env.TENANT_METER_DB ?? './tenant-meter.db';

function usage() {
  console.error(`Usage:
  tenant-meter limit TENANT METER MONTHLY_LIMIT
  tenant-meter record TENANT METER IDEMPOTENCY_KEY QUANTITY
  tenant-meter summary TENANT METER [YYYY-MM]
  tenant-meter export TENANT METER YYYY-MM

Set TENANT_METER_DB to choose a SQLite file.`);
  process.exitCode = 2;
}

if (!['limit', 'record', 'summary', 'export'].includes(command) || !tenant || !meter) {
  usage();
} else {
  const ledger = new UsageLedger({ path });
  try {
    let result;
    if (command === 'limit' && args.length === 1) {
      result = ledger.setLimit({ tenant, meter, monthlyLimit: Number(args[0]) });
    } else if (command === 'record' && args.length === 2) {
      result = ledger.record({ tenant, meter, idempotencyKey: args[0], quantity: Number(args[1]) });
    } else if (command === 'summary' && args.length <= 1) {
      result = ledger.summary({ tenant, meter, ...(args[0] ? { month: args[0] } : {}) });
    } else if (command === 'export' && args.length === 1) {
      result = ledger.exportCsv({ tenant, meter, month: args[0] });
    } else {
      usage();
    }
    if (result !== undefined) process.stdout.write(command === 'export' ? result : `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof MeterError ? `${error.code}: ${error.message}` : error);
    process.exitCode = 1;
  } finally {
    ledger.close();
  }
}
