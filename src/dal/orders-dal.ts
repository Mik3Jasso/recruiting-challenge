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

/** Fixed page size for order listings; not client-configurable. */
export const PAGE_SIZE = 30;

export interface OrderFilters {
  /** created_at >= from (inclusive). Applied independently of `to`. */
  from?: string;
  /** created_at < to (exclusive). */
  to?: string;
  /** Case-insensitive "contains" match on customer_email; LIKE wildcards are literal. */
  email?: string;
  type?: 'sale' | 'refund';
  /** Exact match on total_amount, in integer cents. */
  amountCents?: number;
}

export interface OrderPage {
  orders: OrderRow[];
  /** Number of rows matching the filters across all pages. */
  total: number;
}

/** Escapes LIKE wildcards so user input matches literally (paired with ESCAPE '\'). */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Builds the shared WHERE clause. SQL text is assembled only from fixed fragments;
 * every user-supplied value goes through a bound parameter. Tenancy is always applied.
 */
function buildWhere(merchantId: string, f: OrderFilters): { sql: string; params: (string | number)[] } {
  const clauses = ['merchant_id = ?'];
  const params: (string | number)[] = [merchantId];
  if (f.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(f.from);
  }
  if (f.to !== undefined) {
    clauses.push('created_at < ?');
    params.push(f.to);
  }
  if (f.email !== undefined) {
    clauses.push("customer_email LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(f.email)}%`);
  }
  if (f.type !== undefined) {
    clauses.push('type = ?');
    params.push(f.type);
  }
  if (f.amountCents !== undefined) {
    clauses.push('total_amount = ?');
    params.push(f.amountCents);
  }
  return { sql: clauses.join(' AND '), params };
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

  /**
   * One page of a merchant's orders (newest first, id as tiebreaker) plus the real
   * total of matching rows. Count and page are read in one transaction.
   */
  search(merchantId: string, filters: OrderFilters, page: number, pageSize: number = PAGE_SIZE): OrderPage {
    const where = buildWhere(merchantId, filters);
    return db.transaction((): OrderPage => {
      const { total } = db
        .prepare(`SELECT COUNT(*) AS total FROM orders WHERE ${where.sql}`)
        .get(...where.params) as { total: number };
      const orders = db
        .prepare(
          `SELECT * FROM orders WHERE ${where.sql}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(...where.params, pageSize, (page - 1) * pageSize) as OrderRow[];
      return { orders, total };
    })();
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
