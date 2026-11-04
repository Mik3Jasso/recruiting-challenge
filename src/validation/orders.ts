import type { OrderFilters } from '../dal/orders-dal.js';

export interface NewOrderInput {
  customer_email: string;
  total_amount: number;
  type: 'sale' | 'refund';
}

export type NewOrderResult = { ok: true; value: NewOrderInput } | { ok: false; detail: string };

/**
 * Validates the POST /api/orders body. Only customer_email, total_amount and type
 * are read; any other field (id, merchant_id, status, ...) is ignored.
 *
 * - total_amount: integer cents, > 0, <= Number.MAX_SAFE_INTEGER. Refunds are
 *   also positive; the `type` column is what makes them reduce revenue.
 * - type: 'sale' (default) or 'refund'.
 * - customer_email: non-empty string after trimming (no format check).
 */
export function validateNewOrder(body: unknown): NewOrderResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, detail: 'body must be a JSON object' };
  }
  const { customer_email, total_amount, type } = body as Record<string, unknown>;

  if (typeof customer_email !== 'string' || customer_email.trim() === '') {
    return { ok: false, detail: 'customer_email must be a non-empty string' };
  }
  if (typeof total_amount !== 'number' || !Number.isSafeInteger(total_amount) || total_amount <= 0) {
    return { ok: false, detail: 'total_amount must be a positive integer number of cents' };
  }
  if (type !== undefined && type !== 'sale' && type !== 'refund') {
    return { ok: false, detail: "type must be 'sale' or 'refund'" };
  }

  return { ok: true, value: { customer_email: customer_email.trim(), total_amount, type: type ?? 'sale' } };
}

// ---------------------------------------------------------------------------
// Query validation for GET /api/orders and GET /api/orders/search
// ---------------------------------------------------------------------------

/** Highest page number accepted; keeps OFFSET arithmetic far from overflow. */
export const MAX_PAGE = 1_000_000;

export type QueryResult<T> = { ok: true; value: T } | { ok: false; detail: string };

export interface SearchQuery {
  page: number;
  filters: OrderFilters;
}

type RawQuery = Record<string, unknown>;

/** Reads an optional string query param. '' (and absent) => undefined; arrays/objects are rejected. */
function readString(q: RawQuery, name: string): QueryResult<string | undefined> {
  const raw = q[name];
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string') return { ok: false, detail: `${name} must be a single value` };
  return { ok: true, value: raw };
}

/**
 * Converts a dollar string ("12", "12.5", "12.50") to integer cents by parsing the
 * digits, never via floating point. Returns null unless the input is a positive
 * amount with at most 2 decimals.
 */
export function parseDollarsToCents(input: string): number | null {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** 'YYYY-MM-DD' (a real calendar day) -> [start, next day start) as 'YYYY-MM-DD 00:00:00' bounds. */
function dayBounds(date: string): { from: string; to: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const start = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(start) || new Date(start).toISOString().slice(0, 10) !== date) return null;
  const next = new Date(start + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // The space-separated form sorts correctly against both ISO ('T') timestamps and
  // SQLite CURRENT_TIMESTAMP values (' ') stored in created_at.
  return { from: `${date} 00:00:00`, to: `${next} 00:00:00` };
}

/** page: integer 1..MAX_PAGE, default 1. */
export function validatePageQuery(q: RawQuery): QueryResult<number> {
  const s = readString(q, 'page');
  if (!s.ok) return { ok: false, detail: 'page must be a single value' };
  if (s.value === undefined || s.value === '') return { ok: true, value: 1 };
  if (!/^\d+$/.test(s.value) || Number(s.value) < 1 || Number(s.value) > MAX_PAGE) {
    return { ok: false, detail: `page must be an integer between 1 and ${MAX_PAGE}` };
  }
  return { ok: true, value: Number(s.value) };
}

/**
 * Validates the GET /api/orders/search query string. Every param is optional;
 * an empty string behaves like an absent one.
 *
 * - date:   YYYY-MM-DD, one UTC calendar day. Future days are fine (empty result).
 * - email:  trimmed, case-insensitive "contains" (wildcards escaped in the DAL).
 * - type:   'sale' | 'refund'.
 * - amount: dollars with up to 2 decimals, > 0; converted to exact integer cents.
 * - page:   see validatePageQuery.
 */
export function validateSearchQuery(q: RawQuery): QueryResult<SearchQuery> {
  const filters: OrderFilters = {};

  const date = readString(q, 'date');
  if (!date.ok) return { ok: false, detail: 'date must be a single value' };
  if (date.value) {
    const bounds = dayBounds(date.value);
    if (!bounds) return { ok: false, detail: 'date must be a valid calendar day in YYYY-MM-DD format' };
    filters.from = bounds.from;
    filters.to = bounds.to;
  }

  const email = readString(q, 'email');
  if (!email.ok) return { ok: false, detail: 'email must be a single value' };
  if (email.value?.trim()) filters.email = email.value.trim();

  const type = readString(q, 'type');
  if (!type.ok) return { ok: false, detail: 'type must be a single value' };
  if (type.value) {
    if (type.value !== 'sale' && type.value !== 'refund') {
      return { ok: false, detail: "type must be 'sale' or 'refund'" };
    }
    filters.type = type.value;
  }

  const amount = readString(q, 'amount');
  if (!amount.ok) return { ok: false, detail: 'amount must be a single value' };
  if (amount.value?.trim()) {
    const cents = parseDollarsToCents(amount.value);
    if (cents === null) {
      return { ok: false, detail: 'amount must be a positive dollar amount with at most 2 decimals (e.g. 12 or 12.50)' };
    }
    filters.amountCents = cents;
  }

  const page = validatePageQuery(q);
  if (!page.ok) return page;

  return { ok: true, value: { page: page.value, filters } };
}
