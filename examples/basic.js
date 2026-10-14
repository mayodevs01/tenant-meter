import { UsageLedger } from '../src/index.js';

const ledger = new UsageLedger({ path: './example.db' });
try {
  ledger.setLimit({ tenant: 'demo-team', meter: 'api-calls', monthlyLimit: 1_000 });
  const event = ledger.record({
    tenant: 'demo-team',
    meter: 'api-calls',
    idempotencyKey: 'request-0001',
    quantity: 1
  });
  console.log('Event:', event);
  console.log('Current month:', ledger.summary({ tenant: 'demo-team', meter: 'api-calls' }));
} finally {
  ledger.close();
}
