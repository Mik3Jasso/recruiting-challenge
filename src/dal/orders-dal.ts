import { db } from '../db.js';

export interface OrderRow {
  id: string;
  merchant_id: string;
  customer_email: string;
  total_amount: number;
  type: 'sale' | 'refund';
  status: string;
  created_at: string;
}

/**
 * Data-access layer for orders. All order queries should go through here.
 *
 * - centralized place for query patterns
 * - the place to add auditing, caching, tenancy filters
 * - the seam for swapping the underlying store
 */
export const ordersDal = {
  listByMerchant(merchantId: string, opts: { from?: string; to?: string; limit?: number } = {}): OrderRow[] {
    const limit = opts.limit ?? 100;
    if (opts.from && opts.to) {
      return db
        .prepare(
          `SELECT * FROM orders
           WHERE merchant_id = ? AND created_at >= ? AND created_at < ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(merchantId, opts.from, opts.to, limit) as OrderRow[];
    }
    return db
      .prepare(`SELECT * FROM orders WHERE merchant_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(merchantId, limit) as OrderRow[];
  },

  getById(id: string): OrderRow | undefined {
    return db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as OrderRow | undefined;
  },

  create(order: Omit<OrderRow, 'created_at'>): OrderRow {
    db.prepare(
      `INSERT INTO orders (id, merchant_id, customer_email, total_amount, type, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(order.id, order.merchant_id, order.customer_email, order.total_amount, order.type, order.status);
    return this.getById(order.id)!;
  },

  /**
   * NET amount over a date range for a merchant: sales minus refunds.
   * Refund rows store a positive total_amount; they reduce revenue.
   * Range is [from, to) on the created_at string.
   */
  sumAmountByMerchant(merchantId: string, from: string, to: string): number {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN type = 'refund' THEN -total_amount ELSE total_amount END), 0) AS total
         FROM orders
         WHERE merchant_id = ? AND created_at >= ? AND created_at < ?`,
      )
      .get(merchantId, from, to) as { total: number };
    return row.total;
  },

  /**
   * Order-count stats for a merchant. Only type='sale' rows are orders;
   * refund rows are reversals and are excluded from count, customers and average.
   */
  summaryByMerchant(merchantId: string): { total_orders: number; unique_customers: number; avg_order_value: number } {
    return db
      .prepare(
        `SELECT COUNT(*) AS total_orders,
                COUNT(DISTINCT customer_email) AS unique_customers,
                COALESCE(AVG(total_amount), 0) AS avg_order_value
         FROM orders WHERE merchant_id = ? AND type = 'sale'`,
      )
      .get(merchantId) as { total_orders: number; unique_customers: number; avg_order_value: number };
  },

  /** Top customers by NET spend (sales minus refunds); order_count counts sales only. */
  topCustomersByMerchant(
    merchantId: string,
    limit: number,
  ): Array<{ customer_email: string; order_count: number; total_spent: number }> {
    return db
      .prepare(
        `SELECT customer_email,
                SUM(CASE WHEN type = 'sale' THEN 1 ELSE 0 END) AS order_count,
                SUM(CASE WHEN type = 'refund' THEN -total_amount ELSE total_amount END) AS total_spent
         FROM orders
         WHERE merchant_id = ?
         GROUP BY customer_email
         ORDER BY total_spent DESC
         LIMIT ?`,
      )
      .all(merchantId, limit) as Array<{ customer_email: string; order_count: number; total_spent: number }>;
  },
};
