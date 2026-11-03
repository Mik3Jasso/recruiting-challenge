if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initSchema, db } from '../src/db.js';
import { ordersDal } from '../src/dal/orders-dal.js';

function seed(): void {
  initSchema();
  db.prepare(`DELETE FROM orders`).run();
  db.prepare(`INSERT OR IGNORE INTO merchants (id, name) VALUES ('m_rev', 'Rev'), ('m_other', 'Other')`).run();
  const ins = db.prepare(
    `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status, created_at) VALUES (?,?,?,?,?,?,?)`,
  );
  ins.run('r1', 'm_rev', 'a@x.com', 10000, 'sale', 'completed', '2026-10-01T10:00:00.000Z');
  ins.run('r2', 'm_rev', 'a@x.com', 5000, 'sale', 'completed', '2026-10-02T10:00:00.000Z');
  ins.run('r3', 'm_rev', 'b@x.com', 3000, 'refund', 'completed', '2026-10-03T10:00:00.000Z');
  ins.run('r4', 'm_other', 'z@x.com', 99999, 'sale', 'completed', '2026-10-03T10:00:00.000Z');
}

test('revenue is net: refunds are subtracted, not added', () => {
  seed();
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', '2026-10-01', '2026-11-01'), 10000 + 5000 - 3000);
});
