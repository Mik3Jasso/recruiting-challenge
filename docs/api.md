# API reference

> Quick-and-dirty. Not complete.

All endpoints require the `X-Merchant-Id` header.

## `GET /api/health`
No auth. Returns `{ ok: true }`.

## `GET /api/orders`
List orders for the authenticated merchant, newest first (`created_at DESC, id DESC`), **paginated**: fixed page size of 30.

Query:
- `page` (optional): integer 1..1,000,000, default 1. Empty = default. Anything else returns 400.
- `from`, `to` (optional): date range, `created_at >= from AND created_at < to` (`to` is exclusive). The range is applied **only when both are given**; if only one is sent it is silently ignored (unchanged behaviour). They are not validated.
- `limit`: **ignored**. The page size is fixed at 30 and cannot be changed by the client.

Response (same shape as `/api/orders/search`): `{ orders, page, page_size: 30, total, total_pages }`. `total` is the real number of matching rows, not the page length.

Breaking change for consumers: before pagination this endpoint returned `{ orders }` only, honoured `limit` (default 100) and was not paged. Callers must now read `total`/`total_pages` and request further pages with `page`.

Errors: 400 `{ "error": "invalid_param", "detail": "..." }` for a bad `page` (e.g. `0`, `abc`, repeated `page=1&page=2`); 401 `{ "error": "missing_merchant_id" }` without `X-Merchant-Id`.

## `GET /api/orders/search`
Search the authenticated merchant's orders. Only the merchant's own rows are ever returned. All params are optional and combine with AND; an empty value behaves like an absent one.

| Param | Rules |
|---|---|
| `date` | `YYYY-MM-DD`, a real calendar day. Matches one **UTC** day (`00:00:00` inclusive to next day `00:00:00` exclusive). A future day is accepted and returns empty results. |
| `email` | Trimmed. Case-insensitive "contains" match on `customer_email`. `%`, `_` and `\` are matched literally. Case-insensitivity is ASCII only (SQLite `LIKE`). |
| `type` | `sale` or `refund`. |
| `amount` | Exact match, in **dollars**: positive, up to 12 integer digits and at most 2 decimals (`12`, `12.5`, `12.50`). Converted to integer cents by digit parsing (no floating point). `12.500`, `0`, `-1`, `1e3`, `abc` are rejected. |
| `page` | Integer 1..1,000,000, default 1. |

Each param must be given once; repeating a param (e.g. `type=sale&type=refund`) is a 400.

Sorting: `created_at DESC, id DESC`. Page size is fixed at 30 (`limit` / `page_size` in the query are ignored).

Response 200:
```json
{ "orders": [ { "id": "...", "merchant_id": "m_acme", "customer_email": "...", "total_amount": 1000, "type": "refund", "status": "completed", "created_at": "2026-05-01T10:42:35.656Z" } ],
  "page": 1, "page_size": 30, "total": 31, "total_pages": 2 }
```
`total` is the real count of all matching rows (e.g. 31 matches: 30 rows on page 1, 1 row on page 2, `total_pages` 2). With no matches `orders` is `[]`, `total` 0 and `total_pages` 0. A `page` beyond the last returns `orders: []` with the real `total`. `total_pages = ceil(total / 30)`.

Errors:
- 400 `{ "error": "invalid_param", "detail": "..." }`, e.g. `date must be a valid calendar day in YYYY-MM-DD format`, `type must be 'sale' or 'refund'`, `amount must be a positive dollar amount with at most 2 decimals (e.g. 12 or 12.50)`, `page must be an integer between 1 and 1000000`, `<name> must be a single value`.
- 401 `{ "error": "missing_merchant_id" }` when `X-Merchant-Id` is missing.

Examples:
```sh
# refunds of exactly $10.00 on 2026-05-01 (UTC)
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?date=2026-05-01&type=refund&amount=10'
# emails containing "garcia" (any case), page 2
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?email=GARCIA&page=2'
# invalid date -> 400 {"error":"invalid_param","detail":"date must be a valid calendar day in YYYY-MM-DD format"}
curl -i -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?date=2026-02-30'
```
(Default port 3000, overridable with `PORT`.)

## `GET /api/orders/:id`
Get a single order by ID.

## `POST /api/orders`
Body: `{ customer_email, total_amount, type? }`. `customer_email`: non-empty string (trimmed, no format check). `total_amount`: positive integer number of cents (refunds are also positive). `type`: `'sale'` (default) or `'refund'`. Other fields are ignored; `id`, `merchant_id` and `status` are set by the server. Returns 201 `{ order }`, or 400 `{ error: 'invalid_body', detail }`.

## `GET /api/revenue?from=...&to=...`
Total revenue for the merchant in the date range: net of refunds (sales minus refunds), so it can be negative. Both `from` and `to` are required (400 `missing_date_range` otherwise); `to` is exclusive.

## `GET /api/metrics/summary`
TODO: document fields.

## `GET /api/metrics/top-customers`
TODO: document fields.
