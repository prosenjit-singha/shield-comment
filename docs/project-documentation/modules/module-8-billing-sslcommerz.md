# Module 8: Bangladesh Billing (SSLCommerz: bKash, Nagad, Visa) & SEO Landing Page

> **Previous:** [`./module-7-support-team.md`](./module-7-support-team.md) | **Next:** [`./module-9-launch-security.md`](./module-9-launch-security.md) | **Landing Spec:** [`../../design/client.md`](../../design/client.md)

## Objective & Dependencies
Implement BDT subscription billing via [SSLCommerz V4 API](https://developer.sslcommerz.com/doc/v4/) (bKash, Nagad, Rocket, Visa, Mastercard), `QuotaGuard` enforcement, and the SEO-optimized, 80%+ Lighthouse Performance `client/` landing page. **Dependency:** Module 7.

## Backend Implementation (`backend/`)
- Tables: `Plan` (`original_price_bdt`, `offer_price_bdt`, `offer_badge`, `feature_config` JSON), `Subscription`, `PaymentTransaction` (`tran_id`, `val_id`, `amount_bdt`, `gateway`, `status`).
- [SSLCommerz](https://sslcommerz.com/) Lifecycle: Session Creation -> Hosted Checkout -> `POST /billing/ipn` -> Order Validation API (`val_id`, `amount`, `currency=BDT`) -> activate subscription.
- `QuotaGuard` checks `monthly_comment_limit` before AI processing.

## Frontend Implementation (`client/` & `admin/`)
- Build **C1** (`/` English and `/bn` Bangla, public SEO landing page + standardized 10-row promo pricing matrix) in `client/` as **server-rendered / prerendered TanStack Start routes** with `head()` meta, Open Graph tags, `hreflang` and JSON-LD. The page must work without JavaScript, so Meta link previews and search engines see the content.
- Build **C10** (`/billing`) in `client/`, synced with **A4** (`/admin/billing`) in `admin/`.

## Agent Test & Verification Gate
- SSLCommerz Sandbox E2E test: initiate session -> IPN -> Order Validation API -> subscription `ACTIVE`; tampered amount rejected.
- Lighthouse audit on `client/` `/` and `/bn` scores **>=80% Performance** and **>=90% SEO**.
- `curl` of `/` and `/bn` returns the H1, pricing table and `og:` tags in the raw HTML.
