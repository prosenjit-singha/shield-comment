# Module 8: Bangladesh Billing (SSLCommerz: bKash, Nagad, Visa) & SEO Landing Page

> **Previous:** [`./module-7-support-team.md`](./module-7-support-team.md) | **Next:** [`./module-9-launch-security.md`](./module-9-launch-security.md) | **Landing Spec:** [`../../design/client.md`](../../design/client.md)

## Objective & Dependencies
Implement BDT subscription payments via [SSLCommerz V4 API](https://developer.sslcommerz.com/doc/v4/) (bKash, Nagad, Rocket, Visa, Mastercard) on top of the subscriptions and wallet built in the PW rows, and the SEO-optimized, 80%+ Lighthouse Performance `client/` landing page. **Dependency:** Module 7.

> **Already built before this module (PW rows, 2026-11-19; plan `docs/plans/2026-11-19-plans-subscriptions-wallet.md`, TASKS.md section PW):** `billing_accounts` (the plan belongs to the client account, limits pooled across its workspaces), `subscriptions` (`TRIALING`/`ACTIVE`/`EXPIRED`/`CANCELED`, interval **monthly or yearly**, price snapshots), a **Starter trial at sign-up** (admin-set length, 300-comment trial limit; **superseded by PR-D10**: no trial at sign-up, the client starts a TRIAL promotion on `/plans`), no Free plan, yearly per-month prices per plan + `planPrice()`, the per-account **wallet** (`wallets`/`wallet_balances`/`wallet_entries`, meter `monthlyComments`, reset monthly on the billing date), public `GET /api/plans`, the client billing summary + banner, and the admin "activate plan manually" action. **Module 8 keeps:** SSLCommerz checkout + IPN + validation, `payment_transactions`, renewals, trial → paid conversion, upgrades/downgrades, the landing pricing cards (monthly/yearly toggle; the card shows the monthly price, the yearly toggle the yearly per-month price + "billed ৳X yearly") and C10 `/billing`.

> **Promotions (PR rows, 2026-11-20; plan `docs/plans/2026-11-20-promotions.md`, TASKS.md section PR):** offers are no longer plan columns. `promotions` (TRIAL / DISCOUNT / COUPON; target plans, end date or until stopped, "first N clients" cap, Stop) + `promotion_redemptions` (once per client account per promotion; terms snapshot, `months_used`) and `PromotionService` (live rules, `redeem()`, `validateCoupon()`) exist, and `planPrice(plan, interval, discounts[], coupon?)` applies the best automatic discount (no stacking) and a coupon on top (floor ৳0). The trial is **started by the client** from a TRIAL promotion on client `/plans` (no auto trial at sign-up); until checkout exists, the paid button is "Contact us" (WhatsApp) and coupons are redeemed only through the admin manual activation. **Module 8 must:**
> - add a **coupon box** to checkout and a **public "apply coupon" endpoint** that calls `PromotionService.validateCoupon(code, accountId, planId, interval)` (preview or `COUPON_NOT_FOUND`/`COUPON_EXPIRED`/`COUPON_USED_UP`/`COUPON_ALREADY_USED`/`COUPON_NOT_FOR_PLAN`), redeeming only when the payment is validated;
> - give every **invoice line** the promotion data (PR-D12): `promotion_redemption_id`, `promotion_name` / `code`, `discount_bdt` and the "k of N" month counter for multi-month discounts;
> - on **renewals**, keep applying a claimed discount (the account's redemption, `months_used` + 1 per term) until its months run out; a forever discount lasts until the client cancels or leaves the targeted plans; Stop / end date only blocks new claims (PR-D15);
> - **coupons (PR-D19):** once per client account; a coupon runs only its set months (first N bills, usually 1), never past them;
> - replace "Contact us" with the checkout button on `/plans` and the landing cards, which read `GET /api/plans` (badge, description, highlighted plan, discounted price + plain "50% off" text, trial).

## Backend Implementation (`backend/`)
- Tables: `Plan` (`monthly_price_bdt`, `yearly_monthly_price_bdt`, `badge_en/bn`, `description_en/bn`, `is_highlighted`, `feature_config` JSON; offer/trial columns dropped in PR-T7), `Subscription` (PW; + `promotion_redemption_id`, `coupon_redemption_id`), `promotions`, `promotion_plans` and `promotion_redemptions` (PR) already exist; this module adds `PaymentTransaction` (`tran_id`, `val_id`, `amount_bdt`, `gateway`, `status`) linked to a subscription term.
- [SSLCommerz](https://sslcommerz.com/) Lifecycle: Session Creation -> Hosted Checkout -> `POST /billing/ipn` (**superseded by M8-PLAN reading 4**: `POST /api/billing/sslcommerz/ipn` + success/fail/cancel returns, all through the client's same-origin `/api` proxy) -> Order Validation API (`val_id`, `amount`, `currency=BDT`) -> activate subscription.
- Usage limits: there is no `QuotaGuard` / `monthly_comment_limit`. The moderation worker calls `WalletService.consume(workspaceId, 'monthlyComments')` before a comment's first AI call (built in PW-T4); a paid term (re)anchors the wallet and grants the plan's limits. A successful payment activates or renews the subscription through `SubscriptionService` (same path as the admin manual activation, PW-T9).

## Frontend Implementation (`client/` & `admin/`)
- Build **C1** (`/` English and `/bn` Bangla, public SEO landing page + standardized 10-row promo pricing matrix) in `client/` as **server-rendered / prerendered TanStack Start routes** with `head()` meta, Open Graph tags, `hreflang` and JSON-LD. The page must work without JavaScript, so Meta link previews and search engines see the content.
- Build **C10** (`/billing`) in `client/`, synced with **A4** (`/admin/billing`) in `admin/`.

> **Rows + open decisions:** TASKS.md section "Module 8" (M8-PLAN, 2026-11-21).

## Agent Test & Verification Gate
- SSLCommerz Sandbox E2E test: initiate session -> IPN -> Order Validation API -> subscription `ACTIVE` (trial → paid, monthly and yearly) with a fresh wallet period; tampered amount rejected.
- Lighthouse audit on `client/` `/` and `/bn` scores **>=80% Performance** and **>=90% SEO**.
- `curl` of `/` and `/bn` returns the H1, pricing table and `og:` tags in the raw HTML.
