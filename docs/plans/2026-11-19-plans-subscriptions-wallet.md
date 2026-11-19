# Plan: drop AI credits → monthly comments, subscriptions with trial + yearly billing, client wallet

Status: **approved 2026-11-19** (decisions PW-D1…PW-D16 answered by the user; rows in `docs/progress/TASKS.md`, section "Plans, subscriptions & wallet (PW)"). The Module 5 orchestration run is paused at M5-T16 (live golden bake-off); this work runs **before** M5-T16 and M5-GATE.

Row prefix: **PW** (Plans & Wallet). It pulls the subscription part of Module 8 forward; SSLCommerz payments, renewals, the landing pricing cards and `/billing` stay in Module 8.

---

## 1. Decisions (user, 2026-11-19)

| # | Topic | Decision |
|---|---|---|
| PW-D1 | Limit model | **Drop AI credits entirely.** The limit is **monthly comments**: each comment counts **1**, whatever context level (D8) the client chose. |
| PW-D2 | Edits | A comment counts **once**; AI re-checks after edits are free. |
| PW-D3 | Wallet | **One wallet per client (billing) account**, built for several metered limits ("meters"). Today only `monthlyComments`; later e.g. auto-replies, lead capture. The structure must allow **top-ups / extra limit for a month later**, but **no top-up feature now**. |
| PW-D4 | Reset time | Resets **monthly on the billing date** (started on the 15th → every 15th, at the same time of day, clamped to month end: started on the 31st → Feb 28/29). **Yearly plans also reset monthly.** The reset time is **stored** and shown. |
| PW-D5 | Billing interval | **Monthly and yearly.** Yearly = an **exact per-month price per plan** set by the admin (e.g. ৳500 monthly vs ৳450/month yearly, charged ৳5,400 up front). The card always shows the **monthly** figure. |
| PW-D6 | Launch offer | **Keep** the struck list price + badge (~~৳999~~ ৳499 "50% Launch Offer"), next to the monthly / yearly prices. |
| PW-D7 | Free plan | **Removed.** No Free plan. The `free` row is **deactivated** (`is_active = false`), not deleted: old plan-audit rows point to it. |
| PW-D8 | Trial | **Starter trial at signup**, automatic, once per client account, no payment. The trial length is **admin-adjustable** (presets 3 / 7 / 14 / 30 days; seed **7**); a change applies only to **new** trials: started trials keep their stored end date. |
| PW-D9 | Expiry | When a trial or paid term ends unpaid, **AI moderation pauses**: new comments stay visible and are stored as skipped `no_active_plan`; pages stay connected; login works; a "Choose a plan" banner shows. Nothing is deleted. |
| PW-D10 | Workspace limit | Plans get a **workspace limit** (`limits.workspaces`, seed **1 / 3 / 10** for Starter / Growth / Pro): a higher plan lets the client add more workspaces. |
| PW-D11 | Pooling | The plan belongs to the **client account** (the owner who pays) and its limits are a **shared pool** across all its workspaces: comments, connected pages, team seats, workspaces. |
| PW-D12 | Trial allowance | The trial gets a **smaller comment limit: 300**, admin-editable (`plans.trial_comment_limit`). All other trial limits are Starter's. (Replaces the draft default "full Starter limits".) |
| PW-D13 | Yearly seed | Yearly per-month prices seeded **10% under the monthly price, rounded down to whole taka**: Starter ৳449, Growth ৳1,349, Pro ৳3,599 (editable). |
| PW-D14 | Plan edits | A changed plan limit applies **from each client's next reset** (the wallet stores the amount granted per period). Prices are copied onto the subscription, so a price change never changes a running term. |
| PW-D15 | Existing data | The migration gives every existing client account a **fresh Starter trial** (dev data only today). |
| PW-D16 | Manual activation | **Admin "activate plan manually" action now** (for clients paying offline): the super admin picks plan + monthly/yearly + start date for a client; audit-logged. Row **PW-T9**. |

Smaller rules that follow from the decisions (planner's reading, confirm if wrong):
- **Workspace limit without a live plan:** clients keep their existing workspaces but can't create new ones (403 `no_active_plan`).
- **A trial is one wallet period** (`[started_at, trial_ends_at)`), granted `trial_comment_limit` (fallback: Starter's `monthlyComments`) at trial start, so a trial-limit change applies to new trials only, like `trial_days`.
- **Trial plan = the plan with slug `starter`.** Trial fields (`trial_days`, `trial_comment_limit`) are accepted only on that plan; `trial_days = null` means "no trial" (new sign-ups then start without a plan).

---

## 2. What exists today (analysis)

### Data
| Object | Where | Today | Fate |
|---|---|---|---|
| `plans` | `backend/src/db/schema/plans.ts` | 4 rows `free/starter/growth/pro` (`is_active` column exists). `original_price_bdt`, `offer_price_bdt`, `offer_badge`, `feature_config` (jsonb: `limits {connectedPages, monthlyAiCredits, teamSeats}` + 7 feature flags). Edited in `/admin/settings`, audited in `plan_audit_logs`. | Add `yearly_monthly_price_bdt`, `trial_days`, `trial_comment_limit`, `limits.workspaces`; rename `monthlyAiCredits` → `monthlyComments`; deactivate `free`. |
| `workspaces.plan_id` | `schema/workspaces.ts` | Nullable, **never written** (null = Free plan via `FALLBACK_PLAN_SLUG = 'free'` in `src/meta/social-pages.queries.ts`). | Replaced by workspace → `billing_account` → live `subscription` → plan. Dropped in PW-T6b after the last reader switches. |
| `monthly_credit_usage` | `schema/credits.ts`, migration 0019 | Credits used per workspace per **Dhaka calendar month**. | Dropped in PW-T6b (last reader: admin clients `credits`). Replaced by the wallet tables. |
| `comments.credits_charged` | `schema/comments.ts` | Credits charged per comment, including re-checked edits. | Replaced by `usage_counted_at` (counted once); dropped in PW-T4. |
| `daily_ai_usage.credits` | `schema/moderation.ts` (default 0) | Credits per day / provider / model (admin AI card). | No longer written from PW-T4; dropped in PW-T6b with the admin DTO field (tokens, cost and calls remain). |
| `CONTEXT_LEVEL_CREDITS` | `moderation/moderation.constants.ts` | `comment_only` 1, `page_name` 1, `post_caption` 2. | Removed. Context levels stay (D8), with no effect on counting. |
| Skip reason `credits_exhausted` | `moderation/comment-moderation.rules.ts` | Out of credits → `SKIPPED`. | Becomes `comment_limit_reached`, plus a new `no_active_plan`. |

### Code that reads credits or plans
- **Backend:**
  - `src/credits/*`: `CreditService` (reserve / release / usage / usageMany, guarded single-statement upsert) and `credit-period.ts` (Dhaka month key).
  - `src/moderation/comment-moderation.service.ts`: reserve before the AI call, release when the LLM was never reached, warn once a day.
  - `src/moderation/classifier-input.ts`: `classificationCreditCost`.
  - `src/moderation/moderation-policy.service.ts`: reads the plan's feature flags through `findPlanFeatureConfig` (workspace `plan_id`, Free fallback).
  - `src/meta/social-pages.*`: `connectedPages`, per workspace, with the Free fallback.
  - `src/admin/admin-clients.service.ts` + `src/admin/client-list-query.ts`: plan badge, **`plan=<slug>|none` filter on `workspaces.plan_id`** (found while planning), credits bar data.
  - `src/admin/admin-dashboard.service.ts`: **`planTiers` = ACTIVE workspaces per `workspaces.plan_id`** (found while planning).
  - `src/admin/ai-usage-summary.ts` and `dto/system-health.dto.ts`: credits in the AI card.
  - `src/admin/plan-rules.ts`, `dto/plans.dto.ts`, `admin-plans.service.ts`: plan editor and audit (`LEGACY_PLAN_LIMIT_KEYS`).
  - `src/scripts/golden-suite.ts` and `golden-replay.ts`: credit numbers in reports.
- **Admin:**
  - `lib/admin-plans.ts`, `components/settings/plan-editor-card.tsx`: credits field.
  - `lib/admin-clients.ts`, `routes/_authed/admin/clients.tsx`: credits bar, plan filter.
  - `lib/admin-system.ts`, `routes/_authed/admin/system.tsx`: credits in the AI card.
  - `lib/admin-plan-audit.ts`: field labels.
  - `lib/admin-ai-settings.ts`.
- **Client:** `lib/moderation-policy.ts` and `components/moderation/ai-analysis-card.tsx` show "1 / 1 / 2 credits" per context level.
- **Tests:** about 20 spec / e2e / UI test files mention credits (`backend/test/credits.e2e-spec.ts`, `comment-moderation.e2e-spec.ts`, `admin-clients.e2e-spec.ts`, `admin-system.e2e-spec.ts`, `admin-settings.e2e-spec.ts`, `moderation-schema.e2e-spec.ts`, admin `-clients` / `-system` / `-settings` tests, client `-pages-ai-analysis.test.tsx`, …).
- **Not built yet** (nothing to undo): a public plans endpoint, pricing cards, `/billing`, the `subscriptions` and `payment_transactions` tables, and seat enforcement (Module 7 invites).
- **Workspace creation:** `src/auth/first-workspace.ts` (`resolveActiveWorkspace`, run from `databaseHooks.session.create.before`; the Drizzle adapter runs **without transactions**) makes the first workspace at sign-up. Better Auth `/organization/create` makes more; today only impersonation blocks it.

---

## 3. Target design

### 3.1 Billing account (the "client")
`billing_accounts`:
- `id`
- `owner_user_id`: FK to user, **unique**, restrict.
- timestamps

`workspaces.billing_account_id` (FK restrict, indexed) is set when a workspace is created: the creator's account, made on first use (create-or-get by user id). A workspace keeps its account for life; ownership transfer is out of scope. The column **stays nullable in the DB**: a workspace without any member can't get an account (`owner_user_id` is NOT NULL); the app treats a workspace without an account as "no live plan".

### 3.2 Plans
- **Keep:**
  - `original_price_bdt`: the struck list price.
  - `offer_price_bdt`: the monthly price; if null, the monthly price is the original.
  - `offer_badge`.
- **Add `yearly_monthly_price_bdt`** (int, nullable, ≤ the monthly price): the per-month price when billed yearly. `null` means no yearly option.
- **Add `trial_days`** (int, nullable, 1–90; the admin UI offers 3 / 7 / 14 / 30): only Starter has it (seed 7). `null` means no trial.
- **Add `trial_comment_limit`** (int, nullable, 0 … the `monthlyComments` max; seed **300** on Starter, PW-D12): the comment grant of a trial. Accepted only on Starter, beside `trial_days`; `null` = fall back to Starter's `monthlyComments`.
- **`feature_config.limits`:**
  - `monthlyComments`: renamed back. The `LEGACY_PLAN_LIMIT_KEYS` map is flipped (`monthlyComments` ← `monthlyAiCredits`) so old configs and audit rows still read.
  - `connectedPages`
  - `teamSeats`
  - **`workspaces`** (new): seed 1 / 3 / 10 for Starter / Growth / Pro, editable.
- **One price helper** for every screen, `planPrice(plan, interval)`, returns:
  - `{ perMonthBdt, chargedBdt, listPerMonthBdt, badge }`
  - Monthly: per month = the offer price or the original; charged = per month.
  - Yearly: per month = `yearly_monthly_price_bdt`; charged = per month × 12 (e.g. ৳449 → ৳5,388).
- The `free` row gets `is_active = false`; inactive plans are hidden from the editor list and from `GET /api/plans` (audit history still shows their old rows).

### 3.3 Subscriptions (now; Module 8 adds payments on top)
`subscriptions`:
- `billing_account_id`, `plan_id`
- `interval`: `month` | `year`
- `status`: `TRIALING` | `ACTIVE` | `EXPIRED` | `CANCELED`
- `started_at`
- `trial_ends_at`: a snapshot, never recomputed (null unless TRIALING).
- `current_term_start`, `current_term_end`: the paid term; for a trial, the end is `trial_ends_at`.
- `price_per_month_bdt`, `charged_bdt`: snapshots; null for a trial.
- `canceled_at`, timestamps.

Rules:
- **Partial unique:** at most one `TRIALING` / `ACTIVE` subscription per account.
- **Trial once per account:** an account that already has any subscription row gets no new trial.
- **`SubscriptionService`:**
  - `ensureAccount(userId)` / `startTrial(accountId)`: called from `first-workspace.ts` at sign-up (one tx: account, workspace link, TRIALING subscription with the `trial_days` snapshot, wallet + trial period with the `trial_comment_limit` grant). Idempotent, so a failed first try is repaired on the next session create.
  - `activePlan(workspaceId)`: one query, workspace → account → live subscription (`status in (TRIALING, ACTIVE) and now < current_term_end`) → plan.
  - `expireDue(now)`.
- **Scheduler `subscription-expiry`:** BullMQ, every 15 min, following the `MetaJobSchedulers` pattern, on a new `billing` queue. It moves ended trials and terms to `EXPIRED`. Readers also treat `now ≥ current_term_end` as expired, so a late job never extends a plan.

### 3.4 Wallet (built for more meters and future top-ups)
- **`wallets`**, one per billing account:
  - `id`, `billing_account_id` (unique)
  - `cycle_anchor_at`: the instant the term or trial started; it sets the reset day and time.
  - `current_period_start`, `current_period_end`: **the stored reset time.**
  - timestamps
- **`wallet_balances`**, one row per wallet × meter × period:
  - `wallet_id`, `meter`, `period_start`, `period_end`
  - `included`: granted from the plan at period start.
  - `added`: **future top-ups / extra limit, always 0 now.**
  - `used`
  - unique (`wallet_id`, `meter`, `period_start`); `used ≥ 0`, `included ≥ 0`, `added ≥ 0`.
  - Available = `included + added − used`.
- **`wallet_entries`**, an append-only ledger of everything that isn't a hot-path usage event:
  - `wallet_id`, `meter`, `period_start`
  - `kind`: `PLAN_GRANT` | `ADJUSTMENT` | `TOP_UP` | `EXPIRE`. Only `PLAN_GRANT` is written now; `TOP_UP` is reserved.
  - `amount`, `reference`, `actor_user_id` (set null), `note`, `created_at`
- **Meter registry in code:** `WALLET_METERS = { monthlyComments: { planLimit: 'monthlyComments' } }`. A new meter is one entry here, one plan limit key and one call site. No schema change is needed.
- **`WalletService`** (replaces `CreditService`):
  - `consume(workspaceId, meter, n = 1)`:
    1. Resolve the live subscription; none → `no_active_plan`.
    2. Roll the period forward if `now ≥ current_period_end`, in the same transaction (lazy rollover, granting the plan's limit **at that moment**, PW-D14).
    3. Run one guarded `UPDATE … SET used = used + n WHERE … AND used + n <= included + added RETURNING`.
    4. Return `ok` | `limit_reached` | `no_active_plan`.
  - `refund(...)`
  - `balance(workspaceId)`, which includes `resetsAt`.
  - `balanceMany(ids)`.
  - Every query is scoped by account and workspace ids. Logs carry ids and counts only.
- **Period math:** a pure function `nextReset(anchor, after)` in Asia/Dhaka (fixed UTC+6). It keeps the same day-of-month and time, clamps to the month's last day and handles leap years. It has unit tests for the 29th / 30th / 31st and February.
- **Lifecycle:**
  - A trial is **one period** `[started_at, trial_ends_at)` granted `trial_comment_limit` (PW-D12).
  - A new paid term sets the anchor to the term start and grants period 1.
  - Each reset grants a new period using the plan's limit at that moment; `period_end = min(nextReset, current_term_end)`.
  - Yearly terms keep resetting monthly until `current_term_end`.
  - After expiry, `consume` returns `no_active_plan`.

### 3.5 Moderation switch
- Before the **first** AI call of a comment, `consume(monthlyComments, 1)` runs and the comment gets `usage_counted_at`.
- If the LLM call is never reached (the existing release paths), the system calls `refund` and clears `usage_counted_at`.
- An edit of a comment that was already counted runs **without** consuming.
- Skip reasons:
  - `comment_limit_reached`: one warning per account per Dhaka day.
  - `no_active_plan`.
- `classificationCreditCost`, `CONTEXT_LEVEL_CREDITS`, `comments.credits_charged` and the writes of `daily_ai_usage.credits` are removed. `daily_comment_stats` stays as it is.

### 3.6 Pooled limits
- **Connected pages:** count ACTIVE pages across **all workspaces of the account** against `limits.connectedPages`. This changes `social-pages.*` and drops the Free fallback (no live plan → activation refused 409 `NO_ACTIVE_PLAN`; switching off always works).
- **Workspaces:** a Better Auth `/organization/create` before-hook counts the account's workspaces against `limits.workspaces` and returns 403 `workspace_limit_reached`. Without a live plan it returns 403 `no_active_plan`. The created workspace gets the creator's `billing_account_id` (PW-T3).
- **Seats:** a `LimitService.seatsLeft(accountId)` helper (distinct members across the account's workspaces). It is enforced when Module 7 adds invites.
- **Feature flags:** `moderation-policy.service.ts` reads them from `activePlan()`. With no live plan, flags are off.

### 3.7 APIs and screens
- **Public `GET /api/plans`:** active plans with the `planPrice` output for both intervals, limits, flags and trial days. The Module 8 landing and `/billing` cards will use it. The card shows the monthly figure, and the yearly toggle shows the yearly per-month price with "billed ৳5,388 yearly".
- **Client `GET /api/workspaces/:workspaceId/billing/summary`** (any member; the repo's tenant-route convention, instead of the draft's `/api/billing/summary`):
  - plan, interval, status, `trialEndsAt`, `termEndsAt`
  - comments `used / limit / resetsAt`
  - workspaces and pages `used / limit`
  - The client app shell shows a banner: "Trial ends in N days" or "Moderation paused: choose a plan" (en + bn).
  - The AI analysis card drops the credit costs and keeps only the data trade-off text.
- **Admin:**
  - **Plan editor:** monthly and yearly-per-month prices, the trial-days preset select + trial comment limit (Starter), the `workspaces` and `monthlyComments` limits. Free is hidden; the audit labels are updated.
  - **Clients list:** plan · interval · status badge (Trial ends 26 Nov / Active / Expired), and "Comments 1,234 / 2,500 · resets 15 Dec"; the plan filter reads the live subscription.
  - **Dashboard:** `planTiers` counts ACTIVE workspaces per live-subscription plan.
  - **AI card:** no credits column.
  - **Activate plan manually (PW-T9):** see §3.9.

### 3.8 Migrations (new files only; never edit 0000–0020)
1. **Schema (PW-T1):**
   - `billing_accounts`, `subscriptions`, `wallets`, `wallet_balances`, `wallet_entries`
   - plan columns, `workspaces.billing_account_id`, `comments.usage_counted_at`
2. **Plan data (PW-T1b):**
   - Rename the limit key in `feature_config` and seed `workspaces`.
   - Starter `trial_days` 7 + `trial_comment_limit` 300; yearly prices 449 / 1,349 / 3,599 (PW-D13).
   - Deactivate `free`.
3. **Account backfill (PW-T3):**
   - Create a billing account per workspace's oldest owner (else oldest member) and link the workspaces.
   - Start a Starter trial with its wallet and trial period for each account (PW-D15).
4. **Drops:** `comments.credits_charged` (PW-T4); `monthly_credit_usage`, `daily_ai_usage.credits` and `workspaces.plan_id` (PW-T6b). Each runs in the row that removes its last reader.
5. **Audit (PW-T9):** `subscription_audit_logs`.

### 3.9 Admin manual activation (PW-D16)
- `POST /api/admin/clients/:workspaceId/subscription` (SuperAdminGuard) `{ planId, interval: 'month' | 'year', startDate: 'YYYY-MM-DD' (Dhaka), reason }`:
  - the workspace's billing account (none → 409); the plan must be active (and have a yearly price for `year`); `startDate` from 31 days ago to today (Dhaka, no future dates); reason trimmed 1–500 (like status changes).
  - One tx: lock the account → the live subscription (if any) → `CANCELED` + `canceled_at` → new `ACTIVE` subscription, term = start date 00:00 Dhaka + 1 month / 1 year (clamped like `nextReset`), price snapshots from `planPrice` → wallet re-anchored at the term start, the period containing now granted fresh (`used` 0) + `PLAN_GRANT` entry with the admin as actor → one `subscription_audit_logs` row (actor, account, workspace, before/after plan + interval + status, reason, IP, user agent; FKs restrict).
  - Response `{ subscription, comments: { used, limit, resetsAt } }`.
- Admin UI: "Activate plan" in the `/admin/clients` row actions → dialog (active plan select, Monthly / Yearly (yearly disabled without a yearly price), start date (default today), reason, price preview "৳449/month · billed ৳5,388 yearly") → mutation → invalidate the clients list + toast.

---

## 4. Rows (one sub-agent each, in order)

The draft's PW-T1 and PW-T6 were split (PW-T1b, PW-T6b) because each mixed too much for one session; the wallet now comes before subscriptions only in the sense that `WalletService` ships first with a shared live-subscription query, tested with inserted rows.

| Row | Scope | Main tests |
|---|---|---|
| **PW-PLAN** | Docs only: this plan approved, TASKS.md section "Plans, subscriptions & wallet (PW)" with PW-D1…D16 and rows, Module 5 D7 / D14 (credits bar) / D15 marked superseded, Module 8 + Module 5 specs, MEMORY. | — |
| **PW-T1** | Schema migration: `billing_accounts`, `subscriptions`, `wallets`, `wallet_balances`, `wallet_entries`, plan columns (`yearly_monthly_price_bdt`, `trial_days`, `trial_comment_limit`), `workspaces.billing_account_id` (nullable), `comments.usage_counted_at`. Drizzle schema, checks, delete order in `cleanup()` + e2e teardown. No data, no services. | schema e2e (checks, partial unique live subscription, unique wallet per account, balance unique key, FK restrict) |
| **PW-T1b** | Plan data + rules: data migration (key rename, `workspaces` limits, trial seeds, yearly prices, deactivate free), `PLAN_LIMIT_KEYS`/legacy map flip, `planPrice()`, admin plans API new fields + validation + audit, inactive plans hidden, `CreditService` reads the renamed key until PW-T4. | migration e2e (rename, seeds, admin edits kept, idempotent), `planPrice` unit, admin-settings e2e |
| **PW-T2** | `WalletService` + `nextReset` period math + meter registry + shared live-subscription query. Replaces `CreditService` later (PW-T4 switches the caller). | period edge cases, concurrent consume never over limit, rollover with a changed limit, yearly monthly resets, trial single period, refund, no plan |
| **PW-T3** | `SubscriptionService`: account create-or-get + workspace link (sign-up + `/organization/create`), trial at sign-up (`first-workspace.ts`), `activePlan()`, expiry scheduler (`billing` queue), account + trial backfill migration (PW-D15). | sign-up → TRIALING + wallet; trial-days/limit change doesn't touch running trials; expiry; backfill |
| **PW-T4** | Moderation switch to `consume` / `refund`, count-once (`usage_counted_at`), the new skip reasons; remove credit cost code, stop writing `daily_ai_usage.credits`, drop `comments.credits_charged`. | moderation e2e (count once, edit free, limit reached, no plan), golden replay unchanged |
| **PW-T5** | Pooled limits: pages per account, the workspace-create hook, the seats helper, feature flags from `activePlan()`. | pages pooled across 2 workspaces, 403 `workspace_limit_reached` / `no_active_plan` |
| **PW-T6** | Public `GET /api/plans` + client `GET /api/workspaces/:id/billing/summary`. | e2e for each endpoint (public, tenant scoping, trial / active / expired) |
| **PW-T6b** | Admin API switch + drops: clients list plan / subscription / comments (replaces `credits`), plan filter, dashboard `planTiers`, AI card without credits; drop `workspaces.plan_id`, `monthly_credit_usage` + `src/credits/`, `daily_ai_usage.credits`. | admin e2e (clients, dashboard, system), schema e2e |
| **PW-T7** | Admin UI: plan editor fields, clients status + comments bar, AI card without credits. | admin vitest |
| **PW-T8** | Client UI: plan status banner (en + bn), AI analysis card text. | client vitest |
| **PW-T9** | Admin manual plan activation (§3.9): endpoint + `subscription_audit_logs` + admin dialog on `/admin/clients`. | e2e (activate, replace live sub, validation, audit row, guard), admin vitest |
| **PW-GATE** | Full build, tests and lint across the 3 apps. A Docker rebuild plus a browser check of `/admin/settings`, `/admin/clients` (incl. manual activation) and the client banner. Then hand back to M5-T16. | all suites |

After PW-GATE the Module 5 run continues: M5-T16 (bake-off, unchanged), then M5-GATE.

---

## 5. Out of scope (later)
- **Module 8:** SSLCommerz payments, renewals, trial → paid conversion, upgrade / downgrade and proration, the landing pricing cards and `/billing`.
- **Later:** top-ups / extra monthly limit (the `added` column, `TOP_UP` ledger kind), new meters (auto-reply, lead capture), admin manual wallet adjustments (`ADJUSTMENT`), a subscription history view in admin.

## 6. Answers to the draft's "Choices to confirm" (user, 2026-11-19)
1. Trial limits → **smaller trial limit, 300 comments** (PW-D12), other limits = Starter's.
2. Yearly seed → **10% off**, rounded down: ৳449 / ৳1,349 / ৳3,599 (PW-D13).
3. Workspace limits → **1 / 3 / 10** (PW-D10).
4. Plan limit edits → **from each client's next reset** (PW-D14).
5. Existing dev workspaces → **fresh Starter trial** (PW-D15).
6. Manual plan activation → **yes, add it** (PW-D16, PW-T9).
