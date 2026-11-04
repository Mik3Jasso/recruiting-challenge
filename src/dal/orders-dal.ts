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

export interface OrderSummary {
  total_orders: number;
  unique_customers: number;
  avg_order_value_cents: number;
}

export interface TopCustomerRow {
  customer_email: string;
  order_count: number;
  total_spent: number;
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
   * Net amount over a date range for a merchant: sales minus refunds.
   * Refund rows store a positive total_amount, so they are negated here.
   * Used by the revenue endpoint.
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
  /** Dashboard summary stats for a merchant (rows of every type, as the metrics route always did). */
  summaryByMerchant(merchantId: string): OrderSummary {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS total_orders,
                COUNT(DISTINCT customer_email) AS unique_customers,
                COALESCE(AVG(total_amount), 0) AS avg
         FROM orders WHERE merchant_id = ?`,
      )
      .get(merchantId) as { total_orders: number; unique_customers: number; avg: number };
    return {
      total_orders: row.total_orders,
      unique_customers: row.unique_customers,
      avg_order_value_cents: Math.round(row.avg),
    };
  },

  topCustomersByMerchant(merchantId: string, limit: number): TopCustomerRow[] {
    return db
      .prepare(
        `SELECT customer_email, COUNT(*) AS order_count, SUM(total_amount) AS total_spent
         FROM orders
         WHERE merchant_id = ?
         GROUP BY customer_email
         ORDER BY total_spent DESC
         LIMIT ?`,
      )
      .all(merchantId, limit) as TopCustomerRow[];
  },
};
