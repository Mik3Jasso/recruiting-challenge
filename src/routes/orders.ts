import { Router } from 'express';
import { ordersDal } from '../dal/orders-dal.js';
import { randomUUID } from 'node:crypto';

export const ordersRouter = Router();

/** Amounts are integer cents > 0 (refunds are positive rows with type='refund'). */
export function validateNewOrder(body: {
  customer_email?: unknown;
  total_amount?: unknown;
  type?: unknown;
}): boolean {
  return (
    typeof body.customer_email === 'string' &&
    body.customer_email.length > 0 &&
    typeof body.total_amount === 'number' &&
    Number.isSafeInteger(body.total_amount) &&
    body.total_amount > 0 &&
    (body.type === undefined || body.type === 'sale' || body.type === 'refund')
  );
}

ordersRouter.get('/', (req, res) => {
  const orders = ordersDal.listByMerchant(req.merchantId!, {
    from: typeof req.query.from === 'string' ? req.query.from : undefined,
    to: typeof req.query.to === 'string' ? req.query.to : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
  });
  res.json({ orders });
});

ordersRouter.get('/:id', (req, res) => {
  const order = ordersDal.getById(req.params.id);
  if (!order) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({ order });
});

ordersRouter.post('/', (req, res) => {
  const body = req.body as {
    customer_email?: string;
    total_amount?: number;
    type?: 'sale' | 'refund';
  };
  if (!validateNewOrder(body ?? {})) {
    res.status(400).json({ error: 'invalid_body' });
    return;
  }
  const order = ordersDal.create({
    id: randomUUID(),
    merchant_id: req.merchantId!,
    customer_email: body.customer_email,
    total_amount: body.total_amount,
    type: body.type ?? 'sale',
    status: 'completed',
  });
  res.status(201).json({ order });
});
