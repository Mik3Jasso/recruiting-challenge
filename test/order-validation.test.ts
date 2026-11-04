// Set DB_PATH before importing the db module — the connection is created on import.
if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initSchema, db } from '../src/db.js';
import { ordersRouter } from '../src/routes/orders.js';
import { validateNewOrder } from '../src/validation/orders.js';

const ok = { customer_email: 'a@b.com', total_amount: 1500 };

test('validator: accepts a valid sale and defaults type to sale', () => {
  const r = validateNewOrder(ok);
  assert.deepEqual(r, { ok: true, value: { customer_email: 'a@b.com', total_amount: 1500, type: 'sale' } });
});

test('validator: accepts a refund with a positive amount and trims the email', () => {
  const r = validateNewOrder({ customer_email: '  a@b.com ', total_amount: 1, type: 'refund' });
  assert.deepEqual(r, { ok: true, value: { customer_email: 'a@b.com', total_amount: 1, type: 'refund' } });
});

test('validator: accepts the largest safe integer', () => {
  assert.equal(validateNewOrder({ ...ok, total_amount: Number.MAX_SAFE_INTEGER }).ok, true);
});

test('validator: ignores unknown fields (id, merchant_id, status never pass through)', () => {
  const r = validateNewOrder({ ...ok, id: 'x', merchant_id: 'm_other', status: 'refunded' });
  assert.deepEqual(r, { ok: true, value: { customer_email: 'a@b.com', total_amount: 1500, type: 'sale' } });
});

test('validator: rejects bad total_amount values', () => {
  const bad: unknown[] = [-1, 0, 10.5, '100', null, undefined, Number.MAX_SAFE_INTEGER + 1, 1e21, NaN, Infinity, true, []];
  for (const total_amount of bad) {
    const r = validateNewOrder({ ...ok, total_amount });
    assert.equal(r.ok, false, String(total_amount));
    if (!r.ok) assert.match(r.detail, /total_amount/);
  }
});

test('validator: rejects bad type values', () => {
  for (const type of ['Refund', 'chargeback', '', 1, null, {}]) {
    const r = validateNewOrder({ ...ok, type });
    assert.equal(r.ok, false, String(type));
    if (!r.ok) assert.match(r.detail, /type/);
  }
});

test('validator: rejects missing, empty, blank or non-string customer_email', () => {
  for (const customer_email of [undefined, '', '   ', 5, null]) {
    const r = validateNewOrder({ total_amount: 100, customer_email });
    assert.equal(r.ok, false, String(customer_email));
    if (!r.ok) assert.match(r.detail, /customer_email/);
  }
});

test('validator: rejects non-object bodies', () => {
  for (const body of [undefined, null, 'x', 5, [], [ok]]) {
    assert.equal(validateNewOrder(body).ok, false, JSON.stringify(body));
  }
});

// --- HTTP level: real router, in-memory DB, stub auth ---
let server: Server;
let base: string;

before(async () => {
  initSchema();
  db.prepare(`INSERT OR IGNORE INTO merchants (id, name) VALUES ('m_http', 'Http')`).run();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.merchantId = 'm_http';
    next();
  });
  app.use('/api/orders', ordersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

function post(body: unknown, raw = false) {
  return fetch(`${base}/api/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

function count(): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE merchant_id = 'm_http'`).get() as { n: number }).n;
}

test('POST /api/orders: valid body creates the order with server-controlled fields', async () => {
  const res = await post({ ...ok, id: 'evil', merchant_id: 'm_other', status: 'refunded' });
  assert.equal(res.status, 201);
  const { order } = (await res.json()) as { order: Record<string, unknown> };
  assert.equal(order.total_amount, 1500);
  assert.equal(order.type, 'sale');
  assert.equal(order.merchant_id, 'm_http');
  assert.equal(order.status, 'completed');
  assert.notEqual(order.id, 'evil');
});

test('POST /api/orders: invalid bodies get 400 invalid_body with detail and insert nothing', async () => {
  const before = count();
  const bodies: unknown[] = [
    { ...ok, total_amount: -500 },
    { ...ok, total_amount: 0 },
    { ...ok, total_amount: 12.5 },
    { ...ok, total_amount: '100' },
    { ...ok, type: 'chargeback' },
    { total_amount: 100, customer_email: '' },
    [],
  ];
  for (const b of bodies) {
    const res = await post(b);
    assert.equal(res.status, 400, JSON.stringify(b));
    const j = (await res.json()) as { error: string; detail: string };
    assert.equal(j.error, 'invalid_body');
    assert.equal(typeof j.detail, 'string');
  }
  assert.equal(count(), before);
});
