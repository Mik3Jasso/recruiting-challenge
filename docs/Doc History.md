# Doc History - Order Audit

Chronological record of every step in the order audit (goal: verify the **total number of orders** and their **amounts**). Branch: `audit/orders-sandbox`, worktree `.sandbox/audit`. Baseline commit: `cbf80ec`. Date of all work: 2026-11-03.

Legend for "who": **lead** = orchestrating agent, **senior agent** = senior full-stack auditor, **doc agent** = author of this file.
Details of every finding live in `audit/FINDINGS.md`; this file is the process log.

## 2026-11-03

### 1. Request (user)
- Asked for a secure sandbox, a senior full-stack agent familiar with `docs/architecture.md` (typed as "architecture.dm"; the real file is `.md`) and `docs/api.md`, and then this documentation task.

### 2. Sandbox setup (lead)
| Step | Command / action |
|---|---|
| Hide sandbox from git | `echo '.sandbox/' >> .git/info/exclude` |
| Isolated worktree | `git worktree add -b audit/orders-sandbox .sandbox/audit HEAD` |
| DB copies | `data/dashboard.db` copied to `data/audit-snapshot.db` (`chmod 444`) and `data/audit.db` |
| Dependencies | `npm ci` |
| Verification (as reported by lead) | `npm test` 2/2; server on `PORT=3901 DB_PATH=data/audit.db`; health OK; original repo clean |

**Known caveat (verified in the repo):** `dashboard.db` is 4 KB and its data lives in the `-wal` file, which was not copied. `data/audit-snapshot.db` therefore has no tables (FINDINGS F12) and cannot serve as a reference. The server auto-seeded `audit.db`, so all audited figures come from a freshly seeded DB that is **not proven identical** to the user's real database. Re-snapshot with `sqlite3 <src> ".backup <dst>"` was recommended, not done.

### 3. Senior-agent audit
- Scope: totals of orders and amounts. Rules: work only in the sandbox, read-only on the DB snapshot, no writes to the parent checkout.
- Sequence: read docs and source; ran `npm test` and `tsc`; read-only sqlite queries; wrote `audit/reconcile.ts`; ran the server on port 3901; probed the API; stopped the server; made fixes and commits; re-ran the reconciliation; wrote `audit/FINDINGS.md`.
- Incident: a broad `pkill` was denied by permissions; the server was stopped by PID instead.
- Run recipe (from FINDINGS): `DB_PATH=data/audit.db PORT=3901 npx tsx src/server.ts`, then `DB_PATH=data/audit.db npx tsx audit/reconcile.ts`.

### 4. Results (amounts in cents; from `data/audit.db`)
| Merchant | Rows | Sales | Refunds | Gross sales | Refunds | Net | Original API revenue | Original `total_orders` | Original AOV vs expected |
|---|---|---|---|---|---|---|---|---|---|
| m_acme | 40 | 38 | 2 | 361,225 | 18,888 | 342,337 | 380,113 | 40 | 9,503 vs 9,506 |
| m_bistro | 40 | 34 | 6 | 398,243 | 46,683 | 351,560 | 444,926 | 40 | 11,123 vs 11,713 |

Original revenue was overstated by exactly 2x refunds (acme 37,776; bistro 93,366). Refund rows store positive amounts. After fixes: revenue = net, `total_orders` = 38 / 34, AOV = 9,506 / 11,713.

### 5. Findings
| ID | Sev | Finding | Status |
|---|---|---|---|
| F1 | CRITICAL | `orders-dal.ts:54` revenue adds refunds instead of subtracting | Fixed |
| F2 | HIGH | Metrics count refunds as orders and in averages; top-customers adds refunds | Fixed |
| F3 | HIGH | `metrics.ts` bypasses the DAL with its own DB connection | Fixed |
| F4 | HIGH | `GET /api/orders/:id` has no merchant filter (cross-tenant read) | Not fixed |
| F5 | HIGH | Auth trusts any `X-Merchant-Id` header | Not fixed |
| F6 | HIGH | `POST /api/orders` accepted negative/zero/float amounts and any `type` | Fixed |
| F7 | MEDIUM | `to` is exclusive and date-only, so today is excluded; `CURRENT_TIMESTAMP` format differs from seeded rows; bistro 30-day card 87,041 vs 95,732 expected | Not fixed |
| F8 | MEDIUM | `from` or `to` alone is silently ignored | Not fixed |
| F9 | MEDIUM | `limit`: `abc`/`1.5` give 500, `-1` returns all rows, empty gives 0 rows | Not fixed |
| F10 | MEDIUM | Dashboard shows refunds as positive amounts; `customer_email` inserted unescaped | Not fixed |
| F11 | LOW | Dashboard card semantics; no client-side summing of truncated lists (no defect found) | n/a |
| F12 | LOW | Test coverage/tooling; snapshot DB empty (see caveat) | Tests added; snapshot not fixed |

Note: in FINDINGS, F11 is "dashboard card semantics" and F12 combines test coverage with the empty snapshot DB. F6 is only partly fixed: `status` is hard-coded and email is not format-checked.

### 6. Commits on `audit/orders-sandbox` (from `git log`, all dated 2026-11-03)
| Hash | Message |
|---|---|
| `8e3a1a8` | Add read-only orders reconciliation script and baseline output |
| `50eab10` | Fix revenue to be net of refunds (subtract refund rows instead of adding them) |
| `d3de84c` | Fix metrics: count only sales as orders, net top-customer spend, route through DAL |
| `d92216f` | Validate POST /api/orders: positive integer cents, type must be sale or refund |
| `a6a1931` | Make validateNewOrder a type guard so tsc passes |
| `13a3ce6` | Narrow POST body via validateNewOrder type guard (fixes tsc) |
| `6486645` | Add audit FINDINGS.md and post-fix reconciliation output |

`a6a1931` was committed while `tsc` still failed (per lead); `13a3ce6` fixed it. I did not re-check `tsc` at `a6a1931`.
`git diff cbf80ec --stat` at the time of writing: 9 files, +451/-44 (`audit/` x4 new, `src/dal/orders-dal.ts`, `src/routes/metrics.ts`, `src/routes/orders.ts`, `test/revenue.test.ts`, `test/validation.test.ts`).
**Verification re-run by doc agent at `6486645`:** `npm test` 7/7 pass; `npx tsc --noEmit` exit 0. (Lead reported the same.)

### 7. Open questions for the user
1. Do refunds reduce revenue? Assumed **yes** (net = sales - refunds). If revenue means gross sales, change F1 fix to `WHERE type='sale'`.
2. Is a refund an order? Assumed **no** (count = sale rows only).
3. Which statuses count? No filter added (all 80 rows are `completed`).
4. Should `to` include the whole day, and in which timezone is a "day" defined?
5. Should `getById` return 404 for other merchants' orders (F4)? Assumed yes, not changed.
6. Currency and non-`completed` statuses on POST are not modelled (FINDINGS question 5).

### 8. Documentation drift (recorded only; `docs/architecture.md` and `docs/api.md` NOT modified)
| Doc | Drift | Recommended update |
|---|---|---|
| `api.md` | `/api/metrics/summary` and `/top-customers` are listed but only "TODO: document fields". No documentation of validation rules (F6), 404/400 behaviour, `limit` semantics, or that `from`/`to` must be used together and `to` is exclusive. | Document fields, count/net semantics (sales-only count, refunds subtract), date-range rules, error codes. |
| `architecture.md` | Says not all routes use the DAL "see `metrics.ts`"; this was true until the F3 fix, now outdated. | Remove the caveat or state that all order queries go through `ordersDal`. |
| `architecture.md` | `lib/` described as "Empty at the moment"; the directory does not exist in the repo. | Remove or create the directory. |
| `architecture.md` | `dashboard.tsx` item is already struck through and marked stale (static HTML+fetch is used). | Delete the stale item. |
| `architecture.md` | Refund semantics ("does not by itself reverse the sale row") conflict with revenue now being net of refunds; no link between refund and sale exists. | State the net-revenue rule once the user answers questions 1-2. |

Discrepancy vs the task brief: the brief said the metrics endpoints are undocumented; the repo lists them with TODO placeholders only.

## How to update this document
Append a new `## YYYY-MM-DD` heading (use the actual date) below the last entry, then one entry per step containing:
- **What** - the action in one line.
- **Who** - lead / senior agent / doc agent.
- **Commands / commits** - exact commands run and commit hashes (`git log --oneline`).
- **Outcome** - result, including test/tsc status and anything unverified.

Rules: never edit past entries (add a correction entry instead); state only what was verified; link to `audit/FINDINGS.md` for finding details rather than copying them.
