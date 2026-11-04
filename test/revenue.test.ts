// Set DB_PATH before importing the db module — the connection is created on import.
if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { initSchema, db } from '../src/db.js';
import { ordersDal } from '../src/dal/orders-dal.js';

const FROM = '2026-10-01';
const TO = '2026-11-01';

let n = 0;
function add(merchant: string, amount: number, type: 'sale' | 'refund', createdAt: string): void {
  db.prepare(
    `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status, created_at)
     VALUES (?, ?, 'c@x.com', ?, ?, 'completed', ?)`,
  ).run(`rev-${++n}`, merchant, amount, type, createdAt);
}

beforeEach(() => {
  initSchema();
  db.prepare(`DELETE FROM orders`).run();
  db.prepare(`INSERT OR IGNORE INTO merchants (id, name) VALUES ('m_rev', 'Rev'), ('m_other', 'Other')`).run();
});

test('revenue: sales only sums the sales', () => {
  add('m_rev', 10000, 'sale', '2026-10-05T10:00:00.000Z');
  add('m_rev', 5000, 'sale', '2026-10-06T10:00:00.000Z');
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), 15000);
});

test('revenue: refunds are subtracted from sales', () => {
  add('m_rev', 10000, 'sale', '2026-10-05T10:00:00.000Z');
  add('m_rev', 5000, 'sale', '2026-10-06T10:00:00.000Z');
  add('m_rev', 3000, 'refund', '2026-10-07T10:00:00.000Z');
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), 12000);
});

test('revenue: refunds only gives a negative net', () => {
  add('m_rev', 3000, 'refund', '2026-10-07T10:00:00.000Z');
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), -3000);
});

test('revenue: empty range is 0', () => {
  add('m_rev', 10000, 'sale', '2026-09-05T10:00:00.000Z');
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), 0);
});

test('revenue: other merchants are excluded', () => {
  add('m_rev', 10000, 'sale', '2026-10-05T10:00:00.000Z');
  add('m_other', 99999, 'sale', '2026-10-05T10:00:00.000Z');
  add('m_other', 500, 'refund', '2026-10-05T10:00:00.000Z');
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), 10000);
});

test('revenue: from is inclusive, to is exclusive', () => {
  add('m_rev', 1000, 'sale', '2026-10-01T00:00:00.000Z'); // on from: included
  add('m_rev', 2000, 'sale', '2026-10-31T23:59:59.999Z'); // before to: included
  add('m_rev', 4000, 'sale', '2026-11-01T00:00:00.000Z'); // on to: excluded
  add('m_rev', 8000, 'sale', '2026-09-30T23:59:59.999Z'); // before from: excluded
  assert.equal(ordersDal.sumAmountByMerchant('m_rev', FROM, TO), 3000);
});
