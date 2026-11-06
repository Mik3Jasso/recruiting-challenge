# API reference

Contract for callers of the merchant dashboard API. How it is built: [architecture.md](architecture.md). Known problems with IDs (F2, F4, ...): [FINDINGS.md](FINDINGS.md). Behaviour that differs from what a caller might expect is collected in [Known limitations](#known-limitations).

Verified against the code in `src/` and by running the server against a throwaway database. Example IDs, timestamps and numbers are real output from that run; the seed data is random, so your numbers will differ.

## Conventions

| Topic | Rule |
|---|---|
| Base URL | `http://localhost:3000`. Port comes from the `PORT` environment variable (default 3000). |
| Auth | Every endpoint under `/api` except `GET /api/health` requires an `X-Merchant-Id` header with a non-empty value. The header is trusted as-is (see L2). |
| Request bodies | JSON (`Content-Type: application/json`). Only `POST /api/orders` takes a body. |
| Money | Integer **cents** in every field named `*_cents`, `total_amount`, `total_spent`. The only exception is `revenue` (float dollars) in `/api/revenue`. Query param `amount` on `/api/orders/search` is in **dollars**. |
| Timestamps | `created_at` is UTC text with no zone conversion. Two formats exist: `2026-08-18T21:20:58.815Z` (seeded/sample rows) and `2026-11-06 23:29:23` (rows created with `POST /api/orders`). See L9. |
| Order object | `{ id, merchant_id, customer_email, total_amount, type, status, created_at }`. `type` is `sale` or `refund`; refunds carry a **positive** `total_amount`. `status` is `completed` for every row the API can create. |
| Pagination | Fixed page size 30 on both order listings. Not configurable. |

### Errors

| HTTP | Body | When |
|---|---|---|
| 401 | `{ "error": "missing_merchant_id" }` | `X-Merchant-Id` absent or empty, on any `/api` route except `/api/health`. |
| 400 | `{ "error": "invalid_param", "detail": "..." }` | Bad query param on `GET /api/orders` or `GET /api/orders/search`. |
| 400 | `{ "error": "invalid_body", "detail": "..." }` | Bad body on `POST /api/orders`. |
| 400 | `{ "error": "missing_date_range", "detail": "from and to are required (YYYY-MM-DD)" }` | `GET /api/revenue` without both `from` and `to`. |
| 404 | `{ "error": "not_found" }` | `GET /api/orders/:id` with an unknown id. |
| 500 | `{ "error": "internal_error" }` | Any unhandled error (the global error handler logs it to stdout/stderr). Includes cases that arguably are client errors: see L5, L6, L10. |

An unknown path under `/api` (for example `/api/nope`) returns Express's default HTML 404 page, not JSON.

## `GET /api/health`

No auth. Always `200 {"ok":true}`.

```sh
curl http://localhost:3000/api/health
```

## `GET /api/orders`

Orders of the authenticated merchant, newest first (`created_at DESC, id DESC`), paginated.

| Param | Rules |
|---|---|
| `page` | Integer 1..1,000,000, default 1; empty means default. Anything else (`0`, `abc`, repeated `page=1&page=2`) is 400 `invalid_param`. |
| `from`, `to` | Optional range: `created_at >= from AND created_at < to` (`to` exclusive), compared as raw text. Applied **only when both are non-empty**; if only one is sent it is silently ignored. Not validated (L3). |
| `limit` | Ignored (L4). |

Response 200:

```json
{
  "orders": [
    { "id": "f6224239-6379-4bee-8b96-3f3fcfda99f9", "merchant_id": "m_acme", "customer_email": "Zed@Example.com",
      "total_amount": 1250, "type": "sale", "status": "completed", "created_at": "2026-11-06 23:29:23" }
  ],
  "page": 1, "page_size": 30, "total": 41, "total_pages": 2
}
```

`total` is the real number of matching rows across all pages; `total_pages = ceil(total / 30)`. No matches: `orders: []`, `total: 0`, `total_pages: 0`. A page past the end returns `orders: []` with the real `total`. A merchant id that has no rows (or does not exist) gets the empty shape, not an error.

```sh
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders?page=2'
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders?from=2026-11-01&to=2026-11-07'
```

Bad page: `GET /api/orders?page=0` returns 400 `{"error":"invalid_param","detail":"page must be an integer between 1 and 1000000"}`.

Breaking change for older consumers: before pagination this endpoint returned only `{ orders }`, honoured `limit` (default 100) and was not paged. Read `total` / `total_pages` and request further pages with `page`.

## `GET /api/orders/search`

Same envelope and ordering as `GET /api/orders`, with filters. Only the authenticated merchant's rows are searched. All params are optional, combine with AND, and an empty value behaves like an absent one. Each param may be given once; repeating one is 400.

| Param | Rules |
|---|---|
| `date` | `YYYY-MM-DD`, a real calendar day (`2026-02-30` is rejected). Matches one **UTC** day: `00:00:00` inclusive to next day `00:00:00` exclusive. A future day is accepted and returns an empty result. |
| `email` | Trimmed; case-insensitive "contains" on `customer_email`. `%`, `_` and `\` match literally. Case-insensitivity is ASCII only (SQLite `LIKE`). |
| `type` | `sale` or `refund`. |
| `amount` | Exact match on `total_amount`, given in **dollars**: positive, up to 12 integer digits, at most 2 decimals (`12`, `12.5`, `12.50`). Converted to cents by digit parsing, no floating point. `12.500`, `0`, `-1`, `1e3`, `abc` are 400. |
| `page` | Integer 1..1,000,000, default 1. |

`limit` and `page_size` are ignored.

Response 200 (real output of `?type=sale&page=2`, first row only):

```json
{
  "orders": [
    { "id": "2e273f2d-d64f-4aa8-a8c9-d49d6fd60733", "merchant_id": "m_acme", "customer_email": "carla@example.com",
      "total_amount": 12590, "type": "sale", "status": "completed", "created_at": "2026-08-12T16:03:23.122Z" }
  ],
  "page": 2, "page_size": 30, "total": 35, "total_pages": 2
}
```

400 `invalid_param` details: `date must be a valid calendar day in YYYY-MM-DD format`, `type must be 'sale' or 'refund'`, `amount must be a positive dollar amount with at most 2 decimals (e.g. 12 or 12.50)`, `page must be an integer between 1 and 1000000`, `<name> must be a single value`.

```sh
# refunds of exactly $10.00 on 2026-05-01 (UTC)
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?date=2026-05-01&type=refund&amount=10'
# emails containing "garcia" (any case), page 2
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?email=GARCIA&page=2'
# repeated param -> 400 {"error":"invalid_param","detail":"email must be a single value"}
curl -i -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/orders/search?email=a&email=b'
```

## `GET /api/orders/:id`

Returns one order by id: `200 { "order": { ... } }`, or `404 { "error": "not_found" }` if no order has that id.

**Tenancy: the lookup is by id only.** The authenticated merchant is not part of the query, so any caller with any non-empty `X-Merchant-Id` receives the order whatever merchant owns it (verified: `m_bistro` and an unknown id `nobody` both got 200 for an `m_acme` order). A 404 therefore means "no such id", never "belongs to someone else". See L1.

```sh
curl -H 'X-Merchant-Id: m_acme' http://localhost:3000/api/orders/f6224239-6379-4bee-8b96-3f3fcfda99f9
```

```json
{ "order": { "id": "f6224239-6379-4bee-8b96-3f3fcfda99f9", "merchant_id": "m_acme", "customer_email": "Zed@Example.com",
             "total_amount": 1250, "type": "sale", "status": "completed", "created_at": "2026-11-06 23:29:23" } }
```

## `POST /api/orders`

Creates an order for the authenticated merchant.

| Body field | Rules |
|---|---|
| `customer_email` | Required. Non-empty string after trimming; stored trimmed; no format check. |
| `total_amount` | Required. Positive safe integer, in cents. Refunds are also positive. Floats, 0, negatives, strings are 400. |
| `type` | Optional: `sale` (default) or `refund`. |

Any other field is ignored. `id` (random UUID), `merchant_id` (from the header), `status` (`completed`) and `created_at` (database default, UTC, space format) are set by the server.

```sh
curl -X POST -H 'X-Merchant-Id: m_acme' -H 'Content-Type: application/json' \
  -d '{"customer_email":"zed@example.com","total_amount":1250}' http://localhost:3000/api/orders
```

201:

```json
{ "order": { "id": "f6224239-6379-4bee-8b96-3f3fcfda99f9", "merchant_id": "m_acme", "customer_email": "Zed@Example.com",
             "total_amount": 1250, "type": "sale", "status": "completed", "created_at": "2026-11-06 23:29:23" } }
```

400 example: `{"error":"invalid_body","detail":"total_amount must be a positive integer number of cents"}`. Other details: `body must be a JSON object`, `customer_email must be a non-empty string`, `type must be 'sale' or 'refund'`.

A merchant id that does not exist in `merchants` makes the insert fail the foreign key and returns 500 `internal_error`; a malformed JSON body also returns 500 (L5).

## `GET /api/revenue`

Net revenue for the authenticated merchant over a date range: sales minus refunds. Refund rows are positive, so they are subtracted; the result can be negative.

| Param | Rules |
|---|---|
| `from` | Required. Raw text; rows with `created_at >= from`. |
| `to` | Required. Raw text; rows with `created_at < to` (**exclusive**). |

Neither is format-checked. Missing or empty `from`/`to` is 400 `missing_date_range`. Intended format is `YYYY-MM-DD`; because comparison is textual, `to=2026-11-06` excludes every row created on 2026-11-06 (L3).

Response 200 (real output):

```json
{ "merchant_id": "m_acme", "from": "2026-10-01", "to": "2026-11-06", "revenue_cents": 127801, "revenue": 1278.01 }
```

| Field | Meaning |
|---|---|
| `merchant_id` | The header value, echoed. |
| `from`, `to` | The params, echoed unchanged. |
| `revenue_cents` | `SUM(CASE WHEN type='refund' THEN -total_amount ELSE total_amount END)` over the range, or 0 if no rows. Integer cents. |
| `revenue` | `revenue_cents / 100` (float dollars). |

```sh
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/revenue?from=2026-10-01&to=2026-11-06'
```

## `GET /api/metrics/summary`

Summary statistics for the authenticated merchant. No parameters. **All three figures are computed over every row of the merchant, regardless of `type` and `status`: refunds are counted as orders** (L7).

Response 200 (real output; the merchant had 35 sales and 6 refunds):

```json
{ "merchant_id": "m_acme", "total_orders": 41, "unique_customers": 4, "avg_order_value_cents": 10235 }
```

| Field | Computed as |
|---|---|
| `merchant_id` | The header value, echoed. |
| `total_orders` | `COUNT(*)` of the merchant's rows (sales + refunds, any status). |
| `unique_customers` | `COUNT(DISTINCT customer_email)`. Exact text match: `Zed@Example.com` and `zed@example.com` count as two. |
| `avg_order_value_cents` | `Math.round(AVG(total_amount))` over all rows, refunds included at their positive amount (not netted). `0` when the merchant has no rows. (Check: (357357 + 62268) / 41 = 10235.3.) |

A merchant id with no rows returns zeros for all three (verified for the unknown id `nobody`).

```sh
curl -H 'X-Merchant-Id: m_acme' http://localhost:3000/api/metrics/summary
```

## `GET /api/metrics/top-customers`

Customers of the authenticated merchant ranked by spend.

| Param | Rules |
|---|---|
| `limit` | Optional, default 5. Read as `Number(limit)` with no validation; see below. |

Response 200 (real output of `?limit=2`):

```json
{ "customers": [
  { "customer_email": "elena@example.com", "order_count": 13, "total_spent": 145716 },
  { "customer_email": "carla@example.com", "order_count": 13, "total_spent": 142329 }
] }
```

| Field | Computed as |
|---|---|
| `customer_email` | Grouping key, exact text (case-sensitive). |
| `order_count` | `COUNT(*)` of that customer's rows, sales and refunds alike. |
| `total_spent` | `SUM(total_amount)` in cents over those rows. Refunds are stored positive, so **a refund adds to `total_spent`**; this is a gross figure, not net spend. |

Ordering is `total_spent DESC`; ties have no secondary key, so their order is not defined. No rows gives `{ "customers": [] }`.

Behaviour of `limit` (each value tried against the running server):

| `limit` | Result |
|---|---|
| absent | 5 customers max |
| `2` | 2 customers |
| `0` or empty (`limit=`) | `[]` (`Number('')` is 0) |
| `-1` | all customers (SQLite treats a negative `LIMIT` as no limit) |
| `1e9` | all customers |
| `abc`, `1.5`, `Infinity` | 500 `internal_error` |
| repeated (`limit=1&limit=2`) | 500 `internal_error` |
| `%203` (" 3") | works like 3 |

```sh
curl -H 'X-Merchant-Id: m_acme' 'http://localhost:3000/api/metrics/top-customers?limit=2'
```

## Known limitations

Documented as the system behaves today; none of these is validated or enforced by the API. IDs (F#) refer to [FINDINGS.md](FINDINGS.md), where F-entries marked "FIXED" describe the sandbox branch as audited; the behaviour below is what `main` does now.

| # | Finding | Behaviour |
|---|---|---|
| L1 | F4 | `GET /api/orders/:id` is not scoped to the merchant (see that section). Any caller can read any order whose id they know. FINDINGS and the user's answer to its open question 6 call for a 404 for other merchants; that is not implemented. |
| L2 | F5 | `X-Merchant-Id` is trusted and unverified. Any non-empty value authenticates. An unknown merchant just sees empty data on reads (empty lists, zeros) and gets 500 on `POST /api/orders` (foreign key). There is no signed token. |
| L3 | F7, F8 | `from` / `to` on `/api/orders` and `/api/revenue` are raw strings compared with `created_at` as text: not validated, `to` exclusive, so `to=D` excludes all of day D, and `from=to=D` is always empty. On `/api/orders` a single bound is silently ignored (all rows returned). `/api/orders/search` `date` is the validated alternative for one day. The user's decision to make `to` inclusive and use a business timezone (FINDINGS open question 4) is not implemented. |
| L4 | - | `limit` is ignored on `/api/orders` and `/api/orders/search`; page size is fixed at 30. `ordersDal.listByMerchant` (which honoured `limit`, default 100) exists but no route uses it. |
| L5 | - | A malformed JSON body on `POST /api/orders` returns 500 `internal_error`, not 400: the body-parser error reaches the global error handler, which always answers 500. |
| L6 | F9 | `limit` on `/api/metrics/top-customers` is unvalidated (table above): non-numeric and fractional values give 500, negative values return everything. |
| L7 | F2 | `total_orders`, `avg_order_value_cents` and `unique_customers` count rows of every type, refunds included; top-customers `order_count` likewise and `total_spent` sums raw `total_amount`, so refunds add. FINDINGS F2 proposed sales-only and net figures and the Phase 2 branch characterised the existing behaviour instead; `main` still counts all rows. Revenue, in contrast, is net of refunds, so `revenue_cents` and the sum of `total_spent` do not reconcile. |
| L8 | - | `status` is not filtered or validated anywhere: every metric counts all statuses. Only `completed` exists in practice. |
| L9 | F7 | `created_at` has two text formats (see Conventions). Ordering within one UTC day across both formats is by text and can be wrong (`' '` sorts before `'T'`). `date` filtering is correct at day granularity for both. Not normalised. |
| L10 | - | Unknown `/api/*` paths return an HTML 404; a missing merchant row on POST returns 500 rather than a 4xx. |
| L11 | - | Customer emails are matched case-sensitively in `unique_customers` and `top-customers` but case-insensitively (ASCII) in `/search`. |
