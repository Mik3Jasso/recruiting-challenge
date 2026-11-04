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
