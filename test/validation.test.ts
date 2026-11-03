if (!process.env.DB_PATH) process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateNewOrder } from '../src/routes/orders.js';

test('validateNewOrder accepts positive integer cents and sale/refund/undefined type', () => {
  assert.equal(validateNewOrder({ customer_email: 'a@b.com', total_amount: 100 }), true);
  assert.equal(validateNewOrder({ customer_email: 'a@b.com', total_amount: 100, type: 'refund' }), true);
});

test('validateNewOrder rejects negative, zero, float, NaN, Infinity and unknown type', () => {
  for (const total_amount of [-5, 0, 10.5, NaN, Infinity, 2 ** 60]) {
    assert.equal(validateNewOrder({ customer_email: 'a@b.com', total_amount }), false, String(total_amount));
  }
  assert.equal(validateNewOrder({ customer_email: 'a@b.com', total_amount: 100, type: 'gift' }), false);
  assert.equal(validateNewOrder({ total_amount: 100 }), false);
});
