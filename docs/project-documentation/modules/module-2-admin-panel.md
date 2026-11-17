# Module 2: Top-Level Admin Panel (`admin/` App) — Charts, Clients, 1-Click Login & Tickets

> **Previous:** [`./module-1-auth-rbac.md`](./module-1-auth-rbac.md) | **Next:** [`./module-3-client-meta.md`](./module-3-client-meta.md) | **Admin UI Spec:** [`../../design/admin.md`](../../design/admin.md)

## Objective & Dependencies
Build the **Top-Level Super Admin Panel (`admin/`) FIRST** before any `client/` feature screens, including platform charts, client management with 1-click login, and the shared Support Ticket System. **Dependency:** Module 1.

## Backend Implementation (`backend/`)
- **SupportTicketsModule:**
  - `Ticket` (`id`, `workspace_id`, `user_id`, `subject`, `category`, `priority`, `status`: `OPEN` | `IN_PROGRESS` | `RESOLVED`, `created_at`)
  - `TicketMessage` (`id`, `ticket_id`, `sender_id`, `sender_role`: `ADMIN` | `CLIENT`, `body`, `is_internal_note`, `created_at`)
  - Endpoints: `GET /admin/tickets`, `POST /admin/tickets/:id/reply`, `PATCH /admin/tickets/:id/status`
- **AdminModule:**
  - `GET /admin/dashboard/stats` (KPIs + Recharts time-series arrays for BDT MRR, client growth, comments scanned vs. blocked, gateway split)
  - `GET /admin/clients`, `PATCH /admin/clients/:id/status`
  - `GET /admin/billing/transactions`, `GET /admin/system/health`
  - `GET/PATCH /admin/settings/plans` (edit `original_price_bdt`, `offer_price_bdt`, `offer_badge`, and `feature_config` checkboxes/limits)

## Frontend Implementation (`admin/`)
Build Screens **A1–A7** per [`../../design/admin.md`](../../design/admin.md) as **TanStack Router file routes** (`src/routes/admin/*`) using [Animate UI](https://animate-ui.com/docs), [Zustand](https://zustand-demo.pmnd.rs/), [TanStack Query](https://tanstack.com/query/latest), Recharts, and the Better Auth React client:
- **A1** (`/admin/login`: `authClient.signIn.email`, then require `role === 'super_admin'`; all other routes sit under an `_authed` layout whose `beforeLoad` redirects to login), **A2** (`/admin/dashboard` with Line, Bar, Donut charts), **A3** (`/admin/clients` with **1-Click "Login as Client"** button), **A4** (`/admin/billing`), **A5** (`/admin/tickets`), **A6** (`/admin/system`), **A7** (`/admin/settings`).

## Agent Test & Verification Gate
- Admin login E2E test passes (Better Auth session cookie on the admin origin; a non-super-admin user is refused).
- `GET /admin/dashboard/stats` returns valid chart series.
- Clicking "Login as Client" calls `POST /admin/clients/:id/impersonate`, writes `ImpersonationAuditLog`, and opens `client/` `/impersonate?token=...` in a new tab while the admin stays logged in to `admin/`.
- Admin ticket reply and status transition E2E tests pass.
