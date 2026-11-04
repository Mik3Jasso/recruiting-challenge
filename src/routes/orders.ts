import { Router } from 'express';
import { ordersDal, PAGE_SIZE, type OrderPage } from '../dal/orders-dal.js';
import { randomUUID } from 'node:crypto';
import { validateNewOrder, validatePageQuery, validateSearchQuery } from '../validation/orders.js';

export const ordersRouter = Router();

/** Wire shape shared by the paged listing endpoints. */
function pagedResponse({ orders, total }: OrderPage, page: number) {
  return { orders, page, page_size: PAGE_SIZE, total, total_pages: Math.ceil(total / PAGE_SIZE) };
}

ordersRouter.get('/', (req, res) => {
  const page = validatePageQuery(req.query);
  if (!page.ok) {
    res.status(400).json({ error: 'invalid_param', detail: page.detail });
    return;
  }
  const { from, to } = req.query;
  // Same behaviour as before: the range applies only when both bounds are given.
  const range = typeof from === 'string' && typeof to === 'string' && from && to ? { from, to } : {};
  res.json(pagedResponse(ordersDal.search(req.merchantId!, range, page.value), page.value));
});

// Declared before '/:id' so "search" is not treated as an order id.
ordersRouter.get('/search', (req, res) => {
  const parsed = validateSearchQuery(req.query);
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_param', detail: parsed.detail });
    return;
  }
  const { filters, page } = parsed.value;
  res.json(pagedResponse(ordersDal.search(req.merchantId!, filters, page), page));
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
  const parsed = validateNewOrder(req.body);
  if (!parsed.ok) {
    res.status(400).json({ error: 'invalid_body', detail: parsed.detail });
    return;
  }
  const order = ordersDal.create({
    id: randomUUID(),
    merchant_id: req.merchantId!,
    ...parsed.value,
    status: 'completed',
  });
  res.status(201).json({ order });
});
