# Complete Web App Screen Inventory (20 Screens)

> **Parent Brief:** [`./base.md`](./base.md) | **Admin UI Spec:** [`../design/admin.md`](../design/admin.md) | **Client UI Spec:** [`../design/client.md`](../design/client.md)

## Part A: `admin/` App — Top-Level Super Admin Panel (7 Screens, Built First)

Each route is a TanStack Router file route in `admin/src/routes/`.

| # | Screen Name | Route | Core Purpose & Key Components | Module |
| :--- | :--- | :--- | :--- | :--- |
| **A1** | Admin Login | `/admin/login` | Super Admin sign-in (Better Auth) & `super_admin` role guard | [`module-2`](./modules/module-2-admin-panel.md) |
| **A2** | Super Admin Dashboard | `/admin/dashboard` | Platform KPIs (Clients, BDT MRR, Scanned, Blocked, Tickets) + Recharts Line, Bar & Donut charts | [`module-2`](./modules/module-2-admin-panel.md) |
| **A3** | Clients Management List | `/admin/clients` | Searchable client table with **1-Click "Login as Client"** button, suspend/activate, quota override | [`module-2`](./modules/module-2-admin-panel.md) |
| **A4** | Platform Billing Ledger | `/admin/billing` | BDT revenue, bKash/Nagad/Visa SSLCommerz logs, failed IPNs | [`module-2`](./modules/module-2-admin-panel.md), [`module-8`](./modules/module-8-billing-sslcommerz.md) |
| **A5** | Support Ticket Inbox | `/admin/tickets` | Filterable ticket queue, reply thread, internal notes, status updates | [`module-2`](./modules/module-2-admin-panel.md) |
| **A6** | System & AI Queue Monitor | `/admin/system` | BullMQ queue depth, Meta webhook errors, AI latency & token cost | [`module-2`](./modules/module-2-admin-panel.md), [`module-5`](./modules/module-5-ai-moderation.md) |
| **A7** | Platform Plans & Defaults | `/admin/settings` | BDT pricing tiers, `PlanFeatureConfig` checkboxes/limits, default Bangla blocklists | [`module-2`](./modules/module-2-admin-panel.md) |

## Part B: `client/` App — Client Admin Panel (13 Screens, Built Second)

Each route is a TanStack Start file route in `client/src/routes/`. Only C1 is server-rendered. The logged-in screens render in the browser behind the `_app` session guard.

| # | Screen Name | Route | Core Purpose & Key Components | Module |
| :--- | :--- | :--- | :--- | :--- |
| **C1** | Public Landing & Pricing | `/`, `/bn` | Server-rendered (TanStack Start) SEO landing, >=80% Lighthouse Perf, `content(en, bn)`, promo BDT pricing matrix | [`module-8`](./modules/module-8-billing-sslcommerz.md) |
| **C2** | Client Auth & Impersonation | `/login`, `/register`, `/impersonate` | Better Auth session (email + password) + single-use Admin impersonation token exchange | [`module-3`](./modules/module-3-client-meta.md) |
| **C3** | Onboarding & Meta Wizard | `/onboarding` | OAuth connect Facebook Page & Instagram Business account | [`module-3`](./modules/module-3-client-meta.md) |
| **C4** | Client Overview Dashboard | `/dashboard` | Client KPIs + Recharts Line, Bar & Donut charts + Admin impersonation banner | [`module-6`](./modules/module-6-client-dashboard.md) |
| **C5** | Live Comment Feed | `/comments` | Filterable stream + AI confidence + manual Unhide/Hide/Delete/Reply | [`module-6`](./modules/module-6-client-dashboard.md) |
| **C6** | Connected Pages & Posts | `/pages` | Toggle auto-moderation per FB/IG Page, view active boosted posts | [`module-3`](./modules/module-3-client-meta.md), [`module-6`](./modules/module-6-client-dashboard.md) |
| **C7** | Moderation Rules & Blocklist | `/rules` | Bangla/Banglish keywords, URL/phone regex, auto-reply templates | [`module-6`](./modules/module-6-client-dashboard.md) |
| **C8** | AI Sandbox / Playground | `/playground` | Test sample Bangla/Banglish comments against AI + rules | [`module-6`](./modules/module-6-client-dashboard.md) |
| **C9** | Analytics & Agency Reports | `/analytics` | Historical Line/Bar charts + CSV/PDF export | [`module-6`](./modules/module-6-client-dashboard.md) |
| **C10** | Billing & Subscription | `/billing` | BDT plan, quota bar, SSLCommerz checkout (bKash/Nagad/Visa), invoices | [`module-8`](./modules/module-8-billing-sslcommerz.md) |
| **C11** | Team & Workspace Settings | `/settings/team` | Invite staff/moderators with RBAC (Owner, Admin, Moderator) | [`module-7`](./modules/module-7-support-team.md) |
| **C12** | Notification Preferences | `/settings/alerts` | Email, Telegram, and WhatsApp alerts for scam spikes | [`module-7`](./modules/module-7-support-team.md) |
| **C13** | Client Support Tickets | `/support` | Create ticket, attach screenshot, real-time reply thread with Admin | [`module-7`](./modules/module-7-support-team.md) |
