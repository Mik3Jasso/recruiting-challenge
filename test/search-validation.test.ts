import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSearchQuery, validatePageQuery, parseDollarsToCents } from '../src/validation/orders.js';

function ok(q: Record<string, unknown>) {
  const r = validateSearchQuery(q);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as Extract<typeof r, { ok: true }>).value;
}
function bad(q: Record<string, unknown>, fragment: string) {
  const r = validateSearchQuery(q);
  assert.equal(r.ok, false, `expected failure for ${JSON.stringify(q)}`);
  assert.match((r as Extract<typeof r, { ok: false }>).detail, new RegExp(fragment, 'i'));
}

test('search validation: empty query gives page 1 and no filters', () => {
  const v = ok({});
  assert.equal(v.page, 1);
  assert.deepEqual(v.filters, {});
});

test('search validation: date accepts a valid day and maps to UTC day bounds', () => {
  const v = ok({ date: '2026-03-05' });
  assert.equal(v.filters.from, '2026-03-05 00:00:00');
  assert.equal(v.filters.to, '2026-03-06 00:00:00');
});

test('search validation: date rolls over month/year/leap day', () => {
  assert.equal(ok({ date: '2025-12-31' }).filters.to, '2026-01-01 00:00:00');
  assert.equal(ok({ date: '2024-02-29' }).filters.to, '2024-03-01 00:00:00');
});

test('search validation: future dates are accepted', () => {
  assert.equal(ok({ date: '2999-01-01' }).filters.from, '2999-01-01 00:00:00');
});

test('search validation: malformed dates rejected', () => {
  for (const d of ['2026-3-5', '2026-02-30', '2025-02-29', '2026-13-01', 'yesterday', '2026-03-05T00:00:00Z', '05/03/2026', ' 2026-03-05x']) {
    bad({ date: d }, 'date');
  }
});

test('search validation: empty date is no filter', () => {
  assert.deepEqual(ok({ date: '' }).filters, {});
});

test('search validation: email is trimmed; empty/blank means no filter', () => {
  assert.equal(ok({ email: '  Ana@Example.com ' }).filters.email, 'Ana@Example.com');
  assert.deepEqual(ok({ email: '' }).filters, {});
  assert.deepEqual(ok({ email: '   ' }).filters, {});
});

test('search validation: type must be sale or refund', () => {
  assert.equal(ok({ type: 'sale' }).filters.type, 'sale');
  assert.equal(ok({ type: 'refund' }).filters.type, 'refund');
  assert.deepEqual(ok({ type: '' }).filters, {});
  for (const t of ['Sale', 'REFUND', 'other', 'sale ', '1']) bad({ type: t }, 'type');
});

test('search validation: amount dollars convert to exact cents', () => {
  assert.equal(ok({ amount: '12.50' }).filters.amountCents, 1250);
  assert.equal(ok({ amount: '12.5' }).filters.amountCents, 1250);
  assert.equal(ok({ amount: '12' }).filters.amountCents, 1200);
  assert.equal(ok({ amount: ' 0.07 ' }).filters.amountCents, 7);
  assert.equal(ok({ amount: '0.1' }).filters.amountCents, 10);
  assert.equal(ok({ amount: '19.99' }).filters.amountCents, 1999);
  assert.equal(ok({ amount: '1.15' }).filters.amountCents, 115); // 1.15*100 === 114.99999999999999 in floating point
  assert.deepEqual(ok({ amount: '' }).filters, {});
});

test('search validation: bad amounts rejected', () => {
  for (const a of ['12.505', '12.500', '-5', '-0.01', '0', '0.00', 'abc', '1e3', '12.', '.5', '1,5', '+5', '1 2', 'NaN', 'Infinity', '9'.repeat(30)]) {
    bad({ amount: a }, 'amount');
  }
});

test('parseDollarsToCents returns null for invalid input', () => {
  assert.equal(parseDollarsToCents('12.50'), 1250);
  assert.equal(parseDollarsToCents('12.505'), null);
  assert.equal(parseDollarsToCents('0'), null);
});

test('search validation: page defaults to 1, accepts positive integers, rejects the rest', () => {
  assert.equal(ok({}).page, 1);
  assert.equal(ok({ page: '1' }).page, 1);
  assert.equal(ok({ page: '42' }).page, 42);
  assert.equal(ok({ page: '' }).page, 1);
  for (const p of ['0', '-1', '1.5', 'abc', '1e2', ' ', '99999999999']) {
    if (p === ' ') continue;
    bad({ page: p }, 'page');
  }
});

test('search validation: repeated (array) params are rejected', () => {
  bad({ email: ['a', 'b'] }, 'email');
  bad({ page: ['1', '2'] }, 'page');
  bad({ date: ['2026-01-01', '2026-01-02'] }, 'date');
});

test('search validation: combined filters', () => {
  const v = ok({ date: '2026-03-05', email: 'ana', type: 'sale', amount: '12.50', page: '2' });
  assert.deepEqual(v, {
    page: 2,
    filters: { from: '2026-03-05 00:00:00', to: '2026-03-06 00:00:00', email: 'ana', type: 'sale', amountCents: 1250 },
  });
});

test('page-only validation (GET /api/orders)', () => {
  const r = validatePageQuery({ page: '3' });
  assert.deepEqual(r, { ok: true, value: 3 });
  assert.deepEqual(validatePageQuery({}), { ok: true, value: 1 });
  assert.equal(validatePageQuery({ page: '0' }).ok, false);
});
