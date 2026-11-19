# Plan: promotions (trial, discount, coupon) and plain plans

Status: **approved 2026-11-20** (user: "yes please proceed"). Written from the user's answers in chat; a builder check was run and its questions were answered (PR-D15…D18) or settled as my calls (§3, approved with the plan). The docs-only row `PR-PLAN` turned it into TASKS.md rows (section "Promotions (PR)", after the PW section) and committed this file.

Row prefix: **PR** (Promotions). It runs after PW-GATE (passed 2026-11-20) and **before** M5-T16 / M5-GATE (the orchestration run is paused at M5-T16 waiting for AI credentials). Payments, checkout, renewals and invoices stay in Module 8, and this plan says what Module 8 must take over.

---

## 1. Why

Today every offer lives inside the plan row: a struck "original price", an "offer price", an "offer badge" ("50% Launch Offer"), and the trial length and trial comment limit on Starter. You can't run two offers at once, can't limit an offer to a date or to the first N clients, can't target several plans, and coupons don't exist.

The user wants plans to hold only their **fixed facts** and every offer to be a separate, configurable, stoppable **promotion** that links to plans. That reads as more professional, and lets the admin run campaigns without editing prices.

**Success:** the admin can create, for example:
- "Free 7-day trial on Starter until 31 Dec": it disappears from the pricing page after that date.
- "৳200 off every plan until I turn it off".
- "Coupon `FIRST10`: ৳400 off for the first 10 clients, valid until 15 Jan".

The pricing page shows trials and discounts by itself; coupons only work when typed at checkout.

**Anti-goals** (a failure even if it works):
- A client gets the same offer twice.
- Two **automatic** discounts stack and sell a plan below what the admin meant. A coupon on top of one discount is intended (PR-D16).
- An expired trial still shows on the pricing page.
- Plan prices drift silently when promotions change: prices are always snapshotted on the subscription.

## 2. Decisions (user, 2026-11-20, in chat)

| ID | Topic | Decision |
|---|---|---|
| PR-D1 | Name | Umbrella term **Promotion**, with three kinds: **TRIAL**, **DISCOUNT** and **COUPON**. "Promotion" is my term; the user asked for a professional word that covers all three. |
| PR-D2 | Shared settings | Every promotion, whatever its kind, has: **target plans** (one, several or all); **validity**: an end date, or "until the admin turns it off"; an optional **cap "first N clients"**; and an admin **Stop** that ends it at any time. |
| PR-D3 | Once per client | "Make sure offer claims for each unique user only one time. Next time they will not get those offers." A client account can redeem a given promotion **once, ever**. "Unique user" is read as the **client (billing) account**, so a teammate on the same account can't claim it again: my reading. |
| PR-D4 | Discount types | A discount is **FLAT** (৳ off) or **PERCENT** (% off). The admin chooses whether it cuts the **total bill** or **each month's price**. |
| PR-D5 | Discount length | The admin sets **how many months** the discount lasts (e.g. "first 3 months 10% off"), or forever. |
| PR-D6 | No stacking | When two discounts apply to the same plan, **only the bigger saving applies**. I proposed the same rule for a coupon against a live discount, and the user didn't object. |
| PR-D7 | Percent label | A percentage discount shows as plain text (e.g. "50% off") on the pricing page, **not as a badge**. |
| PR-D8 | Plan badge + description | A plan gets an optional free-text **badge** (e.g. "Popular") and a short **description**. The launch-offer fields (struck original price, offer price, offer badge) are removed from plans. |
| PR-D9 | Highlighted plan | The admin can mark **one** plan as highlighted. Its card gets the stronger style and the **primary** button; the others get **secondary** buttons. |
| PR-D10 | Trial = promotion | A plan with a live trial promotion shows **"Start free N-day trial"**. The client picks the plan; the trial **no longer starts by itself at sign-up**. After the trial promotion's end date it **is not shown** on the pricing page, and later sign-ups **get no trial**. |
| PR-D11 | Coupon | A coupon is never shown on cards. The client types the code at **checkout**, and the backend validates it. |
| PR-D12 | Bill shows the offer | Every bill/invoice records the promotion: its name or code, the amount taken off, and, for multi-month discounts, which month this is (e.g. "2 of 3"). |
| PR-D13 | Buy button now | Until Module 8 checkout exists, the "Choose plan" button is **"Contact us"**. |
| PR-D15 | Stop / end date | Builder-check answer: "Keep what they got." Stop or the end date only blocks **new** claims. Clients who already claimed keep the discount until their months run out; a forever discount lasts until they cancel or leave the targeted plans. |
| PR-D16 | Coupon + discount | Builder-check answer: "Coupon on top." The coupon comes off the **already discounted** price (e.g. ৳499 after the launch offer − ৳400 coupon = ৳99). Automatic discounts still don't stack among themselves (PR-D6), and no price goes below ৳0. |
| PR-D17 | Bangla plan text | Builder-check answer: "Yes, en + bn fields." Plan `badge` and `description` each have an English and a Bangla field; Bangla mode falls back to English when the Bangla field is empty. |
| PR-D18 | Contact us target | Builder-check answer: "WhatsApp chat." "Contact us" opens a WhatsApp chat with the support number, with a prefilled message that names the plan and interval. The number is set in admin settings; with no number set, the button is hidden. |
| PR-D14 | Pricing layout | Like the user's reference screenshot: a Monthly / Yearly switch with "Save up to N%" next to Yearly. Each card has the name, optional badge, description, the price after any discount (normal price struck through, "50% off" / "৳200 off" text), the button and the feature list. |

## 3. Proposed by me (approved with the plan 2026-11-20)

1. **One trial per client account, ever**, across all trial promotions. Discounts and coupons are once per promotion (PR-D3). Without this rule, a new trial promotion would give every old client a second trial.
2. **Yearly + "first N months":** on a yearly bill, a per-month discount comes off N of the 12 months (10% off 3 months = 10% × 3 × the per-month price). A "total bill" discount ignores the month count and applies to the first bill only.
3. **Rounding:** the price after a percentage discount is **rounded down** to whole taka, in the client's favour. A flat discount never takes a price below ৳0.
4. **Today's prices stay exactly the same on the card.** The dev DB today:

   | Plan | List | Offer | Yearly per month | Badge |
   |---|---|---|---|---|
   | Starter | ৳999 | ৳499 | ৳449 | "50% Launch Offer" |
   | Growth | ৳2,499 | ৳1,499 | ৳1,349 | "40% Off" |
   | Pro | ৳5,999 | ৳3,999 | ৳3,599 | "33% Off" |

   The migration keeps each list price as `monthly_price_bdt`. For each plan with an offer it seeds a **"Launch offer"** DISCOUNT promotion: FLAT, each month's price, that plan only, forever, no end date, value = list − offer (৳500 / ৳1,000 / ৳2,000). The yearly per-month list price becomes today's yearly price + that value (৳949 / ৳2,349 / ৳5,599), so the shown prices stay ৳499 / ৳1,499 / ৳3,999 monthly and ৳449 / ৳1,349 / ৳3,599 yearly. The admin can re-price afterwards; there is no production data yet.

   A seeded TRIAL promotion "Starter 7-day trial" (Starter, 7 days, 300 comments, no end date) keeps today's trial on offer.
5. **Sign-up order:** sign-up still creates the client account and the first workspace, as today, but no plan. The client lands on a new **`/plans`** page in the client app instead of `/onboarding`. The "Moderation paused: choose a plan" banner links to `/plans`.
6. **Existing subscriptions are untouched.** Running trials keep their end date and limit. Running ACTIVE plans keep their price snapshot.
7. **Manual activation (PW-T9) takes an optional coupon code.** It's the only way to redeem a coupon before Module 8. The best live discount is applied automatically (PR-D6) and recorded as a redemption.
8. **Editing a promotion after its first redemption:** the money terms (type, value, scope, months, trial length, trial comment limit) are **locked**. Name, end date, cap, target plans and Stop stay editable. Clients who already redeemed keep the terms they got (snapshotted on the redemption).
9. **A claimed discount belongs to the client account and carries across terms.** The redemption keeps a `months_used` counter. Every later term of a targeted plan (Module 8 renewals, a manual re-activation, a monthly ↔ yearly switch) keeps applying it until the months run out (a forever discount: until the client moves to a plan it doesn't target). Signed-in clients see on `/plans` the price **they** would pay (their claimed discount, or the best live one they haven't used); visitors see the best live discount.
10. **"Bigger saving" compares the first bill:** the saving on the term being bought now, which is what the card shows.

## 4. What exists today (for the builder)

- `plans` (`backend/src/db/schema/plans.ts`) has columns `original_price_bdt`, `offer_price_bdt`, `offer_badge`, `yearly_monthly_price_bdt`, `trial_days`, `trial_comment_limit` (Starter only) and `feature_config`. There are 4 rows; `free` is inactive.
- `plan_audit_logs` (`src/db/schema/plan-audit.ts`) names changed fields by their camelCase key (`PLAN_AUDIT_FIELDS`: `originalPriceBdt`, `offerPriceBdt`, `offerBadge`, `trialDays`, `trialCommentLimit`, …). Renamed/dropped keys move to `LEGACY_PLAN_AUDIT_FIELDS` (as `monthlyAiCredits` did in PW-T1b) so old audit rows still type and label; the admin app labels them in `admin/src/lib/admin-plan-audit.ts`. (Added by PR-PLAN from the code.)
- `planPrice(plan, interval)` (`src/plans/plan-price.ts`) is the one price rule. It returns `perMonthBdt`, `chargedBdt`, `listPerMonthBdt` and `badge`. `GET /api/plans` (public) and the admin screens use it.
- `subscriptions` stores the price snapshots `price_per_month_bdt` and `charged_bdt`, plus `trial_ends_at`.
- **Sign-up:** `src/auth/first-workspace.ts` → `SubscriptionService.setUpOwner()`, which links the workspace to the billing account **and calls `startTrial()`** (trial on the `starter` plan, using its `trial_days` and `trial_comment_limit`).
- **Manual activation:** `POST /api/admin/clients/:workspaceId/subscription` (PW-T9), recorded in `subscription_audit_logs`.
- **Admin screens:**
  - `/admin/settings` plan editor: list price, offer price + badge, yearly price per month, and Starter trial pills with the trial comment limit.
  - `/admin/clients`: plan status, plus the Activate plan dialog with a price preview.
- **Client app:**
  - The `_app` shell shows the plan banner (PW-T8, "choose a plan" as plain text).
  - There is no pricing page; the landing page `index.tsx` is a placeholder.
  - There is no checkout, payments table or invoices table (A4 transactions is a placeholder until Module 8).

## 5. Target design

### 5.1 Plans (fixed facts only)
- **Keep:** `slug`, `name`, `sort_order`, `is_active`, `feature_config`.
- **Price columns:**
  - rename `original_price_bdt` → `monthly_price_bdt`;
  - keep `yearly_monthly_price_bdt` (≤ the monthly price; `null` = no yearly option).
- **Add:**
  - `badge_en`, `badge_bn` (text, nullable, 1–24 chars; PR-D17);
  - `description_en`, `description_bn` (text, nullable, 1–160 chars; PR-D17);
  - `is_highlighted` (bool, default false, partial unique index `where is_highlighted` = at most one).
- **Drop (in a late row, after no code reads them):** `offer_price_bdt`, `offer_badge`, `trial_days`, `trial_comment_limit`.
- **Plan audit (added by PR-PLAN; done in PR-T4 with the admin API rename):** `originalPriceBdt` → `monthlyPriceBdt` in `PLAN_AUDIT_FIELDS` (old key into `LEGACY_PLAN_AUDIT_FIELDS`); add `badgeEn`, `badgeBn`, `descriptionEn`, `descriptionBn`, `isHighlighted`; the dropped offer/trial keys become legacy in PR-T7.
- **Test DB baseline (added by PR-PLAN):** the 0027 seed adds the "Launch offer" and "Starter 7-day trial" promotions (+ their `promotion_plans` rows) to every database, the test DB included. The e2e `cleanup()` must keep them (delete only rows tests create), and the gate check becomes "only the 4 `plans` rows + the seeded promotions".

### 5.2 Promotions
`promotions` table:
- **Identity:** `id`, `kind` (TRIAL | DISCOUNT | COUPON), `name` (1–60; shown to the admin and on bills).
- **Coupon code:** `code` (COUPON only; stored uppercase, unique, 3–32 chars of `[A-Z0-9-]`).
- **Targeting:** `all_plans` bool. When false, the targets live in `promotion_plans` (promotion_id, plan_id, PK both).
- **Validity:**
  - `ends_at` timestamptz null = until stopped. The admin picks a date; it's stored as the end of that day, Dhaka time.
  - `max_redemptions` int null = no cap.
  - `stopped_at`, `stopped_by` (null = not stopped).
- **Trial fields** (TRIAL only): `trial_days` (1–90; admin presets 3 / 7 / 14 / 30), `trial_comment_limit` (null = the plan's monthly comments).
- **Discount fields** (DISCOUNT/COUPON only):
  - `discount_type` FLAT | PERCENT;
  - `discount_value` (FLAT ৳ ≥ 1; PERCENT 1–100);
  - `discount_scope` TOTAL | PER_MONTH;
  - `duration_months` (null = forever; ignored for TOTAL).
- **Audit:** `created_by`, `created_at`, `updated_at`.
- **Kind-specific rules:** check constraints enforce which columns each kind may fill.

**Live** = not stopped, `ends_at` null or in the future, and the cap not reached. "Live for plan P" additionally requires that P is a target.

`promotion_redemptions` table:
- **Columns:** `id`, `promotion_id`, `billing_account_id`, `subscription_id`, `redeemed_at`, plus a **snapshot of the terms** (type, value, scope, months, trial days / comment limit), `months_used` (§3.9) and `discount_bdt_first_term`. The redemption belongs to the account; later subscriptions point back to it through `subscriptions.promotion_redemption_id` and `subscriptions.coupon_redemption_id` (both nullable).
- **Constraints:** `unique(promotion_id, billing_account_id)` enforces PR-D3. FKs restrict.
- **Cap check:** redeeming locks the promotion row (`FOR UPDATE`) and counts its redemptions in the same transaction, so "first N clients" can't overshoot.

### 5.3 Prices (one rule, still pure)
`planPrice(plan, interval, discounts[])` returns the list price, the best-discount price and the saving:
- `listPerMonthBdt`, `listChargedBdt`;
- `perMonthBdt`, `chargedBdt`;
- `saving` `{ promotionId, label, amountBdt }` or null.

It works out each applicable automatic discount for that plan and interval (the account's claimed one, or live ones it hasn't used) and keeps the **largest first-bill saving** (PR-D6, §3.10); a tie goes to whichever ends sooner. A coupon, when a code is passed, then comes off that result (PR-D16), floored at ৳0. The label is generated: "50% off" or "৳200 off", plus "for 3 months" when limited. §3 items 2 and 3 cover yearly and rounding.

### 5.4 Trial by choice
- `setUpOwner()` stops starting a trial (PR-D10). Sign-up only creates the billing account and workspace.
- `isSetUp()` (the session-create repair check) today means "the account has (or had) a subscription"; without the auto trial it must mean "the workspace is linked to a billing account", or every session would re-run the repair. (Added by PR-PLAN from the code.)
- `POST /api/workspaces/:workspaceId/billing/trial` `{ planId }`:
  - **Who:** owner only; impersonated sessions are refused.
  - **Checks:** a live TRIAL promotion targets the plan; the account has no live subscription; the account never had a trial (§3.1).
  - **One transaction:** create the subscription TRIALING with the snapshot from the promotion; record the redemption; open the wallet period with the promotion's comment limit.
- The billing summary (PW-T6) gains `trialEligible: boolean`, so the client hides the trial button for accounts that already used one.

### 5.5 Coupons now
- `PromotionService.validateCoupon(code, accountId, planId, interval)` returns a price preview, or a machine code: `COUPON_NOT_FOUND`, `COUPON_EXPIRED`, `COUPON_USED_UP`, `COUPON_ALREADY_USED`, `COUPON_NOT_FOR_PLAN`.
- **Used now** by manual activation's optional `couponCode` (§3.7).
- **Module 8** checkout calls it and adds the public "apply coupon" endpoint then.

### 5.6 Bills (PR-D12)
There's no invoices table yet. For now:
- The subscription's price snapshot is the discounted price.
- The redemption stores the terms and `discount_bdt_first_term`.
- **Module 8 contract:** each invoice line carries `promotion_redemption_id`, `promotion_name`/`code`, `discount_bdt`, and the "k of N" month counter; renewals stop discounting after N months. This row adds it to the Module 8 spec so it can't be forgotten.

### 5.7 APIs
- **Public `GET /api/plans`:** each active plan returns:
  - `badge`, `description`, `highlighted`;
  - `monthly` / `yearly` from `planPrice` with the best live **discount**;
  - `trial` `{ promotionId, days, commentLimit, endsAt }` | null;
  - top-level `yearlySaveUpToPercent`.
  Coupons are never listed.
- **Admin `/api/admin/promotions`** (SuperAdminGuard):
  - list: kind/status filters, plus redemption count and status Live / Ended / Stopped / Used up;
  - create;
  - patch (§3.8 locks);
  - `POST /:id/stop`;
  - `GET /:id/redemptions` (client, date, saving).
- **Admin plan PATCH:** the new plan fields; setting `is_highlighted` clears it on the other plans in the same transaction.

### 5.8 Screens
- **Admin `/admin/settings`:** a "Support WhatsApp number" field (BD format, stored in the existing settings storage or a one-row table: builder's call), exposed to the client through `GET /api/plans` as `contactWhatsapp`.
- **Admin `/admin/settings` plan editor:**
  - fields: monthly price, yearly price per month, badge (en + bn), description (en + bn), "Highlight this plan" switch;
  - removed: offer price/badge and trial settings.
- **Admin `/admin/promotions`** (new nav item):
  - a table: kind, name/code, plans, value, ends, "used 3 / 10", status, Stop;
  - a "New promotion" dialog that shows the fields for the chosen kind (trial length pills 3 / 7 / 14 / 30; FLAT/PERCENT; total bill vs each month; months or forever; plans multi-select or All; end date or "until stopped"; cap).
- **Admin Activate plan dialog:** an optional coupon field, and the preview shows the saving.
- **Client `/plans`** (new, inside `_app`, en + bn, PR-D14):
  - the Monthly/Yearly switch;
  - cards in `sort_order`, with the highlighted card in the strong style;
  - trial plans show "Start free N-day trial" (primary on the highlighted card), when `trialEligible`;
  - other plans show **"Contact us"** (PR-D13): a WhatsApp link (PR-D18) to `https://wa.me/<number>?text=<prefilled, names the plan + interval>`.
- **Client flow:**
  - sign-up lands on `/plans` while the account has no subscription;
  - the "choose a plan" banner links to `/plans`;
  - after a trial starts, the client goes to `/onboarding`.

## 6. Rows (one sub-agent each, in order)

| Row | Scope |
|---|---|
| PR-PLAN | Docs only: TASKS.md section "Promotions (PR)" with PR-D1…D18 and the §3 readings; mark PW-D6, PW-D8 (auto trial at sign-up), PW-D12/D13 (trial and yearly fields on plans) superseded; Module 8 spec gets §5.6 and the coupon endpoint; MEMORY. Commits this file. |
| PR-T1 | Migration 0027: `promotions`, `promotion_plans`, `promotion_redemptions`, `subscriptions.promotion_redemption_id` / `coupon_redemption_id`, the support WhatsApp number storage (§5.8); plans gain `badge_en/bn`, `description_en/bn`, `is_highlighted`, rename to `monthly_price_bdt` (DB + Drizzle key only; API field + audit key renames in PR-T4); data: list prices kept, yearly recomputed (§3.4), seed "Launch offer" + "Starter 7-day trial" promotions. Old columns stay readable. Schema e2e for constraints. |
| PR-T2 | `PromotionService` (live rules, redeem with cap + once-per-account, `validateCoupon`) + new `planPrice` + public `GET /api/plans` shape (incl. `contactWhatsapp`). Tests incl. no-stacking, rounding, yearly × months, cap race. |
| PR-T3 | Trial by choice: drop the auto trial from `setUpOwner`, `POST …/billing/trial`, `trialEligible` in the billing summary; test helpers that give actors a live plan explicitly. e2e. |
| PR-T3b | Manual activation applies the best discount + optional `couponCode` and records redemptions; a claimed discount carries to later terms (§3.9). e2e. (Split from PR-T3 by PR-PLAN: dropping the auto trial touches many e2e files on its own.) |
| PR-T4 | Admin promotions API (list/create/patch/stop/redemptions) + plan PATCH fields (highlight exclusive, audit keys) + support WhatsApp number GET/PATCH. e2e + guard matrix. |
| PR-T5 | Admin UI: plan editor fields (en + bn badge/description, highlight), WhatsApp number field, coupon field + saving in Activate plan. Admin vitest. |
| PR-T5b | Admin UI: `/admin/promotions` nav item, table, "New promotion" / edit dialog, Stop, redemptions view. Admin vitest. (Split from PR-T5 by PR-PLAN.) |
| PR-T6 | Client UI: `/plans` page (en + bn), trial start, Contact us, banner link, sign-up → `/plans`. Client vitest. |
| PR-T7 | Migration 0029: drop `offer_price_bdt`, `offer_badge`, `trial_days`, `trial_comment_limit`; remove the last readers; their audit keys become legacy. |
| PR-GATE | All suites, Docker rebuild, browser check (admin promotions + plan editor, client `/plans` trial start, expired trial promotion hidden, coupon via manual activation). |

## 7. Left to the builder
The exact column names and limits above (unless they contradict a decision), error codes, the admin table/dialog layout, Bangla copy, the "Save up to N%" maths (max over active plans of 1 − yearly/monthly at list prices), and the tie-break between equal discounts.

**Open for the user:** none. The builder check's questions were answered on 2026-11-20 (PR-D15…D18) or settled in §3 (items 4, 9 and 10).
