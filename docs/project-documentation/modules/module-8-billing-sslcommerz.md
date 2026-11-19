# Module 8: Bangladesh Billing (SSLCommerz: bKash, Nagad, Visa) & SEO Landing Page

> **Previous:** [`./module-7-support-team.md`](./module-7-support-team.md) | **Next:** [`./module-9-launch-security.md`](./module-9-launch-security.md) | **Landing Spec:** [`../../design/client.md`](../../design/client.md)

## Objective & Dependencies
Implement BDT subscription payments via [SSLCommerz V4 API](https://developer.sslcommerz.com/doc/v4/) (bKash, Nagad, Rocket, Visa, Mastercard) on top of the subscriptions and wallet built in the PW rows, and the SEO-optimized, 80%+ Lighthouse Performance `client/` landing page. **Dependency:** Module 7.

> **Already built before this module (PW rows, 2026-11-19; plan `docs/plans/2026-11-19-plans-subscriptions-wallet.md`, TASKS.md section PW):** `billing_accounts` (the plan belongs to the client account, limits pooled across its workspaces), `subscriptions` (`TRIALING`/`ACTIVE`/`EXPIRED`/`CANCELED`, interval **monthly or yearly**, price snapshots), a **Starter trial at sign-up** (admin-set length, 300-comment trial limit), no Free plan, yearly per-month prices per plan + `planPrice()`, the per-account **wallet** (`wallets`/`wallet_balances`/`wallet_entries`, meter `monthlyComments`, reset monthly on the billing date), public `GET /api/plans`, the client billing summary + banner, and the admin "activate plan manually" action. **Module 8 keeps:** SSLCommerz checkout + IPN + validation, `payment_transactions`, renewals, trial → paid conversion, upgrades/downgrades, the landing pricing cards (monthly/yearly toggle; the card shows the monthly price, the yearly toggle the yearly per-month price + "billed ৳X yearly"; launch offer kept) and C10 `/billing`.

## Backend Implementation (`backend/`)
- Tables: `Plan` (`original_price_bdt`, `offer_price_bdt`, `offer_badge`, `yearly_monthly_price_bdt`, `trial_days`, `trial_comment_limit`, `feature_config` JSON) and `Subscription` already exist (PW); this module adds `PaymentTransaction` (`tran_id`, `val_id`, `amount_bdt`, `gateway`, `status`) linked to a subscription term.
- [SSLCommerz](https://sslcommerz.com/) Lifecycle: Session Creation -> Hosted Checkout -> `POST /billing/ipn` -> Order Validation API (`val_id`, `amount`, `currency=BDT`) -> activate subscription.
- Usage limits: there is no `QuotaGuard` / `monthly_comment_limit`. The moderation worker calls `WalletService.consume(workspaceId, 'monthlyComments')` before a comment's first AI call (built in PW-T4); a paid term (re)anchors the wallet and grants the plan's limits. A successful payment activates or renews the subscription through `SubscriptionService` (same path as the admin manual activation, PW-T9).

## Frontend Implementation (`client/` & `admin/`)
- Build **C1** (`/` English and `/bn` Bangla, public SEO landing page + standardized 10-row promo pricing matrix) in `client/` as **server-rendered / prerendered TanStack Start routes** with `head()` meta, Open Graph tags, `hreflang` and JSON-LD. The page must work without JavaScript, so Meta link previews and search engines see the content.
- Build **C10** (`/billing`) in `client/`, synced with **A4** (`/admin/billing`) in `admin/`.

## Agent Test & Verification Gate
- SSLCommerz Sandbox E2E test: initiate session -> IPN -> Order Validation API -> subscription `ACTIVE` (trial → paid, monthly and yearly) with a fresh wallet period; tampered amount rejected.
- Lighthouse audit on `client/` `/` and `/bn` scores **>=80% Performance** and **>=90% SEO**.
- `curl` of `/` and `/bn` returns the H1, pricing table and `og:` tags in the raw HTML.
