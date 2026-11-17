# Project Brief & Three-Project Architecture

> **Parent Index:** [`../README.md`](../README.md) | **Tech Stack (source of truth):** [`./tech-stack.md`](./tech-stack.md) | **Design Tokens:** [`../design/base.md`](../design/base.md) | **Screens:** [`./screens-inventory.md`](./screens-inventory.md)

## 1. Project Overview
- **Working Title:** ShieldComment BD
- **Core Purpose:** Real-time AI moderation for Meta (Facebook & Instagram) ad comments—auto-hiding fake bKash/Nagad phishing scams, competitor poaching links, and abusive trolls while preserving and auto-replying to genuine buyer inquiries.
- **Phase 1 Launch Scope:** **Bangladesh only** (Dhaka, Chattogram, Sylhet, and nationwide F-commerce/DTC brands & digital agencies). Bangladesh has **64.0 million Facebook users** ([DataReportal Digital 2026: Bangladesh](https://datareportal.com/reports/digital-2026-bangladesh)).
- **Phase 2 Expansion:** International market expansion after achieving Bangladesh product-market fit, benchmarked against [FeedGuardians](https://trustmrr.com/startup/feedguardians) ($8,109–$8,372/mo on [TrustMRR](https://trustmrr.com/micro-saas-ideas)) and [CommentGuard](https://commentguard.io/pricing/).
- **Supported Comment Languages:** Bangla (Unicode), Banglish (Romanized Bangla, e.g., `"dam koto"`, `"inbox koren"`, `"amader page e kom"`), and English.

## 2. Three-Project Monorepo Structure
Full stack table, hosting plan and auth design: [`./tech-stack.md`](./tech-stack.md).

1. **`backend/`** — [NestJS 12](https://docs.nestjs.com/) + TypeScript (strict, ESM) modular monolith. PostgreSQL through [Drizzle ORM](https://orm.drizzle.team/) (+ drizzle-kit migrations): **[Neon](https://neon.tech/)** in staging/prod, Docker Postgres for local dev. Redis + BullMQ. **[Better Auth](https://www.better-auth.com/)** for sign-in, sessions, workspaces (`organization` plugin) and super admin (`admin` plugin). [Meta Facebook Pages API](https://developers.facebook.com/documentation/pages-api) (`pages_manage_engagement`, `pages_read_user_content`), [Instagram Platform Comment Moderation](https://developers.facebook.com/documentation/instagram-platform/comment-moderation) / [Instagram Webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks) (`instagram_manage_comments`), Bangla/Banglish AI Classifier, and [SSLCommerz V4 API](https://developer.sslcommerz.com/doc/v4/) ([SSLCommerz](https://sslcommerz.com/)) for **bKash, Nagad, Rocket, Visa, and Mastercard** in BDT (৳).
2. **`admin/` (Built FIRST)** — Top-Level Super Admin Panel. [React](https://react.dev/) SPA on Vite + **[TanStack Router](https://tanstack.com/router/latest) (file-based routes)** + TypeScript + Tailwind CSS + [Animate UI](https://animate-ui.com/docs) + [shadcn/ui](https://ui.shadcn.com/docs/theming) + Recharts + Better Auth React client. Built before the client panel to manage all clients, view platform-wide charts, handle support tickets, and perform **1-click client impersonation login**.
3. **`client/` (Built SECOND)** — Client Admin Panel & Public Landing Page. **[TanStack Start](https://tanstack.com/start/latest)** (React + file-based routes + SSR for the public landing page) + TypeScript + Tailwind CSS + [Animate UI](https://animate-ui.com/docs) + [shadcn/ui](https://ui.shadcn.com/docs/theming) + Recharts + Better Auth React client. Built for merchants and agencies with bilingual **English (default) & Bangla** support via `content(english, bangla)`.

## 3. Mandatory Frontend Engineering Rules
- **Routing:** File-based [TanStack Router](https://tanstack.com/router/latest) routes in `src/routes/` (`admin/` as a plain SPA, `client/` through TanStack Start). Guard pages in `beforeLoad`, prefetch data in `loader`, and type search params with `validateSearch`.
- **Auth:** [Better Auth](https://www.better-auth.com/) React client (`better-auth/react`). The session is an `httpOnly` cookie. Never store tokens in Zustand or `localStorage`.
- **State Management:** Use [Zustand](https://zustand-demo.pmnd.rs/) for global client state (active workspace selection, language preference, UI/filter state). The auth session itself comes from Better Auth through TanStack Query.
- **API Fetching:** Use [TanStack Query](https://tanstack.com/query/latest) (`@tanstack/react-query`) for all API queries, caching, and mutations, including Better Auth client calls. Apps call the API at same-origin `/api/*`.
- **UI & Theme:** Use [Animate UI](https://animate-ui.com/docs) + standard [shadcn/ui OKLCH CSS variables](https://ui.shadcn.com/docs/theming) (see [`../design/base.md`](../design/base.md)).
- **Sequential Build & Test Rule:** Complete and pass every test gate in `modules/module-0` through `modules/module-9` in order. Never skip ahead.
