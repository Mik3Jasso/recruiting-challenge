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
> **Status: answered by user; answers not recorded here - ask user to fill in.** (Original questions kept below for reference.)

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

## 2026-11-03 - Phase 2: bug fixes

### 9. Sandbox cleared (lead, at user's request)
- `Doc History.md` and `FINDINGS.md` copied into main `docs/` (untracked).
- Worktree `.sandbox/audit` removed; `main` left at `cbf80ec` (verified with `git log`).
- Branch `audit/orders-sandbox` intentionally **kept** (holds the earlier fixes); delete later with `git branch -D audit/orders-sandbox`. Both agents kept.
- Note: paths such as `audit/reconcile.ts` and the earlier commits referenced above now exist only on that branch.

### 10. Open questions answered (user)
- The user reported the open questions were answered; the answers were not stated in chat and are not recorded here.
- The three bugs chosen below are consistent with the earlier assumptions (refunds reduce revenue; a refund is not an order). This is an observation, not a confirmation of the answers.

### 11. Process rules for Phase 2 (user)
1. Three issues, each in its own branch `bugfix/problem<N>_<description>`, in its own git worktree under `.worktrees/problemN` (excluded via `.git/info/exclude`).
2. The dev agent may **not** commit or push.
3. The dev agent must run all tests (must pass) and follow best practices.
4. Before an issue is signalled resolved, a separate agent reviews it using the `code-review` skill.
5. The user reviews code and review results, then commits or requests improvements.
6. This document is updated per step.

### 12. Status (verified with `git worktree list` / `git branch`: only problem1 branch and worktree exist so far)
| # | Branch | Status | Tests | Code-review result | User commit |
|---|---|---|---|---|---|
| 1 | `bugfix/problem1_revenue-adds-refunds` | committed by user (`aef322d`) | 8/8 pass, tsc clean (lead re-ran) | approve with nits (code-review, medium) | committed by user: `aef322d` |
| 2 | `bugfix/problem2_post-orders-validation` | committed by user (`33343f4`) | 12/12 before rebase; 18/18 after rebase onto main, tsc clean | approve with nits (code-review, medium); nothing blocking | committed by user: `33343f4` |
| 3 | `bugfix/problem3_metrics-bypasses-dal` | committed by user (`d378e8a`) | 15/15 pass, tsc clean (lead re-ran) | approve with nits (code-review, medium); no blockers | committed by user: `d378e8a` |

### 13. Problem 1 - revenue adds refunds (`bugfix/problem1_revenue-adds-refunds`)
Worktree `.worktrees/problem1`. Verified: `git status --short` shows `M src/dal/orders-dal.ts`, `?? test/revenue.test.ts`, `?? .impeccable/`; nothing committed.
| Step | Who | Outcome |
|---|---|---|
| Tests first: `test/revenue.test.ts`, 6 tests | dev agent (resumed; no commit/push) | On old code 2 failed (refunds subtracted; refunds-only negative): pass 6 / fail 2 |
| Fix: `sumAmountByMerchant` in `src/dal/orders-dal.ts` uses `SUM(CASE WHEN type='refund' THEN -total_amount ELSE total_amount END)` plus doc comment (3 insertions, 2 deletions per `git diff --stat`) | dev agent | `npm test` 8/8, `tsc` clean. Revenue can be negative for refund-only ranges (intended, tested) |
| Re-run | lead | 8/8, tsc clean; nothing committed, staged or stashed |
| Independent read-only review (`code-review` skill, medium; reviewer could not edit/commit) | review agent | **Approve with nits** |

Untracked `.impeccable/hook.cache.json` appeared in the worktree: a tool cache, not created by the agents, not part of the fix, must not be committed.

Non-blocking review notes:
1. `POST /api/orders` does not validate type/sign, so an unknown type counts as a sale (= problem 2).
2. `metrics.ts` AVG/SUM still treat refunds as positive (outside scope; F2, problem 3).
3. Status ignored, `to` exclusive date-only, timestamp format mismatch (F7, pre-existing).
4. `docs/api.md:20` and `revenue.ts:9` should say "net of refunds, can be negative" - docs note recommended before merge.
5. Tests cover the DAL only, not the HTTP route.
6. Nit: unquoted test glob in `package.json`.

Next: user reviews code and review results, then commits or requests changes. Problems 2 and 3 pending.

#### Problem 1 outcome (2026-11-04)
The user committed it as `aef322d` on `bugfix/problem1_revenue-adds-refunds` with the message "Fix: summed total_amount for every row, but refounds subtract, test added" (message as written by the user). Verified with `git show --stat`: `src/dal/orders-dal.ts` (+3/-2) and `test/revenue.test.ts` (+62 new). `.impeccable/` left untracked. Note: `main` is now at `1be8a54` ("Docs finding, step 0", committed by the user; `Doc History.md` and `FINDINGS.md` are tracked there, working tree clean); the problem 1 branch was cut from `cbf80ec`.

### 14. Problem 2 - POST /api/orders accepts any number and any type (`bugfix/problem2_post-orders-validation`)
Worktree `.worktrees/problem2`, cut from `main` at `1be8a54`. Verified: `git status --short` shows `M src/routes/orders.ts`, `?? src/validation/`, `?? test/order-validation.test.ts`; nothing committed. `git diff --stat`: `src/routes/orders.ts` +5/-10.
| Step | Who | Outcome |
|---|---|---|
| Pure validator `src/validation/orders.ts`: `validateNewOrder(body: unknown)` returns `{ok,value}` or `{ok,detail}`; route made thin | dev agent (no commits allowed) | See rules below |
| Tests `test/order-validation.test.ts`: 10 tests (8 validator + 2 HTTP on a tiny express app with the real `ordersRouter`, in-memory DB, stub auth) | dev agent | Red-then-green: no validator -> `ERR_MODULE_NOT_FOUND`; validator + original route -> 12 tests, 11 pass, 1 fail (invalid-bodies HTTP test); new route -> 12/12 |
| Re-run | lead | `npm test` 12/12, tsc clean; nothing committed, staged or stashed |

Rules enforced: body is a non-array object; `customer_email` non-empty after trim (stored trimmed, no format check); `total_amount` safe integer > 0 (refunds also positive); `type` exactly `'sale'` or `'refund'`, default `'sale'`; only those 3 fields are read (`id`, `merchant_id`, `status` are server-set); failure returns 400 `{error:'invalid_body', detail}`.

Caveats: email not format-checked; no idempotency/duplicate protection; the old route's valid-body HTTP case already passed.

Recommended `docs/api.md` wording for `POST /api/orders` (recorded verbatim, **not applied**):
> Body: `{ customer_email, total_amount, type? }`. `customer_email`: non-empty string. `total_amount`: positive integer number of cents (refunds are also positive). `type`: `'sale'` (default) or `'refund'`. Other fields are ignored. `id`, `merchant_id` and `status` are set by the server. Returns 201 `{ order }`, or 400 `{ error: 'invalid_body', detail }`.

Independent read-only review (`code-review` skill, medium): **APPROVE WITH NITS**, nothing blocking. Reviewer ran `npm test` 12/12, tsc clean.
1. Non-blocking, cross-branch: validator comment at `src/validation/orders.ts:13-14` says the `type` column makes refunds reduce revenue; true only once problem 1's sign-aware SUM (`aef322d`) is merged. Merge problem 1 first or reword the comment.
2. Non-blocking: upper bound is `MAX_SAFE_INTEGER`; a SUM of ~1,000 such rows could overflow SQLite 2^63 (500 on revenue), and totals above 2^53 lose precision in JS. Consider a cap of ~1e12 cents.
3. Non-blocking, pre-existing: malformed JSON makes `express.json` throw and the global handler returns 500 `internal_error` instead of 400 (`src/server.ts:26-29`).
4. Nit: unused `raw` param in the `post()` helper at `test/order-validation.test.ts:89`, so there is no malformed-JSON test.
5. Nit: `docs/api.md:17` needs the new POST wording above.
6. Nit: no email length cap or format check.
Verified fine by reviewer: spread cannot override `id`/`merchant_id`/`status`; union narrows; `__proto__` key harmless; `type: null` rejected; HTTP tests use `:memory:`, port 0, `server.close()`; tests would fail on the old route.

Status: tests pass; code-review done (approve with nits); awaiting user review and commit. Problem 3 pending.

#### Updates (2026-11-04)
- **Problem 1 merged:** the user merged it into `main` as `d8581a3` (from `bugfix/problem1_revenue-adds-refunds`, commit `aef322d`).
- **Problem 2 rebased:** at the user's request the branch was rebased onto `main` (`git rebase --autostash main`). It had no commits of its own, only uncommitted work; autostash restored it; `git stash list` is empty. After the rebase `npm test` 18/18, tsc clean (per lead). This resolves review finding 1 (the validator comment about refunds is now true because problem 1 is in the base).
- **Problem 2 committed:** the user committed it as `33343f4` on `bugfix/problem2_post-orders-validation`, message "Fix: only checked typeof total_amount === 'number' and positive, test added" (as written by the user). Verified with `git show --stat`: `src/routes/orders.ts`, `src/validation/orders.ts`, `test/order-validation.test.ts`; 171 insertions, 10 deletions.
- **Open follow-ups (review items 2-6, NOT applied):** amount cap (~1e12 cents), malformed JSON returns 500 instead of 400, unused `raw` param in the test `post()` helper, `docs/api.md` POST wording, email length/format check.

### 15. Problem 3 - metrics bypasses the DAL (`bugfix/problem3_metrics-bypasses-dal`)
Worktree `.worktrees/problem3`, cut from `main` at `d8581a3` (verified: `git status --short` clean, no changes yet).
- Assignment to dev agent (no commits allowed): pure refactor. Move the metrics SQL into new `ordersDal` methods with identical outputs; characterization tests first.
- Out of scope, left alone: refund counting in metrics (F2), `limit` parsing, tenancy, dates.
- Dev agent fix (pure refactor): `src/routes/metrics.ts` no longer opens its own readonly `Database` connection (+3/-35); `src/dal/orders-dal.ts` gains `summaryByMerchant()` and `topCustomersByMerchant()` with exported types `OrderSummary`/`TopCustomerRow` (+41); the 3 summary queries merged into one; `Math.round` moved into the DAL; JSON shape, key order and numbers unchanged.
- Tests: new `test/metrics.test.ts`, 7 tests (5 HTTP characterization tests on a tiny express app with the real `metricsRouter`, in-memory DB, stub auth, port 0; 2 DAL tests). Red-then-green: before the refactor the file failed at import with "TypeError: In-memory/temporary databases cannot be readonly" (9 tests, 8 pass, 1 fail); after: 15/15. The old-code failure claim rests on reading the code plus the dev agent's run.
- Lead re-run: `npm test` 15/15, tsc clean; nothing committed, staged or stashed.
- Deliberately unchanged (still open): refund rows counted as orders/averaged and added in top-customers (F2), unvalidated `limit` (F9), tenancy (F4).
- Independent read-only review (`code-review` skill, medium): **APPROVE WITH NITS**, no blockers; 15/15, tsc clean. Equivalence checked against `git show main:src/routes/metrics.ts`; `new Database` now only in `src/db.ts:11`; no new write risk.
  1. Non-blocking: `docs/architecture.md:14` "Not all routes follow this yet - see `metrics.ts`" is stale. Recommended wording (not applied): "All order queries, including the metrics routes, go through `ordersDal`."
  2. Non-blocking: missing blank line before the new method at `src/dal/orders-dal.ts:77`.
  3. Non-blocking: `test/metrics.test.ts:55-63` pins refund behaviour; add "update when F2 lands" to the comment.
  4-6. Nits: shared in-memory db per file is fine; `get(): Promise<any>` and untested `limit=abc`/negative/ties (known, unfixed); the DAL comment "rows of every type" honestly documents the quirk.
- Status: tests pass; code-review done (approve with nits); awaiting user review and commit.

#### Problem 3 outcome
The user committed it as `d378e8a` on `bugfix/problem3_metrics-bypasses-dal`, message "Fix: metrics route bypassed the DAL with its own DB connection; route through ordersDal, tests added" (as written by the user). Verified with `git show --stat`: `src/dal/orders-dal.ts`, `src/routes/metrics.ts`, `test/metrics.test.ts`; 161 insertions, 35 deletions. Review nits NOT applied (kept in follow-ups): stale note at `docs/architecture.md:14`, blank line at `orders-dal.ts:77`, "update when F2 lands" comment in `test/metrics.test.ts`.

### Phase 2 summary
| # | Branch | Commit | State in git (verified) |
|---|---|---|---|
| 1 | `bugfix/problem1_revenue-adds-refunds` | `aef322d` | Merged into `main` via `d8581a3` |
| 2 | `bugfix/problem2_post-orders-validation` | `33343f4` | Branch only; not merged (not in `git branch --merged main`) |
| 3 | `bugfix/problem3_metrics-bypasses-dal` | `d378e8a` | Branch only; not merged |

- Worktrees `.worktrees/problem1`, `problem2`, `problem3` and branch `audit/orders-sandbox` still exist.
- `.impeccable/` (tool cache) was never committed; it is untracked in the problem 1 worktree.
- `main` is at `d8581a3`.

### Remaining follow-ups after Phase 2
- F2: metrics still count refunds as orders/averages and add them in top-customers.
- F4: `getById` has no merchant filter (tenancy).
- F5: auth trusts any `X-Merchant-Id` header.
- F7: date range (`to` exclusive, today excluded, timestamp format mismatch).
- F8: `from`/`to` alone silently ignored.
- F9: `limit` parsing (500s, negative returns all rows).
- F10: dashboard shows refunds as positive; `customer_email` unescaped.
- Problem 2 review items 2-6: amount cap, malformed JSON 500, unused `raw` test param, `docs/api.md` POST wording, email length/format.
- Problem 3 review nits: stale `docs/architecture.md:14` note, blank line at `orders-dal.ts:77`, "update when F2 lands" test comment.
- Docs: `docs/api.md` (POST wording, metrics fields) and `docs/architecture.md` (line 14 wording, `lib/`, `dashboard.tsx`) updates.

## 2026-11-04 - Phase 3: feature "search orders" (`feature/search-orders`)

Status at the time of writing: **Awaiting user review; nothing committed.** Verified by the doc agent: branch `feature/search-orders`; `git status --short` shows `M public/app.js`, `M public/index.html`, `M src/dal/orders-dal.ts`, `M src/db.ts`, `M src/routes/orders.ts`, `M src/validation/orders.ts`, and untracked `data/`, `test/orders-search.test.ts`, `test/search-validation.test.ts`. Doc agent re-ran `npm test`: 69/69 pass; `npx tsc --noEmit`: exit 0.

### 16. Feature request and user decisions (Q&A)
Request: add search/filter to the orders list in the dashboard (date, customer email, type, amount) with pagination of 30 per page. Decisions recorded from the user's answers (as relayed by the lead):
| Question | Decision |
|---|---|
| Endpoint | `GET /api/orders/search` |
| Amount | exact match, entered in **dollars** |
| Date | a single day, **UTC**; a future date is accepted and returns empty results |
| Email | "contains", case-insensitive |
| Display note | the shown `total` must be the **real count** (e.g. 31 matches => 30 on page 1 + 1 on page 2) |
| Paging | also on `GET /api/orders` |
| Response | includes `page` and `total` |
| Sample data | a JSON file used **only by tests**; no seed script |
| Workflow | same as before: branch `feature/search-orders`, coding agent does not commit, tests must pass, a separate code-review agent reviews, the user commits |

### 17. Implementation (coding agent; no commits)
Files (`git diff --stat`, tracked files only): `public/app.js` (+219/-), `public/index.html` (+54), `src/dal/orders-dal.ts` (+77), `src/db.ts` (+2), `src/routes/orders.ts` (+35/-), `src/validation/orders.ts` (+111); total 6 files, 470 insertions, 28 deletions. New untracked: `test/orders-search.test.ts`, `test/search-validation.test.ts`, `data/sample-orders.json`.
- DAL: `PAGE_SIZE = 30`, `OrderFilters`, shared `buildWhere`, `ordersDal.search()` (COUNT + page in one transaction, `ORDER BY created_at DESC, id DESC`).
- Validation: `validateSearchQuery`, `validatePageQuery`, `parseDollarsToCents`, `MAX_PAGE`.
- Routes: `GET /api/orders/search` (declared before `/:id`); `GET /api/orders` now paged. Response `{orders, page, page_size, total, total_pages}`.
- DB: new index `idx_orders_merchant_created ON orders(merchant_id, created_at, id)`.
- Frontend: filter form, Search/Clear, table, status line, empty/error states, pager.
- Sample data: `data/sample-orders.json`, 2000 orders (verified by doc agent: acme 1206 = 1053 sale + 153 refund; bistro 794 = 696 sale + 98 refund; `created_at` from 2025-11-04T02:55:00.973Z to 2026-11-03T22:30:24.101Z, ISO format). It is read by `test/orders-search.test.ts` only; `src/scripts/seed.ts` (pre-existing, run at server start) does not load it.

Decisions the coding agent flagged (not asked of the user):
1. Mixed `created_at` formats (seed/sample ISO `T...Z` vs SQLite `CURRENT_TIMESTAMP` `YYYY-MM-DD HH:MM:SS`): the day bounds use the space form (`D 00:00:00`), which works for both at day granularity.
2. `total_pages` is 0 when there are no results.
3. `MAX_PAGE = 1,000,000` was chosen by the agent (no user input).
4. `ordersDal.listByMerchant` kept but now unused.
5. Case-insensitivity is ASCII only (SQLite `LIKE`).
6. `amount=12.500` (3 decimals) is rejected.
7. The generator script for the sample JSON was not kept, so the file cannot be regenerated.

### 18. TDD evidence
- Red: the new test files first failed on the missing exports `PAGE_SIZE` and `parseDollarsToCents` (2 test files failing). (As reported by the coding agent; the red run was not repeated by the doc agent.)
- Green: after the implementation `npm test` 69/69, `tsc` clean. Verified independently by the orchestrator; re-verified by the doc agent (69/69, `tsc --noEmit` exit 0).
- Coverage highlights (from test titles): 31 matches => 30 + 1 with `total` 31 and `total_pages` 2; exactly 30 is one page; page beyond last is empty with real total; LIKE wildcards literal; SQL in email treated as data; tenancy; date on both timestamp formats; sample data: walking all pages yields every row once, filters vs an in-memory oracle, a merchant+day with 31+ orders.

### 19. Manual UI check (lead)
Server on port 3055 with a temporary DB, driven in the in-app browser. **No screenshots were taken and no screen reader was used**, so visual polish and assistive-technology behaviour are unverified. (Details as reported by the lead; not re-run by the doc agent.)

### 20. Breaking changes for `GET /api/orders` consumers
- Response gains `page`, `page_size`, `total`, `total_pages`.
- Paginated: 30 rows per page (previously default 100).
- `limit` is now ignored (previously honoured; earlier behaviour for bad values is in F9).
- A bad `page` returns 400 `invalid_param`.
- Unchanged: `from`/`to` apply only when **both** are given (verified in `src/routes/orders.ts`; one alone is ignored).
- The dashboard "Recent orders" list (previously `limit=10`) became a searchable, paged "Orders" table.

### 21. Independent code review (`code-review`, separate agent, read-only)
Verdict: **APPROVE WITH NITS; nothing blocking.** All findings below are **NOT applied and await the user's decision.** (Severity and fixes as given by the reviewer; the doc agent confirmed items 1, 4, 5, 6 and 7 by reading the code, the rest are reviewer claims.)
| # | Severity | Finding | Suggested fix |
|---|---|---|---|
| 1 | MEDIUM | `refreshSummary` in `public/app.js` has no stale-response guard and swallows errors (`.catch(() => {})`); a merchant switch can show the previous merchant's summary cards, and failures are silent | Add a sequence guard like `loadSeq`; show an error state |
| 2 | LOW-MED | Client `AMOUNT_RE` (`/^\d+(\.\d{1,2})?$/`) allows more than 12 integer digits while the server caps at 12; the resulting 400 wipes the table (`showLoadError` clears rows) | Cap digits client-side (`\d{1,12}`); keep the old rows on a 400 |
| 3 | LOW | Ordering across mixed `created_at` formats is not handled (text comparison; `T` sorts after space within the same day) | Normalise `created_at` on insert, or order by `datetime(created_at)` (index trade-off) |
| 4 | LOW | `idx_orders_merchant` is redundant with the new `idx_orders_merchant_created` | Drop it in a later change |
| 5 | LOW | `limit` is silently ignored; the DAL comment says `from` is applied independently while the route requires both | Document (done in `api.md`) or reject `limit`; align the comment |
| 6 | LOW | `MAX_PAGE` 1,000,000 x 30 allows a large `OFFSET` (slow deep scans) | Lower the cap or use keyset paging |
| 7 | NIT | Date input `max` is set once at load and goes stale after midnight UTC; `aria-describedby` is only on the amount input | Refresh `max` on submit; add `aria-describedby` to the others |
| 8 | NIT | No tests for repeated params over HTTP, or for the fixed page size vs `?limit`/`?page_size` on `/search` | Add the tests |

### 22. Documentation (doc agent)
- `docs/api.md`: documented `GET /api/orders/search`; updated `GET /api/orders` (paginated, `page`, `limit` ignored, `from`/`to` need both, breaking-change note). Also applied two trivial stale items: the `POST /api/orders` wording recorded in step 14, and "net of refunds, `from`/`to` required, `to` exclusive" for `/api/revenue`. Metrics endpoints still say "TODO: document fields".
- `docs/architecture.md`: added the search/pagination design and frontend sections; added `validation/orders.ts` to Modules; replaced the stale line "Not all routes follow this yet - see `metrics.ts`" with "All order queries, including the metrics routes, go through `ordersDal`" after verifying `src/routes/metrics.ts` imports only `ordersDal` (the seed script is the one place that writes with `db` directly). `lib/` and `dashboard.tsx` stale items left as they were (out of scope).

### Open follow-ups after Phase 3
- Review findings 1-8 above (awaiting the user's decision).
- Sample JSON cannot be regenerated (generator not kept).
- Unverified: visual/accessibility behaviour of the UI (no screenshots, no screen reader); the red test run (reported, not re-run).
- Still open from earlier phases: F2, F4, F5, F7, F8, F9, F10 and the Phase 2 review items.
- Correction: all three `bugfix/problem*` branches (`aef322d`, `33343f4`, `d378e8a`) were later merged into `main` with `--no-ff`, keeping their commits, and the branches and worktrees were removed. `main` was at `7970a94` when Phase 3 started. The "not merged" status in the Phase 2 summary table is historical.
- Status: **Awaiting user review; nothing committed.**

## How to update this document
Append a new `## YYYY-MM-DD` heading (use the actual date) below the last entry, then one entry per step containing:
- **What** - the action in one line.
- **Who** - lead / senior agent / doc agent.
- **Commands / commits** - exact commands run and commit hashes (`git log --oneline`).
- **Outcome** - result, including test/tsc status and anything unverified.

Rules: never edit past entries (add a correction entry instead); state only what was verified; link to `audit/FINDINGS.md` for finding details rather than copying them.

## 2026-11-06 - Phase 4 - documentation refresh

Branch `main` (clean at start; search/pagination merged as `43be26f`). Status: **Awaiting user review; nothing committed.** Only `docs/api.md`, `docs/architecture.md` and this file were edited.

### 23. Request and decisions (user)
- Request: make `docs/api.md` and `docs/architecture.md` accurately describe the system as it is today, verified against the code.
- Questions asked and the user's answers (final):
  1. Document actual behaviour or the intended behaviour from FINDINGS? **Actual behaviour**, plus a clearly labelled "Known limitations" section in each doc pointing to FINDINGS IDs (F2, F4, F5, F7/F8, F9, mixed `created_at` formats, unused `listByMerchant`, ignored `limit`, redundant index, and the unfixed `public/app.js` review nits), verified first and stated neutrally.
  2. `architecture.md`: remove the "DRAFT" banner and stale open items (`dashboard.tsx`, `analytics-events`); keep "Audit logging - TBD" and add the real open work; add request flow, dashboard, run/seed/test and data-model sections.
  3. `api.md`: remove the "Quick-and-dirty" banner; add conventions; document every endpoint (including health, `/:id`, POST, revenue and both metrics endpoints) with real example responses; add Known limitations.
  4. This history: append a new section with request, Q&A, changes, verification and unverified items.

### 24. Changes (doc agent)
- `docs/api.md`: rewritten. Banner removed. Added Conventions and an Errors table (401 `missing_merchant_id`, 400 `invalid_param` / `invalid_body` / `missing_date_range`, 404 `not_found`, 500 `internal_error`). Added the previously missing or TODO sections: `GET /api/health`, `GET /api/orders/:id` (real tenancy behaviour), `GET /api/revenue` fields, `GET /api/metrics/summary` and `GET /api/metrics/top-customers` (each field defined as the SQL computes it, `limit` behaviour table). Real example responses and curl lines throughout. Added Known limitations L1-L11.
- `docs/architecture.md`: rewritten. "DRAFT" banner, `lib/` bullet and the stale open items removed. Added Request flow diagram, Modules table, full Data model (columns, three indexes, cents, refunds stored positive, `status` values, both `created_at` formats, pragmas), Dashboard section (cards to endpoint/field, merchant switcher, orders panel, 30-day window, UTC), Run/seed/test section (scripts, `PORT`, `DB_PATH`, WAL files, seeding, reseed, per-file test table), Known limitations (11 items) and Open items. Search/pagination text kept after re-verification, de-duplicated against api.md.
- Old claims the code contradicted: api.md "All endpoints require the `X-Merchant-Id` header" (`/api/health` does not); architecture.md mentioned a `lib/` directory (none exists in `src/`); metrics were undocumented, and `/api/orders/:id` had no description of its (absent) tenancy check. Related, FINDINGS marks F2 as FIXED (sandbox branch) while `main` still counts all rows (`test/metrics.test.ts` pins this); the docs follow `main`.

### 25. Verification (doc agent)
- Read in full: `src/server.ts`, `src/auth.ts`, `src/db.ts`, `src/dal/orders-dal.ts`, `src/routes/*.ts`, `src/validation/orders.ts`, `src/scripts/seed.ts`, `public/index.html`, `public/app.js`, `package.json`, `tsconfig.json`, `test/*.test.ts` (structure and test names), `data/sample-orders.json` (shape and counts via a node one-liner), `docs/FINDINGS.md`, this file.
- Ran the server on a throwaway DB under the session scratchpad (`DB_PATH=<scratchpad>/live/t.db PORT=3077 npx tsx src/server.ts`); never touched `data/dashboard.db`. Probed with curl and recorded: health 200; missing and empty header 401; `page=0` 400; `limit` ignored on `/api/orders`; `/api/orders/:id` for an `m_acme` order returned 200 with `X-Merchant-Id: m_bistro` and with an unknown id `nobody` (F4 confirmed); unknown id 404; POST valid 201 (`created_at` in space format), negative amount 400, malformed JSON 500, unknown merchant 500; `/api/revenue` normal and missing `to` (400); `from` alone on `/api/orders` ignored (all rows) and `to` exclusive (a row created on the `to` day excluded); summary values hand-checked against `sqlite3` (41 rows, 4 customers, average 10235.3 rounds to 10235); top-customers `limit` = `2`, `0`, empty, `-1`, `1e9`, `abc`, `1.5`, `Infinity`, repeated, ` 3`; unknown merchant gets zeros/empty lists; unknown `/api/nope` returns HTML 404; `/` served as HTML. `PRAGMA index_list(orders)` showed the three indexes plus the primary key.
- Server stopped (`pkill`), temp directory deleted.
- `npm test`: 69 tests, 69 pass, 0 fail (10 + 7 + 2 + 29 + 15 + 6 across 6 files). `npx tsc --noEmit`: exit 0.
- `git status --short` at the end shows only `docs/api.md`, `docs/architecture.md`, `docs/Doc History.md`.

### 26. Unverified (doc agent)
- Browser behaviour was verified by reading `public/app.js` only (no screenshots, no screen-reader or manual UI run). The stale-response race in `refreshSummary()` is inferred from the code, not reproduced.
- Large-table performance of deep `OFFSET` pages (`MAX_PAGE`) is not measured.
- FINDINGS F10-F12 (innerHTML, test tooling) were not re-checked beyond what is stated in the docs; F10's `innerHTML` claim no longer matches `app.js` (rows use `textContent`).
- Earlier entries in this file are left as written, including statements that are now stale (for example step 22 "Metrics endpoints still say TODO").
