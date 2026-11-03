import { Router } from 'express';
import { ordersDal } from '../dal/orders-dal.js';

export const metricsRouter = Router();

/**
 * GET /api/metrics/summary
 *
 * Returns dashboard summary stats for the current merchant.
 * total_orders / unique_customers / avg_order_value_cents are over type='sale' rows only.
 */
metricsRouter.get('/summary', (req, res) => {
  const merchantId = req.merchantId!;
  const s = ordersDal.summaryByMerchant(merchantId);

  res.json({
    merchant_id: merchantId,
    total_orders: s.total_orders,
    unique_customers: s.unique_customers,
    avg_order_value_cents: Math.round(s.avg_order_value),
  });
});

metricsRouter.get('/top-customers', (req, res) => {
  const merchantId = req.merchantId!;
  const limit = Number(req.query.limit ?? 5);

  res.json({ customers: ordersDal.topCustomersByMerchant(merchantId, limit) });
});
