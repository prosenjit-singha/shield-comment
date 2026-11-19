# Client App (`client/`) Landing Page, SEO & Dashboard UI Specification

> **Shared Tokens:** [`./base.md`](./base.md) | **Admin UI:** [`./admin.md`](./admin.md) | **Modules:** [`../project-documentation/modules/module-6-client-dashboard.md`](../project-documentation/modules/module-6-client-dashboard.md), [`../project-documentation/modules/module-8-billing-sslcommerz.md`](../project-documentation/modules/module-8-billing-sslcommerz.md)

## 1. Multi-Language System (`English` Default & `Bangla`)
- Powered by Zustand `useLanguageStore` (`lang: 'en' | 'bn'`, default `'en'`), persisted to the `shield-lang` **cookie** (not `localStorage`) so TanStack Start's server-rendered HTML uses the same language as the browser.
- The public landing page also has fixed URLs per language: `/` (English) and `/bn` (Bangla), linked with `hreflang`.
- **Mandatory Rule:** Every visible text string (section titles, descriptions, button labels, pricing features, FAQ items, dashboard labels) MUST use `content(english, bangla)`:

```tsx
const { content } = useLanguage();
<h1>{content(
  "Stop Losing Facebook & TikTok Ad Sales to Scam Comments",
  "ফেসবুক ও টিকটক অ্যাডের স্ক্যাম কমেন্টে সেল হারানো বন্ধ করুন"
)}</h1>
```

## 2. Landing Page (`/`) — Inspiration, Mobile-First & 80%+ Performance
- **References:** [FeedGuardians](https://feedguardians.com/), [BrandBastion Paid Social](https://www.brandbastion.com/paid-social), [CommentGuard](https://commentguard.io/pricing/), [Linear (Radiant Studio 2026)](https://www.heyradiant.com/best-saas-landing-page-examples-2026/), [Stripe (Spell UI)](https://spell.sh/blog/best-saas-landing-pages), [SaaSFrame 2026 Motion Trends](https://www.saasframe.io/blog/10-saas-landing-page-trends-for-2026-with-real-examples).
- **Mobile-First (375px-first):** Minimum `44px × 44px` tap targets, single-column stacked hero, sticky frosted-glass bottom mobile CTA bar on `<768px`.
- **Lighthouse Gate:** **>= 80% Performance** & **>= 90% SEO** (TanStack Start SSR/prerender of `/` and `/bn`, TanStack Router `autoCodeSplitting`, `font-display: swap`, `<link rel="preconnect">`, `CLS < 0.1`, GPU-only `transform`/`opacity` animations via [Animate UI](https://animate-ui.com/docs)).

## 3. 9-Section Landing Page Blueprint
1. **Sticky Minimal Navbar:** Logo, 3 links, `EN | বাং` pill toggle (`rounded-full`), Login ghost button, `"Start Free"` `--primary` `rounded-full` CTA.
2. **Hero Section:** SEO H1 + subheadline + `RippleButton` CTA + Animated Live Meta/TikTok Comment Simulator card showing Banglish scam detection (`--secondary` `#FE2C55`) and buyer reply (`--primary` `#0668E1`).
3. **Trust & Platform Strip:** Facebook, Instagram, TikTok, bKash, Nagad, Visa/Mastercard ([SSLCommerz](https://sslcommerz.com/)).
4. **Problem vs. Solution (3-Card Bento Grid):** Competitor Poaching, bKash/Phishing Scams, Buried Buyer Inquiries.
5. **Interactive BDT ROAS Calculator:** Animate UI `Slider` (৳10,000–৳5,00,000 ad spend) + `CountingNumber` savings readout.
6. **How It Works (3 Steps):** Connect Page -> Enable Bangla/Banglish AI -> Watch ROAS climb.
7. **Standardized BDT Promo Pricing (Identical 10-Row Matrix):**
   Benchmarked against [FeedGuardians](https://autoposter.ai/alternatives/feedguardians) and [CommentGuard](https://commentguard.io/pricing/), every card renders promo strikethrough pricing and the **exact same 10-row `PlanFeatureConfig` checklist**:
   > **Promotions (2026-11-20, TASKS.md section PR):** offers come from **promotions**, not plan badges: the struck price + "50% off" / "৳200 off" (plain text, no badge) come from the best live DISCOUNT; "Start free N-day trial" from a live TRIAL; coupons never show on cards. A plan's own optional badge (e.g. "Popular") and short description are en + bn. **One highlighted card** (strong style + primary button; the others secondary). Until Module 8 checkout the buy button is **"Contact us"** (WhatsApp chat with the admin-set number; hidden when unset). Monthly/Yearly switch with "Save up to N%". The badge strings in the list below are the old launch-offer badges, kept for reference.
   - **Starter:** ~~৳999~~ **৳499/mo** (`50% Launch Offer`)
   - **Growth (Most Popular):** ~~৳2,499~~ **৳1,499/mo** (`40% Off`)
   - **Agency:** ~~৳5,999~~ **৳3,999/mo** (`33% Off`)
   - **Annual Toggle:** `"Save 2 Months Free"`
   - **10 Identical Rows (Starter | Growth | Agency):**
     1. Connected FB & IG Pages: `1` | `5` | `25`
     2. Monthly Comments Scanned: `2,500` | `15,000` | `75,000`
     3. Team / Moderator Seats: `1` | `3` | `10`
     4. Bangla/Banglish/EN AI Filter: `✓` | `✓` | `✓`
     5. Auto-Hide Scam & Poaching Links: `✓` | `✓` | `✓`
     6. Custom Keyword & BD Phone Blocklist: `✗` | `✓` | `✓`
     7. Brand-Voice Auto-Reply Templates: `✗` | `✓` | `✓`
     8. WhatsApp & Telegram Alerts: `✗` | `✓` | `✓`
     9. White-Label CSV/PDF Agency Reports: `✗` | `✗` | `✓`
     10. Priority Support & API Webhook Access: `✗` | `✗` | `✓`
8. **SEO FAQ Accordion:** 6 Bangla/Meta API/bKash questions using Animate UI `Accordion`.
9. **Dark-Contrast Footer CTA:** `#0F172A` surface with subtle `--primary` & `--accent` glow.

## 4. Technical SEO Metadata
- **Title (<=60 chars):** `ShieldComment BD | AI Facebook & TikTok Comment Blocker`
- **Description (<=155 chars):** `Auto-hide spam, bKash scams & competitor comments on Facebook & TikTok ads in Bangladesh. Supports Bangla, Banglish & English. Pay via bKash, Nagad & Visa.`
- **JSON-LD:** `SoftwareApplication` (`BDT 499`) + `FAQPage` schemas.
- **Where:** set title, description, Open Graph (`og:title`, `og:description`, `og:image`), `hreflang` and JSON-LD in the route's `head()` in TanStack Start so they are in the server HTML. Meta's link-preview crawler does not run JavaScript.

## 5. Client Dashboard (`/dashboard`) — Required Charts & Banner
- **Impersonation Banner:** Visible top alert bar when `impersonatedBy` is present in the Better Auth session.
- **Charts (Recharts):** Daily Comments Scanned vs. Auto-Hidden (**Line Chart**), Blocked Categories (**Bar Chart**), Comment Intent Breakdown (**Donut Chart**).
