// Set DB_PATH before importing the db module — the connection is created on import.
if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { initSchema, db } from '../src/db.js';
import { ordersDal, PAGE_SIZE } from '../src/dal/orders-dal.js';
import { ordersRouter } from '../src/routes/orders.js';
import { authMiddleware } from '../src/auth.js';

interface Sample {
  id: string;
  merchant_id: string;
  customer_email: string;
  total_amount: number;
  type: 'sale' | 'refund';
  status: string;
  created_at: string;
}

const sample: Sample[] = JSON.parse(
  readFileSync(new URL('../data/sample-orders.json', import.meta.url), 'utf8'),
) as Sample[];

let server: Server;
let base: string;
let n = 0;

function add(merchant: string, email: string, amount: number, type: 'sale' | 'refund', createdAt: string): string {
  const id = `s-${++n}`;
  db.prepare(
    `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'completed', ?)`,
  ).run(id, merchant, email, amount, type, createdAt);
  return id;
}

interface SearchBody {
  orders: Sample[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

async function get(path: string, merchant: string | null = 'm_acme'): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = merchant ? { 'X-Merchant-Id': merchant } : {};
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

async function search(qs: string, merchant = 'm_acme'): Promise<SearchBody> {
  const r = await get(`/api/orders/search${qs}`, merchant);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body as SearchBody;
}

before(async () => {
  initSchema();
  db.prepare(`INSERT OR IGNORE INTO merchants (id, name) VALUES ('m_acme', 'Acme'), ('m_bistro', 'Bistro'), ('m_t', 'T'), ('m_u', 'U'), ('m_p', 'P')`).run();

  // --- small hand-built fixture for merchant m_t (tenancy rival: m_u) ---
  add('m_t', 'Ana@Example.com', 1250, 'sale', '2026-03-05T00:00:00.000Z'); // day start
  add('m_t', 'bob@example.com', 1250, 'refund', '2026-03-05T23:59:59.999Z'); // day end
  add('m_t', 'carl@other.org', 1200, 'sale', '2026-03-06T00:00:00.000Z'); // next day start
  add('m_t', 'dan@example.com', 1999, 'sale', '2026-03-04T23:59:59.999Z'); // previous day end
  add('m_t', 'john_doe@example.com', 500, 'sale', '2026-03-01T10:00:00.000Z');
  add('m_t', 'johnXdoe@example.com', 500, 'sale', '2026-03-01T11:00:00.000Z');
  add('m_t', '50%_off@shop.example', 700, 'sale', '2026-03-02T10:00:00.000Z');
  add('m_t', '50abc_off@shop.example', 700, 'sale', '2026-03-02T11:00:00.000Z');
  add('m_t', 'back\\slash@example.com', 100, 'sale', '2026-03-02T12:00:00.000Z');
  add('m_t', 'backXslash@example.com', 100, 'sale', '2026-03-02T13:00:00.000Z');
  // same instant, tiebreaker check
  add('m_t', 'tie1@x.com', 300, 'sale', '2026-03-07T00:00:00.000Z');
  add('m_t', 'tie2@x.com', 300, 'sale', '2026-03-07T00:00:00.000Z');
  // row written the way the DB default does (space-separated, no ms): must land on its UTC day only
  add('m_t', 'dbdefault@x.com', 4242, 'sale', '2026-03-10 10:00:00');
  add('m_t', 'dbdefault2@x.com', 4242, 'sale', '2026-03-09 23:59:59');
  // other tenant with matching data
  add('m_u', 'ana@example.com', 1250, 'sale', '2026-03-05T12:00:00.000Z');
  add('m_u', 'john_doe@example.com', 500, 'sale', '2026-03-01T10:00:00.000Z');

  // --- exactly 31 matching rows for m_p ---
  for (let i = 0; i < 31; i++) {
    add('m_p', `p${i}@x.com`, 5000, 'sale', `2026-04-01T${String(i % 24).padStart(2, '0')}:${String(i).padStart(2, '0')}:00.000Z`);
  }

  // --- the 2,000-record sample dataset (ids are prefixed by themselves; unique 'so-NNNN') ---
  const ins = db.prepare(
    `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status, created_at)
     VALUES (@id, @merchant_id, @customer_email, @total_amount, @type, @status, @created_at)`,
  );
  db.transaction(() => {
    for (const o of sample) ins.run(o);
  })();

  const app = express();
  app.use(express.json());
  app.use('/api/orders', authMiddleware, ordersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

// ---------------------------------------------------------------- validation via HTTP

test('GET /api/orders/search requires auth', async () => {
  const r = await get('/api/orders/search', null);
  assert.equal(r.status, 401);
});

test('GET /api/orders/search is not shadowed by /:id', async () => {
  const r = await get('/api/orders/search', 'm_t');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.orders));
});

test('search: invalid params return 400 invalid_param with detail', async () => {
  for (const qs of ['?date=2026-02-30', '?type=gift', '?amount=12.505', '?amount=0', '?amount=-1', '?amount=abc', '?page=0', '?page=x', '?page=1.5']) {
    const r = await get(`/api/orders/search${qs}`, 'm_t');
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error, 'invalid_param', qs);
    assert.equal(typeof r.body.detail, 'string', qs);
  }
});

// ---------------------------------------------------------------- filters alone

test('search: no filters returns all merchant rows newest first with envelope', async () => {
  const b = await search('', 'm_t');
  assert.equal(b.page, 1);
  assert.equal(b.page_size, 30);
  assert.equal(PAGE_SIZE, 30);
  assert.equal(b.total, 14);
  assert.equal(b.total_pages, 1);
  assert.equal(b.orders.length, 14);
  assert.ok(b.orders.every((o) => o.merchant_id === 'm_t'));
  const emails = b.orders.map((o) => o.customer_email);
  assert.equal(emails[0], 'dbdefault@x.com'); // 2026-03-10 is the newest
  assert.equal(emails[1], 'dbdefault2@x.com');
  assert.deepEqual(emails.slice(2, 4), ['tie2@x.com', 'tie1@x.com']); // same created_at: id DESC
});

test('search: date filters a single UTC day, inclusive start / exclusive end', async () => {
  const b = await search('?date=2026-03-05', 'm_t');
  assert.deepEqual(b.orders.map((o) => o.customer_email).sort(), ['Ana@Example.com', 'bob@example.com']);
  assert.equal(b.total, 2);
});

test('search: date handles DB-default timestamp format on the right day', async () => {
  const d10 = await search('?date=2026-03-10', 'm_t');
  assert.deepEqual(d10.orders.map((o) => o.customer_email), ['dbdefault@x.com']);
  const d09 = await search('?date=2026-03-09', 'm_t');
  assert.deepEqual(d09.orders.map((o) => o.customer_email), ['dbdefault2@x.com']);
});

test('search: future date is accepted and empty', async () => {
  const b = await search('?date=2999-12-31', 'm_t');
  assert.deepEqual(b, { orders: [], page: 1, page_size: 30, total: 0, total_pages: 0 });
});

test('search: email contains, case-insensitive', async () => {
  const b = await search('?email=ANA@EXAMPLE', 'm_t');
  assert.deepEqual(b.orders.map((o) => o.customer_email), ['Ana@Example.com']);
  const c = await search('?email=%20other.ORG%20', 'm_t'); // trimmed
  assert.deepEqual(c.orders.map((o) => o.customer_email), ['carl@other.org']);
});

test('search: empty email means no filter', async () => {
  assert.equal((await search('?email=', 'm_t')).total, 14);
  assert.equal((await search('?email=%20%20', 'm_t')).total, 14);
});

test('search: LIKE wildcards in email are literal', async () => {
  const under = await search('?email=john_doe', 'm_t');
  assert.deepEqual(under.orders.map((o) => o.customer_email), ['john_doe@example.com']);
  const pct = await search(`?email=${encodeURIComponent('50%_')}`, 'm_t');
  assert.deepEqual(pct.orders.map((o) => o.customer_email), ['50%_off@shop.example']);
  const pctOnly = await search(`?email=${encodeURIComponent('%')}`, 'm_t');
  assert.deepEqual(pctOnly.orders.map((o) => o.customer_email), ['50%_off@shop.example']);
  const bs = await search(`?email=${encodeURIComponent('back\\slash')}`, 'm_t');
  assert.deepEqual(bs.orders.map((o) => o.customer_email), ['back\\slash@example.com']);
});

test('search: type filter', async () => {
  const refunds = await search('?type=refund', 'm_t');
  assert.deepEqual(refunds.orders.map((o) => o.customer_email), ['bob@example.com']);
  const sales = await search('?type=sale', 'm_t');
  assert.equal(sales.total, 13);
  assert.equal((await search('?type=', 'm_t')).total, 14);
});

test('search: amount is exact match in dollars (12, 12.5, 12.50)', async () => {
  const a = await search('?amount=12.50', 'm_t');
  assert.deepEqual(a.orders.map((o) => o.customer_email).sort(), ['Ana@Example.com', 'bob@example.com']);
  const b = await search('?amount=12.5', 'm_t');
  assert.equal(b.total, 2);
  const c = await search('?amount=12', 'm_t');
  assert.deepEqual(c.orders.map((o) => o.customer_email), ['carl@other.org']);
  assert.equal((await search('?amount=12.51', 'm_t')).total, 0);
  assert.equal((await search('?amount=11', 'm_t')).total, 0);
});

// ---------------------------------------------------------------- combinations

test('search: filters combine with AND', async () => {
  const a = await search('?date=2026-03-05&type=refund&amount=12.50', 'm_t');
  assert.deepEqual(a.orders.map((o) => o.customer_email), ['bob@example.com']);
  const b = await search('?date=2026-03-05&email=ana&type=sale', 'm_t');
  assert.deepEqual(b.orders.map((o) => o.customer_email), ['Ana@Example.com']);
  assert.equal((await search('?date=2026-03-05&email=ana&type=refund', 'm_t')).total, 0);
  assert.equal((await search('?email=example&amount=19.99&type=sale', 'm_t')).total, 1);
});

// ---------------------------------------------------------------- tenancy

test('search: never returns another merchant\'s rows', async () => {
  const b = await search('?email=john_doe', 'm_t');
  assert.equal(b.total, 1);
  assert.equal(b.orders[0]!.merchant_id, 'm_t');
  const u = await search('?email=john_doe', 'm_u');
  assert.equal(u.total, 1);
  assert.equal(u.orders[0]!.merchant_id, 'm_u');
  assert.equal((await search('', 'm_nobody')).total, 0);
});

// ---------------------------------------------------------------- pagination

test('search: 31 matches => 30 on page 1, 1 on page 2, total 31, total_pages 2', async () => {
  const p1 = await search('', 'm_p');
  assert.equal(p1.orders.length, 30);
  assert.equal(p1.total, 31);
  assert.equal(p1.total_pages, 2);
  assert.equal(p1.page, 1);
  const p2 = await search('?page=2', 'm_p');
  assert.equal(p2.orders.length, 1);
  assert.equal(p2.total, 31);
  assert.equal(p2.total_pages, 2);
  assert.equal(p2.page, 2);
  const ids = new Set([...p1.orders, ...p2.orders].map((o) => o.id));
  assert.equal(ids.size, 31);
});

test('search: exactly 30 matches is one page; page beyond last is empty with real total', async () => {
  const f = await search('?date=2026-04-01', 'm_p');
  assert.equal(f.total, 31);
  const beyond = await search('?page=3', 'm_p');
  assert.deepEqual(beyond.orders, []);
  assert.equal(beyond.total, 31);
  assert.equal(beyond.total_pages, 2);
  assert.equal(beyond.page, 3);
  const huge = await search('?page=1000000', 'm_p');
  assert.deepEqual(huge.orders, []);
  assert.equal(huge.total, 31);
});

test('search: filters and page combine (total reflects the filter, not the page)', async () => {
  const b = await search('?date=2026-04-01&page=2', 'm_p');
  assert.equal(b.total, 31);
  assert.equal(b.orders.length, 1);
});

// ---------------------------------------------------------------- 2,000-record dataset

const forMerchant = (m: string) => sample.filter((o) => o.merchant_id === m);
const newestFirst = (rows: Sample[]) =>
  [...rows].sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? 1 : -1) : a.created_at < b.created_at ? 1 : -1));

test('sample data: exactly 2000 records, both merchants, none in the future, refunds 10-15%', () => {
  assert.equal(sample.length, 2000);
  assert.equal(new Set(sample.map((o) => o.id)).size, 2000);
  assert.deepEqual([...new Set(sample.map((o) => o.merchant_id))].sort(), ['m_acme', 'm_bistro']);
  const now = new Date().toISOString();
  assert.ok(sample.every((o) => o.created_at <= now));
  const refundRate = sample.filter((o) => o.type === 'refund').length / sample.length;
  assert.ok(refundRate >= 0.1 && refundRate <= 0.15, String(refundRate));
  assert.ok(sample.every((o) => Number.isInteger(o.total_amount) && o.total_amount > 0));
  assert.ok(sample.filter((o) => o.total_amount === 1250).length >= 5);
});

test('sample data: per-merchant totals add up to 2000 and match the API', async () => {
  const acme = await search('', 'm_acme');
  const bistro = await search('', 'm_bistro');
  assert.equal(acme.total, forMerchant('m_acme').length);
  assert.equal(bistro.total, forMerchant('m_bistro').length);
  assert.equal(acme.total + bistro.total, 2000);
  assert.equal(acme.total_pages, Math.ceil(acme.total / 30));
  assert.equal(bistro.total_pages, Math.ceil(bistro.total / 30));
});

test('sample data: walking all pages yields every row exactly once, newest first', async () => {
  for (const m of ['m_acme', 'm_bistro']) {
    const expected = newestFirst(forMerchant(m));
    const first = await search('', m);
    const seen: string[] = [];
    for (let p = 1; p <= first.total_pages; p++) {
      const b = await search(`?page=${p}`, m);
      assert.ok(b.orders.length <= 30);
      if (p < first.total_pages) assert.equal(b.orders.length, 30);
      seen.push(...b.orders.map((o) => o.id));
    }
    assert.equal(seen.length, expected.length);
    assert.equal(new Set(seen).size, expected.length);
    assert.deepEqual(seen, expected.map((o) => o.id));
  }
});

test('sample data: each filter matches an independent in-memory oracle', async () => {
  const acme = forMerchant('m_acme');
  const check = async (qs: string, pred: (o: Sample) => boolean) => {
    const want = newestFirst(acme.filter(pred));
    const got = await search(qs, 'm_acme');
    assert.equal(got.total, want.length, qs);
    assert.deepEqual(got.orders.map((o) => o.id), want.slice(0, 30).map((o) => o.id), qs);
  };
  await check('?type=refund', (o) => o.type === 'refund');
  await check('?amount=12.50', (o) => o.total_amount === 1250);
  await check('?email=EXAMPLE.com', (o) => o.customer_email.toLowerCase().includes('example.com'));
  await check(`?email=${encodeURIComponent('_')}`, (o) => o.customer_email.includes('_'));
  await check(`?email=${encodeURIComponent('%')}`, (o) => o.customer_email.includes('%'));
  await check('?type=sale&amount=12.5&email=a', (o) => o.type === 'sale' && o.total_amount === 1250 && o.customer_email.toLowerCase().includes('a'));
});

test('sample data: a merchant+day with 31+ orders pages correctly (both UTC boundaries included)', async () => {
  const day = '2026-09-15';
  const rows = newestFirst(forMerchant('m_acme').filter((o) => o.created_at.startsWith(day)));
  assert.ok(rows.length >= 31);
  assert.ok(rows.some((o) => o.created_at === `${day}T00:00:00.000Z`));
  assert.ok(rows.some((o) => o.created_at === `${day}T23:59:59.999Z`));
  const p1 = await search(`?date=${day}`);
  const p2 = await search(`?date=${day}&page=2`);
  assert.equal(p1.total, rows.length);
  assert.equal(p1.total_pages, Math.ceil(rows.length / 30));
  assert.deepEqual([...p1.orders, ...p2.orders].map((o) => o.id), rows.map((o) => o.id));
  // neighbouring days do not leak in
  assert.ok([...p1.orders, ...p2.orders].every((o) => o.created_at.startsWith(day)));
});

// ---------------------------------------------------------------- DAL

test('ordersDal.search: returns rows and the real total', () => {
  const r = ordersDal.search('m_p', {}, 1, 30);
  assert.equal(r.orders.length, 30);
  assert.equal(r.total, 31);
  assert.equal(ordersDal.search('m_p', {}, 2, 30).orders.length, 1);
});

test('ordersDal.search: an email containing SQL is treated as data', () => {
  const r = ordersDal.search('m_t', { email: `x' OR '1'='1` }, 1, 30);
  assert.equal(r.total, 0);
});

// ---------------------------------------------------------------- GET /api/orders paging

test('GET /api/orders: paged envelope, 30 per page, newest first, real total', async () => {
  const r = await get('/api/orders', 'm_p');
  assert.equal(r.status, 200);
  assert.equal(r.body.orders.length, 30);
  assert.equal(r.body.total, 31);
  assert.equal(r.body.total_pages, 2);
  assert.equal(r.body.page, 1);
  assert.equal(r.body.page_size, 30);
  const r2 = await get('/api/orders?page=2', 'm_p');
  assert.equal(r2.body.orders.length, 1);
  assert.equal(r2.body.total, 31);
});

test('GET /api/orders: limit is ignored (fixed page size)', async () => {
  const r = await get('/api/orders?limit=5', 'm_p');
  assert.equal(r.body.orders.length, 30);
});

test('GET /api/orders: invalid page => 400', async () => {
  const r = await get('/api/orders?page=0', 'm_p');
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_param');
});

test('GET /api/orders: from/to still filter (when both are given) and tenancy holds', async () => {
  const r = await get('/api/orders?from=2026-03-05T00:00:00.000Z&to=2026-03-06T00:00:00.000Z', 'm_t');
  assert.equal(r.body.total, 2);
  const u = await get('/api/orders?from=2026-03-05T00:00:00.000Z&to=2026-03-06T00:00:00.000Z', 'm_u');
  assert.equal(u.body.total, 1);
  assert.equal(u.body.orders[0].merchant_id, 'm_u');
});

test('GET /api/orders/:id still works', async () => {
  const r = await get('/api/orders/so-0001', 'm_acme');
  assert.equal(r.status, 200);
  assert.equal(r.body.order.id, 'so-0001');
});
