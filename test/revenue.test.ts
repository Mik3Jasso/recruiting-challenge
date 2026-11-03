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

test('summary counts sales only (refund rows are not orders)', () => {
  seed();
  const s = ordersDal.summaryByMerchant('m_rev');
  assert.equal(s.total_orders, 2);
  assert.equal(s.unique_customers, 1);
  assert.equal(Math.round(s.avg_order_value), 7500);
});

test('top customers: net spend, sales-only order_count', () => {
  seed();
  const rows = ordersDal.topCustomersByMerchant('m_rev', 10);
  const a = rows.find((r) => r.customer_email === 'a@x.com')!;
  const b = rows.find((r) => r.customer_email === 'b@x.com')!;
  assert.deepEqual([a.order_count, a.total_spent], [2, 15000]);
  assert.deepEqual([b.order_count, b.total_spent], [0, -3000]);
  assert.equal(rows.reduce((s, r) => s + r.total_spent, 0), 12000);
});
