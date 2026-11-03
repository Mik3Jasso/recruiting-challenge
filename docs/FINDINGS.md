# Orders audit findings (sandbox: branch audit/orders-sandbox)

Scope: verify TOTAL NUMBER OF ORDERS and CORRESPONDING AMOUNTS. Line numbers refer to the original code at commit `cbf80ec` (before fixes).
Evidence: `audit/reconcile.ts`; baseline output `audit/reconcile-output-before.txt` (original code), `audit/reconcile-output-after.txt` (after fixes).
Run: `DB_PATH=data/audit.db PORT=3901 npx tsx src/server.ts` then `DB_PATH=data/audit.db npx tsx audit/reconcile.ts`.

## Ground truth (verified, from data/audit.db, read directly with sqlite3/better-sqlite3 readonly)

| merchant | rows | sales | refunds | gross sales | refunds | NET (sales - refunds) | naive SUM(all rows) |
|---|---|---|---|---|---|---|---|
| m_acme | 40 | 38 | 2 | 361,225 c ($3,612.25) | 18,888 c | 342,337 c ($3,423.37) | 380,113 |
| m_bistro | 40 | 34 | 6 | 398,243 c ($3,982.43) | 46,683 c | 351,560 c ($3,515.60) | 444,926 |
| total | 80 | 72 | 8 | 759,468 | 65,571 | 693,897 | 825,039 |

All 80 rows have status `completed`, integer positive amounts, valid types, unique ids, valid merchant FKs, no apparent duplicates. Refund rows store POSITIVE amounts. created_at is ISO-8601 `...T..Z` (24 chars) for every order row.
Data issues found: none in the data itself; the problems are in the code that aggregates it.

## Verified findings

### F1 - CRITICAL - Revenue adds refunds instead of subtracting (src/dal/orders-dal.ts:54-63)
`SUM(total_amount)` ignores `type`. Refund rows are positive, so revenue is overstated by 2x refunds.
Evidence (full range): acme API 380,113 vs net 342,337 (delta 37,776 = 2 x 18,888); bistro API 444,926 vs net 351,560 (delta 93,366 = 2 x 46,683). Dashboard "Revenue (last 30 days)" inherits it.
Impact: amounts overstated $377.76 (acme) and $933.66 (bistro) in total; 11-13% off.
FIXED (commit "Fix revenue to be net of refunds"), test `test/revenue.test.ts`. After: API = net for both merchants.
Assumption: refunds reduce revenue (see Open questions).

### F2 - HIGH - Order count and averages include refund rows (src/routes/metrics.ts:17-31)
`total_orders` = COUNT(*) of all rows. acme shows 40 vs 38 sales; bistro 40 vs 34. `avg_order_value_cents` averages refunds in: acme 9,503 vs 9,506; bistro 11,123 vs 11,713 (-5.0%). `top-customers` sums: total_spent 380,113/444,926 (gross incl. refunds added) vs net; order_count sums 40/40 vs 38/34.
FIXED (commit "Fix metrics ..."): sales-only count/customers/average; top-customers net spend, sales-only order_count; test added.
Note: refund-only customers can now show order_count 0 and negative total_spent (correct but may surprise).

### F3 - HIGH - metrics.ts bypasses the DAL with its own connection (src/routes/metrics.ts:4-5)
Separate readonly `new Database(DB_PATH)`, contradicting docs/architecture.md. Consequence: untestable under `DB_PATH=:memory:` (a separate empty DB / crashes if the file is missing), no tenancy hook, and it was the source of F2. FIXED by routing through new DAL functions (same commit as F2).

### F4 - HIGH - Cross-tenant read via GET /api/orders/:id (src/dal/orders-dal.ts:38-40, src/routes/orders.ts:16-23)
No merchant filter. Probe: `X-Merchant-Id: m_bistro` reads an m_acme order -> HTTP 200; a nonexistent merchant id also gets 200. Amount/ID disclosure, not a count error. NOT FIXED (outside count/amount scope; fix: `WHERE id=? AND merchant_id=?` and return 404).

### F5 - HIGH - Auth is an unverified header (src/auth.ts:17-22)
Any string is accepted as merchant (documented as a placeholder). Any caller can read or POST orders (inflating counts/amounts) for any merchant. Not fixed; out of scope. Also `POST` can attach orders to an unknown merchant id only if FK check passes (foreign_keys=ON on the main connection, so it 500s; not exercised to avoid writing).

### F6 - HIGH - POST /api/orders accepts any number and any type (src/routes/orders.ts:25-44)
Only `typeof === 'number'` was checked: negatives, 0, floats, NaN/Infinity (JSON can't carry NaN, but 1e308 or 10.5 can), and arbitrary `type` strings (stored; then counted by COUNT(*) but excluded from any type-aware sum). FIXED: positive safe integer cents, `type` in {sale, refund, undefined}; tests `test/validation.test.ts`. Live check after fix: negative amount -> 400. Not fixed: `status` is hard-coded 'completed' and customer_email is not format-checked.

### F7 - MEDIUM - `to` is exclusive and date-only; today is excluded from "last 30 days" (orders-dal.ts:23-29,59; public/app.js:26-28)
created_at is `YYYY-MM-DDTHH:MM:SS.mmmZ`; the filter compares strings against `YYYY-MM-DD`. `to=2026-11-03` means `< '2026-11-03'`, so everything on 11-03 is excluded, and `from=to=D` is always empty (probe: `from=to=2026-11-02` -> 0). Dashboard uses `to = today (UTC)`, so today's orders are never in the card: bistro 30d net with today = 95,732 vs card 87,041 (one order today, 8,691 c excluded; acme unaffected, 0 today). Also UTC day vs the browser's local timezone; the table uses local `toLocaleDateString()`, so a row can show a different date than the day it is bucketed on.
Also: `CURRENT_TIMESTAMP` default (db.ts:20,30) produces `YYYY-MM-DD HH:MM:SS` (space, no T/Z). New orders created via POST therefore have a different format than seeded rows (`2026-11-03 18:10` sorts BEFORE `2026-11-03T..` and compares inconsistently: a POSTed order on a day is included with `to=D+1` only by luck of the date prefix, and mis-orders within the same day in ORDER BY created_at). Hypothesis-level for ordering; verified by reading the DDL and seed code (merchants.created_at shows the space format in audit.db). NOT FIXED: needs a business decision (inclusive vs exclusive, timezone).

### F8 - MEDIUM - `from` alone or `to` alone silently ignored by /api/orders (orders-dal.ts:23)
Both must be present, else the date filter is dropped. Probe `?from=2026-10-01` returned all 40 rows. A user filtering "since Oct 1" gets a wrong count with no error. Not fixed.

### F9 - MEDIUM - limit parsing (src/routes/orders.ts:11, orders-dal.ts:22; metrics.ts:43)
Probes on /api/orders: `limit=abc` -> 500; `1.5` -> 500; `-1` -> 200 with ALL rows (SQLite negative LIMIT = unlimited); `0` -> 0 rows; `limit=` (empty) -> Number('')=0 -> 0 rows; `1e9` -> all. Default limit 100 silently truncates: with >100 orders a client summing /api/orders under-counts (not triggered by current data: 40 per merchant). top-customers has the same NaN/negative behaviour. Not fixed.

### F10 - MEDIUM - Dashboard presentation of refunds (public/app.js:33-40)
The recent-orders table shows refunds with a positive amount and type label (e.g. $103.21 acme, $39.96 bistro within the top 10), so a human summing the column gets wrong totals. Table is limited to 10 rows (display only; not summed client-side). `o.customer_email` is inserted via innerHTML unescaped (XSS, not an amount issue). Not fixed.

### F11 - LOW - Dashboard card semantics
"Total orders" is the API's `total_orders` (now sales only); "Avg order value" is `avg_order_value_cents`/100 (cents->dollars division only in `money()`, no rounding drift beyond Math.round on the average). No client-side summation of limit-truncated lists exists. Verified by reading app.js.

### F12 - LOW - Test coverage / tooling
Original tests: 2 DAL tests, none for revenue, metrics, refunds, boundaries or routes. `npm test` glob `test/**/*.test.ts` is shell-expanded (picks up top level only under sh without globstar; works now). Now 7 tests.
data/audit-snapshot.db is 4096 bytes with NO tables (copied without its -wal file); it cannot serve as a pristine reference. audit.db's content lives partly in `audit.db-wal`. Recommend re-snapshotting with `sqlite3 src ".backup dst"` (not done; snapshot must not be modified).

## Hypotheses (not verified)
- Status semantics: with only `completed` rows present, non-completed (pending/failed/cancelled) handling cannot be verified; code ignores status everywhere.
- A refund row "does not by itself reverse the sale row" (architecture.md): there is no link (original_order_id), so refunds cannot be matched to sales; a refund could exceed its sale or double-refund.
- No idempotency/unique key on POST: retries create duplicate orders.
- Concurrency: metrics previously read through a second connection; harmless under WAL.

## Reconciliation after fixes (live API vs independent SQL)
Revenue (full range) = net: acme 342,337, bistro 351,560. total_orders = 38 / 34. avg = 9,506 / 11,713. top-customers sums match net and sale counts. Remaining "DIFF" lines in `reconcile-output-after.txt` (3) are: two where the script compares revenue to GROSS (informational, expected to differ now) and one 30-day-card difference caused by F7 (today excluded; bistro 95,732 expected vs 87,041 shown).

## Open questions for the user
1. Should refunds reduce revenue? ASSUMED YES (net = sales - refunds; refund rows hold positive amounts). If "revenue" should mean gross sales, F1's fix should be changed to `WHERE type='sale'`.
-  Yes, should reduce
2. Is a refund an "order"? ASSUMED NO (count = sale rows only). If refunds count as orders, revert F2's count.
-  A refund is not a separate order; it represents a canceled order. I need to see the original order along with the amount that was refunded. 
3. Which statuses count? ASSUMED all (every row is `completed`; no status filter added). Conservative alternative: count only `completed`.
-  Only completed should count. Even though every current row is completed, the filter should be explicit so that future pending, failed, or canceled rows don’t inflate revenue or order counts. Please add WHERE status = 'completed'.
4. Is `to` meant inclusive of that whole day? Currently exclusive; dashboard therefore omits today. Decide, then fix API or dashboard (F7). Which timezone defines a "day"?
-  to should be inclusive of the whole day, since that’s what users expect from a date range. Fix it in the API rather than in the dashboard, so every client gets the same behavior: keep a half-open interval internally (created_at >= from AND created_at < to + 1 day) and document it in the API docs.
A “day” should be defined by a single business timezone (e.g. the merchant’s timezone), configured on the server, not by the client’s local time. Timestamps stay stored in UTC; from/to are interpreted as dates in that business timezone and converted to UTC boundaries before querying. If no business timezone is defined yet, default to UTC and document it explicitly.
5. Should POST orders in a past/other currency or with `status` other than completed be supported? Currency is not modelled; USD is assumed in the UI.
-  Status: Yes, but validated. status should be an explicit enum (pending, completed, failed, canceled), and any other value should be rejected.
Currency: only USD allowed 
Past dates: created_at should be set by the server by default. If backfilling historical orders is a real need, allow an optional timestamp (modify\_at), but validate it (no future dates) and make that behavior explicit in the API docs.
6. Should getById return 404 for other merchants (F4)? ASSUMED yes, not changed.
-  Yes. Only the owning merchant can see their own orders. Requests for an order that belongs to another merchant must return 404, so the API doesn’t reveal that the order exists.

