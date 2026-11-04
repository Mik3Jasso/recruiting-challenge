// Set DB_PATH before importing the db module — the connection is created on import.
if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initSchema, db } from '../src/db.js';
import { ordersDal } from '../src/dal/orders-dal.js';
import { metricsRouter } from '../src/routes/metrics.js';

let n = 0;
function add(merchant: string, email: string, amount: number, type: 'sale' | 'refund'): void {
  db.prepare(
    `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'completed', '2026-10-05T10:00:00.000Z')`,
  ).run(`met-${++n}`, merchant, email, amount, type);
}

let server: Server;
let base: string;

before(async () => {
  initSchema();
  db.prepare(`INSERT OR IGNORE INTO merchants (id, name) VALUES ('m_a', 'A'), ('m_b', 'B'), ('m_empty', 'E')`).run();
  add('m_a', 'x@x.com', 1000, 'sale');
  add('m_a', 'x@x.com', 3000, 'sale');
  add('m_a', 'y@x.com', 2000, 'sale');
  add('m_a', 'z@x.com', 500, 'refund');
  add('m_b', 'w@x.com', 777, 'sale');

  const app = express();
  app.use((req, _res, next) => {
    req.merchantId = req.header('X-Merchant-Id');
    next();
  });
  app.use('/api/metrics', metricsRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

async function get(path: string, merchant: string): Promise<any> {
  const res = await fetch(base + path, { headers: { 'X-Merchant-Id': merchant } });
  assert.equal(res.status, 200);
  return res.json();
}

// Characterization: pins current behavior (all rows counted/averaged, gross SUM in top-customers).
test('GET /summary: current numbers for a merchant with sales and a refund', async () => {
  assert.deepEqual(await get('/api/metrics/summary', 'm_a'), {
    merchant_id: 'm_a',
    total_orders: 4,
    unique_customers: 3,
    avg_order_value_cents: 1625,
  });
});

test('GET /summary: merchants are isolated', async () => {
  assert.deepEqual(await get('/api/metrics/summary', 'm_b'), {
    merchant_id: 'm_b',
    total_orders: 1,
    unique_customers: 1,
    avg_order_value_cents: 777,
  });
});

test('GET /summary: empty merchant is all zeros', async () => {
  assert.deepEqual(await get('/api/metrics/summary', 'm_empty'), {
    merchant_id: 'm_empty',
    total_orders: 0,
    unique_customers: 0,
    avg_order_value_cents: 0,
  });
});

test('GET /top-customers: ordered by total_spent desc', async () => {
  assert.deepEqual(await get('/api/metrics/top-customers', 'm_a'), {
    customers: [
      { customer_email: 'x@x.com', order_count: 2, total_spent: 4000 },
      { customer_email: 'y@x.com', order_count: 1, total_spent: 2000 },
      { customer_email: 'z@x.com', order_count: 1, total_spent: 500 },
    ],
  });
});

test('GET /top-customers: limit is honored; other merchants and empty merchant', async () => {
  assert.deepEqual((await get('/api/metrics/top-customers?limit=1', 'm_a')).customers.length, 1);
  assert.deepEqual(await get('/api/metrics/top-customers', 'm_b'), {
    customers: [{ customer_email: 'w@x.com', order_count: 1, total_spent: 777 }],
  });
  assert.deepEqual(await get('/api/metrics/top-customers', 'm_empty'), { customers: [] });
});

test('DAL summaryByMerchant: raw summary values', () => {
  const s = ordersDal.summaryByMerchant('m_a');
  assert.equal(s.total_orders, 4);
  assert.equal(s.unique_customers, 3);
  assert.equal(s.avg_order_value_cents, 1625);
  assert.deepEqual(ordersDal.summaryByMerchant('m_empty'), {
    total_orders: 0,
    unique_customers: 0,
    avg_order_value_cents: 0,
  });
});

test('DAL topCustomersByMerchant: ordering and limit', () => {
  const rows = ordersDal.topCustomersByMerchant('m_a', 2);
  assert.deepEqual(rows.map((r) => r.customer_email), ['x@x.com', 'y@x.com']);
  assert.equal(rows[0]!.total_spent, 4000);
});
