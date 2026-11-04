# Architecture (DRAFT — needs love)

> This file was started a while ago and hasn't been kept up to date.
> Treat as partial. Update what you change.

## Modules

- **`server.ts`** — Express bootstrapper. Wires routers to paths.
- **`db.ts`** — SQLite connection + schema init. Single shared `db` instance.
- **`auth.ts`** — request authentication. Today: trusts `X-Merchant-Id` header.
  Eventually this becomes a real signed token; the header shape is a placeholder.
- **`dal/`** — data-access layer. The intent is that all order queries route
  through `ordersDal` so we have one place to add auditing, caching, tenancy
  filters, etc. All order queries, including the metrics routes, go through
  `ordersDal`. (Exception: the startup seed script `scripts/seed.ts` writes with
  `db` directly.)
- **`validation/orders.ts`** — pure request validators (no DB, no Express):
  `validateNewOrder` (POST body), `validatePageQuery` (`GET /api/orders`) and
  `validateSearchQuery` (`GET /api/orders/search`), plus `parseDollarsToCents`
  and `MAX_PAGE`. Routes stay thin: validate, then call the DAL.
- **`routes/`** — Express routers, one file per resource.
- **`lib/`** — utilities. Empty at the moment but reserved for shared helpers.

## Data model

Two tables: `merchants`, `orders`. See `db.ts` for the canonical DDL.

`orders.type` is one of `'sale' | 'refund'`. A refund row records that a sale
was reversed; it does not by itself reverse the sale row.

## Order search and pagination

Endpoints: `GET /api/orders/search` (filters) and `GET /api/orders` (range only);
both return `{ orders, page, page_size, total, total_pages }` (see `api.md`).
`/search` is declared before `/:id` in `routes/orders.ts` so it is not read as an id.

- **One query path.** `ordersDal.search(merchantId, filters, page, pageSize = PAGE_SIZE)`
  is used by both endpoints. A shared `buildWhere` assembles the WHERE clause from fixed
  fragments only (`merchant_id = ?` is always first, so tenancy cannot be skipped); every
  user value is a bound parameter. The `COUNT(*)` and the page `SELECT` use the same
  clause and run in one transaction, so `total` is the real match count and agrees with
  the page. Order: `created_at DESC, id DESC`. `PAGE_SIZE` (30) is a DAL constant, not
  client-configurable (`limit` is ignored).
- **Validation module.** The validators convert raw query strings into DAL filters:
  `amount` (dollars) to integer cents by digit parsing, `date` to UTC day bounds,
  `email` trimmed, `type` whitelisted. Repeated params (arrays) and bad values give 400
  `invalid_param`. `GET /api/orders` applies `from`/`to` only when both are present.
- **Email match.** `LIKE ... ESCAPE '\'` with `%`, `_` and `\` escaped, so wildcards in
  user input are literal. SQLite `LIKE` is case-insensitive for ASCII only.
- **Index.** `idx_orders_merchant_created ON orders(merchant_id, created_at, id)` in
  `db.ts` serves the merchant filter, the date range and the sort. The older
  `idx_orders_merchant` is now redundant with it but was left in place.
- **UTC day semantics.** `date=D` means `created_at >= 'D 00:00:00'` and
  `< '(D+1) 00:00:00'`, in UTC. The UI labels the column and the filter "(UTC)".
- **Mixed `created_at` formats (caveat).** Seeded and sample rows store ISO strings
  (`2026-05-01T10:42:35.656Z`), while rows inserted by `POST /api/orders` use SQLite
  `CURRENT_TIMESTAMP` (`2026-05-01 10:42:35`). `created_at` is compared as text, so the
  day bounds use the space form (`D 00:00:00`): `'T'` sorts after `' '`, so this is
  correct for both formats at day granularity. Ordering *within* a result that mixes both
  formats is by text and can be wrong for rows on the same day (not handled). The older
  `from`/`to` of `GET /api/orders` and `/api/revenue` are raw date strings and keep their
  pre-existing format quirks (see FINDINGS F7).
- **Unused DAL method.** `ordersDal.listByMerchant` is kept but no route uses it now.
  Note: `OrderFilters.from`/`to` in `ordersDal.search` apply independently of each
  other (per the DAL comment), but the `GET /api/orders` route passes a range only when
  both are given, so `from` or `to` alone is ignored at the route level.
- **Sample data.** `data/sample-orders.json` (2000 orders, both merchants) is used by the
  tests only; it is not loaded by `src/scripts/seed.ts` and there is no script to
  regenerate it.

### Frontend (`public/index.html`, `public/app.js`; static HTML + fetch)

- Orders section: filter form (date, email, type, amount in $), Search and Clear
  buttons, table, "Showing a-b of N" status line (`aria-live`), empty state, error
  paragraph and a pager (Prev, first/last and a window around the current page, Next).
- State is `appliedFilters` + `currentPage`. Filters apply on Search, not while typing.
  `loadOrders()` calls `/api/orders/search`; a `loadSeq` counter drops responses from
  superseded requests. If a page is past the end after data shrinks, it reloads the last
  page. Rows are built with `textContent` (no `innerHTML`, so emails are not injected).
- Client-side checks (future date, amount format) only give a friendly message; the
  server remains the authority. Switching merchant resets filters and reloads; the
  summary cards load separately in `refreshSummary()`.

## Open items

- ~~Wire `dashboard.tsx` once we pick a frontend framework~~ — went with static HTML+fetch instead. Doc stale.
- Decide whether `analytics-events` is its own service or a route here.
- Audit logging — TBD where it lives.
