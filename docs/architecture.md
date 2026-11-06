# Architecture

How the merchant dashboard is built. Caller-facing contract: [api.md](api.md). Audit findings (F1-F12): [FINDINGS.md](FINDINGS.md). Process log: [Doc History.md](Doc%20History.md).

Stack: Node >= 20, TypeScript (ES modules, run with `tsx`), Express 4, better-sqlite3 (SQLite), static HTML + `fetch` for the UI. Verified against the code on `main`.

## Request flow

```
browser / curl
     |
     v
express.json()            parses JSON bodies (a malformed body raises an error -> error handler)
     |
express.static('public')  serves index.html and app.js for non-API paths (path is relative to the cwd)
     |
     +--> GET /api/health --------------------------------> { ok: true }   (no auth)
     |
     v   /api/orders  /api/revenue  /api/metrics
authMiddleware            X-Merchant-Id header missing/empty -> 401 { error: 'missing_merchant_id' }
     |                    otherwise sets req.merchantId (value is trusted, not verified)
     v
router (routes/orders.ts | revenue.ts | metrics.ts)
     |
     v
validation (validation/orders.ts)   pure functions: body / query -> typed value or 400 with detail
     |                              (revenue and metrics read their own params inline; see api.md)
     v
ordersDal (dal/orders-dal.ts)       all order SQL; prepared statements, bound parameters
     |
     v
better-sqlite3 -> SQLite file (WAL)   one shared connection from db.ts

any thrown error --> error handler (last middleware): logs, then 500 { error: 'internal_error' }
```

`/api/health` is registered before the auth-protected routers, so it is outside `authMiddleware`. Unknown paths fall through to Express's default HTML 404.

## Modules

| File | Role |
|---|---|
| `src/server.ts` | Bootstrap: `initSchema()`, `seedIfEmpty()`, middleware, route mounting, error handler, `listen` on `PORT` (default 3000). Importing it starts the server, which is why tests build their own small Express apps instead. |
| `src/db.ts` | Opens the single shared `db` (better-sqlite3) at `DB_PATH`, creates the parent directory if needed, sets `journal_mode = WAL` and `foreign_keys = ON`, and defines the schema in `initSchema()`. The connection is created when the module is first imported. |
| `src/auth.ts` | `authMiddleware`: reads `X-Merchant-Id`, 401 if missing/empty, else sets `req.merchantId`. A placeholder for real signed-token auth. |
| `src/dal/orders-dal.ts` | `ordersDal`: `search` (list + count), `getById`, `create`, `sumAmountByMerchant` (revenue), `summaryByMerchant`, `topCustomersByMerchant`, and the unused `listByMerchant`. Exports `PAGE_SIZE = 30`. All order queries, including the metrics routes, go through here. Exception: the seed script writes with `db` directly. |
| `src/validation/orders.ts` | Pure validators (no DB, no Express): `validateNewOrder` (POST body), `validatePageQuery`, `validateSearchQuery`, plus `parseDollarsToCents` and `MAX_PAGE`. |
| `src/routes/orders.ts` | `GET /`, `GET /search` (declared before `/:id` so it is not read as an id), `GET /:id`, `POST /`. |
| `src/routes/revenue.ts` | `GET /api/revenue`; checks `from`/`to` are present, delegates to the DAL. |
| `src/routes/metrics.ts` | `GET /summary`, `GET /top-customers`; delegate to the DAL. `limit` is read inline with `Number(...)`. |
| `src/scripts/seed.ts` | `seedIfEmpty()`; also runnable as a script (`npm run seed`). |
| `public/index.html`, `public/app.js` | The dashboard (see below). |

There is no `lib/` directory.

## Data model

SQLite, schema in `initSchema()` (`src/db.ts`), created with `IF NOT EXISTS` on every start.

`merchants`

| Column | Type | Constraints / default |
|---|---|---|
| `id` | TEXT | PRIMARY KEY |
| `name` | TEXT | NOT NULL |
| `created_at` | TEXT | NOT NULL, default `CURRENT_TIMESTAMP` |

`orders`

| Column | Type | Constraints / default |
|---|---|---|
| `id` | TEXT | PRIMARY KEY (UUID from the API; `so-NNNN` in sample data) |
| `merchant_id` | TEXT | NOT NULL, REFERENCES `merchants(id)` |
| `customer_email` | TEXT | NOT NULL |
| `total_amount` | INTEGER | NOT NULL; **integer cents** |
| `type` | TEXT | NOT NULL, default `'sale'` |
| `status` | TEXT | NOT NULL, default `'completed'` |
| `created_at` | TEXT | NOT NULL, default `CURRENT_TIMESTAMP` |

There are no CHECK constraints: `type` and `status` are validated only by the application (`type` in `sale`/`refund` at the POST and search boundaries).

Indexes on `orders`:

| Index | Columns | Purpose |
|---|---|---|
| `idx_orders_merchant` | `(merchant_id)` | Original index. Redundant now: `idx_orders_merchant_created` has the same leading column. Left in place. |
| `idx_orders_created` | `(created_at)` | Original index; no query filters on `created_at` without `merchant_id`. |
| `idx_orders_merchant_created` | `(merchant_id, created_at, id)` | Serves the per-merchant filter, date range and the newest-first sort with its id tiebreaker. |

Conventions:

- **Money is integer cents.** Refunds are stored as a **positive** `total_amount` with `type = 'refund'`; the `type` column, not the sign, makes them reduce revenue (`sumAmountByMerchant` negates them). There is no link from a refund to the sale it reverses.
- **`status`**: the API always writes `completed`, the seed writes `completed`, and the sample data is all `completed`, so that is the only value seen. Nothing validates or filters on it.
- **`created_at` formats** (UTC text, compared as text, never parsed in SQL):
  - ISO with `T` and `Z`, e.g. `2026-08-18T21:20:58.815Z`: seeded rows (`new Date().toISOString()`) and `data/sample-orders.json`.
  - SQLite `CURRENT_TIMESTAMP`, e.g. `2026-11-06 23:29:23` (space, no ms, no `Z`): rows from `POST /api/orders` (the DAL does not set `created_at`) and every `merchants.created_at`.
- **Pragmas**: `foreign_keys = ON` (so an order for an unknown merchant fails to insert) and `journal_mode = WAL`.

## Order search and pagination

Endpoints: `GET /api/orders/search` (filters) and `GET /api/orders` (date range only); both return `{ orders, page, page_size, total, total_pages }`.

- **One query path.** `ordersDal.search(merchantId, filters, page, pageSize = PAGE_SIZE)` serves both endpoints. A shared `buildWhere` assembles the WHERE clause from fixed fragments (`merchant_id = ?` is always first, so tenancy cannot be skipped) and every user value is a bound parameter. The `COUNT(*)` and the page `SELECT` use the same clause inside one transaction, so `total` is the real match count and agrees with the page. Order: `created_at DESC, id DESC`. `PAGE_SIZE` (30) is a DAL constant; `limit` is ignored.
- **Validation.** The validators turn raw query strings into DAL filters: `amount` (dollars) to integer cents by digit parsing, `date` to UTC day bounds, `email` trimmed, `type` whitelisted. Repeated params (arrays) and bad values give 400 `invalid_param`. `GET /api/orders` validates only `page`; it passes `from`/`to` to the DAL only when both are present and unvalidated.
- **Email match.** `LIKE ... ESCAPE '\'` with `%`, `_` and `\` escaped so wildcards are literal. SQLite `LIKE` is case-insensitive for ASCII only.
- **UTC day semantics.** `date=D` means `created_at >= 'D 00:00:00'` and `< '(D+1) 00:00:00'`. The space form sorts correctly against both stored formats at day granularity (`'T'` sorts after `' '`). The UI labels the filter and column "(UTC)".
- **Mixed formats caveat.** Ordering inside one UTC day across the two `created_at` formats is by text and can be wrong. The raw `from`/`to` of `GET /api/orders` and `/api/revenue` keep the format quirks described in FINDINGS F7.

## Dashboard (`public/index.html`, `public/app.js`)

Static page, no framework or build step; served by `express.static('public')`. All data comes from the API with `fetch` and the `X-Merchant-Id` header taken from the merchant switcher.

**Merchant switcher.** A `<select>` ("Logged in as") with two hard-coded options, `m_acme` and `m_bistro`. Changing it resets the order filters, reloads the orders table and refreshes the summary cards. The header is the only identity mechanism.

**Summary cards** (`refreshSummary()`)

| Card | Endpoint | Field | Display |
|---|---|---|---|
| Total orders | `GET /api/metrics/summary` | `total_orders` | number, `—` if absent. Counts refunds (limitation 1 below). |
| Unique customers | `GET /api/metrics/summary` | `unique_customers` | number, `—` if absent |
| Avg order value | `GET /api/metrics/summary` | `avg_order_value_cents` | `money()`: cents / 100 as USD; `$0.00` if absent |
| Revenue (last 30 days) | `GET /api/revenue?from=...&to=...` | `revenue_cents` | `money()`; `$0.00` if absent |

**30-day revenue window.** In the browser, `now = new Date()`, `from = isoDate(now - 30 days)`, `to = isoDate(now)`, where `isoDate` is the UTC date (`toISOString().slice(0, 10)`). Because the API treats `to` as exclusive and compares text, the window is the 30 whole UTC days before today: if today is 2026-11-06 the request is `from=2026-10-07&to=2026-11-06`, covering 2026-10-07 through 2026-11-05. **Today's orders are never included** (FINDINGS F7). The card shows net revenue (sales minus refunds).

**Orders panel.** Filter form (date, customer email, type, amount in $) with Search and Clear. Filters apply on Search, not while typing. State is `appliedFilters` + `currentPage`. `loadOrders()` calls `GET /api/orders/search?...&page=N`; a `loadSeq` counter drops responses from superseded requests. If the requested page is past the end after data shrinks, it reloads the last page. The table shows date (UTC day = first 10 characters of `created_at`), customer, type and amount (`money(total_amount)`; refunds appear with a positive amount and the type label). Below it: a "Showing a-b of N" status line (`aria-live`), an empty state, an error paragraph and a pager (Prev, first/last and a window around the current page, Next). Rows are built with `textContent`, so emails are not injected as HTML.

**Client-side checks** (future date, amount format via `AMOUNT_RE`) only produce a friendly message; the server stays the authority. A 400 or network failure shows an error paragraph and clears the table and pager.

**Time zone.** The orders table and the date filter use UTC days. The date input's `max` is today in UTC.

## Run, seed and test

| Script | Command | What it does |
|---|---|---|
| `npm run dev` | `tsx watch src/server.ts` | Server with reload on file change. |
| `npm start` | `tsx src/server.ts` | Server. |
| `npm run seed` | `tsx src/scripts/seed.ts` | Runs `seedIfEmpty()` once; does nothing if `orders` already has rows. |
| `npm test` | `cross-env DB_PATH=:memory: node --import tsx --test test/**/*.test.ts` | Test suite (below). |
| `npm run build` | `tsc` | Compiles `src/` to `dist/` (tests are outside `rootDir`). |
| (no script) | `npx tsc --noEmit` | Type-check only; passes on `main`. |

Run commands from the repository root: `DB_PATH` (default `data/dashboard.db`) and the static directory `public` are resolved against the current working directory.

| Environment variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` | Listening port. |
| `DB_PATH` | `data/dashboard.db` | SQLite file; `:memory:` for an in-memory database. The parent directory is created if missing. |

**Database files.** With WAL, SQLite keeps `dashboard.db-wal` and `dashboard.db-shm` next to the database; recent writes may live only in the `-wal` file, so copy the three together (or use `sqlite3 <src> ".backup <dst>"`). `data/*.db` and its `-wal`/`-shm`/`-journal` files are git-ignored.

**First-run seeding.** On start (`server.ts`) and on `npm run seed`, if `orders` is empty, `seedIfEmpty()` inserts 2 merchants (`m_acme` "Acme Supplies", `m_bistro` "Bistro Verde") and 80 orders in one transaction: orders alternate merchants (40 each) and cycle six customers (`ana`, `bruno`, `carla`, `diego`, `elena`, `felipe` `@example.com`, so each merchant gets three of them); amount is random 2000-19999 cents; 15% are refunds; status `completed`; `created_at` random within the last 90 days. It is random, so figures differ for every new database.

**Reseed.** Stop the server, delete the database and its sidecars, start again:

```sh
rm -f data/dashboard.db data/dashboard.db-wal data/dashboard.db-shm
npm start
```

**Tests.** Runner is `node:test` with `tsx`; `DB_PATH=:memory:` is set by the script (each test file also defaults it before importing `db`). The glob is expanded by the shell, so it matches `test/*.test.ts`. Tests build small Express apps from the real routers (they do not import `server.ts`), so the static file serving, the global error handler and the seed are not covered. `data/sample-orders.json` (2000 orders, 1206 `m_acme` / 794 `m_bistro`, 1749 sales / 251 refunds, all `completed`, ISO `created_at` from 2025-11-04 to 2026-11-03) is used by the tests only; the seed script does not load it and there is no generator for it. Last run: 69 tests in 6 files, all passing.

| File | Tests | Covers |
|---|---|---|
| `test/orders.test.ts` | 2 | DAL `create`, `listByMerchant`, `getById`. |
| `test/order-validation.test.ts` | 10 | `validateNewOrder` rules; `POST /api/orders` over HTTP (server-controlled fields, 400 `invalid_body`, nothing inserted). |
| `test/search-validation.test.ts` | 15 | `validateSearchQuery`, `validatePageQuery`, `parseDollarsToCents`: dates, email, type, amount, page, repeated params. |
| `test/orders-search.test.ts` | 29 | `GET /api/orders/search` and `GET /api/orders` over HTTP: auth, filters, tenancy, UTC day bounds, wildcards, pagination envelope, SQL-as-data, plus checks against the 2000-row sample. Includes `GET /api/orders/:id` for the owning merchant only. |
| `test/revenue.test.ts` | 6 | `sumAmountByMerchant`: net of refunds, empty range, merchant isolation, `from` inclusive / `to` exclusive. |
| `test/metrics.test.ts` | 7 | `GET /summary`, `GET /top-customers` and the DAL functions; pins the current all-rows behaviour. |

## Known limitations

Open work, stated as facts about `main`. IDs refer to [FINDINGS.md](FINDINGS.md); more detail and the exact request/response behaviour is in the [api.md limitations](api.md#known-limitations).

| # | Finding | Limitation |
|---|---|---|
| 1 | F2 | Metrics count every row: `total_orders`, `unique_customers`, `avg_order_value_cents` include refunds; top-customers `order_count` includes refunds and `total_spent` is the raw sum, so refunds add. Revenue is net of refunds, so the figures do not reconcile. The dashboard cards show these values as returned. |
| 2 | F4 | `ordersDal.getById(id)` has no merchant filter; `GET /api/orders/:id` returns any order to any caller (verified live and in code). No test covers a cross-merchant read. |
| 3 | F5 | `authMiddleware` trusts `X-Merchant-Id`. Any non-empty value authenticates; unknown merchants see empty data and get 500 on POST (foreign key). |
| 4 | F7, F8 | `from`/`to` on `/api/orders` and `/api/revenue` are unvalidated raw text, `to` is exclusive, a single bound on `/api/orders` is ignored. The 30-day card therefore excludes today. Inclusive `to` and a business time zone (FINDINGS open question 4) are not implemented. |
| 5 | F9 | `limit` on top-customers is `Number(...)` with no validation: `abc`, `1.5`, `Infinity` give 500; negative returns all rows. |
| 6 | - | Mixed `created_at` formats (above); ordering within a day across formats is not handled. No normalisation on insert. |
| 7 | - | `limit` is ignored on `/api/orders`; `ordersDal.listByMerchant` is unused (still exercised by one test). |
| 8 | - | `idx_orders_merchant` is redundant with `idx_orders_merchant_created`, and `idx_orders_created` is not used by any current query. Neither has been dropped. |
| 9 | - | Malformed JSON body returns 500 (the error handler answers 500 for everything). Unknown `/api` paths return an HTML 404. |
| 10 | - | `public/app.js` nits, all verified in the current code: `refreshSummary()` has no stale-response guard (a merchant switch while a previous request is in flight can let the older response write the cards last) and its errors are swallowed (`.catch(() => {})`; `api()` does not check `res.ok`, so an error response leaves `—` or `$0.00` in the cards); `AMOUNT_RE` allows more than 12 integer digits while the server rejects them (the 400 then clears the table); the date input `max` is computed once at load and goes stale after midnight UTC (the submit-time check is recomputed). |
| 11 | - | `MAX_PAGE` is 1,000,000, so `OFFSET` can reach about 30 million rows (slow deep scan on a large table). Reviewer claim in Doc History step 21; the code allows it, performance not measured. |

## Open items

- Audit logging: TBD where it lives (the DAL is the intended seam).
- Decide on the limitations above (starting with F4, F5, F2, F7), tracked in [FINDINGS.md](FINDINGS.md) and Doc History step 21.
- Untested: `server.ts` wiring (static files, error handler) and the browser UI beyond reading the code.
