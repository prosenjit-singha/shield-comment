# Top-Level Admin Panel (`admin/`) UI & Charts Specification

> **Shared Tokens:** [`./base.md`](./base.md) | **Module Spec:** [`../project-documentation/modules/module-2-admin-panel.md`](../project-documentation/modules/module-2-admin-panel.md)

## 1. Layout & Navigation
- Vite SPA with TanStack Router file routes (`src/routes/`). The sidebar shell is the `_authed` layout route (`beforeLoad` requires a Better Auth session with `role === 'super_admin'`).
- Built **FIRST** using [Animate UI](https://animate-ui.com/docs) `Sidebar`, `Button` (`rounded-full`), `Tabs`, `Dialog`, and `DropdownMenu`.
- Clean light-first minimalist admin shell (`--muted` canvas `#F5F5F7`, borderless white `--card` panels).
- **Admin follows strict Apple geometry (`DESIGN.md`), overriding `base.md` §2:** `--radius` is 8px; pills (`rounded-full`) only for buttons, badges, switches, avatars, segmented tabs; cards, dialogs, inputs and menus `rounded-xl` (≈11px), never larger. Brand hues stay; neutrals are Apple grays, dark canvas is pure black. One soft shadow on floating layers only.

## 2. Super Admin Dashboard (`/admin/dashboard`) — Required Charts
Use Recharts paired with shadcn/ui `--chart-*` / `--primary` (`#0668E1`) / `--secondary` (`#FE2C55`) / `--accent` (`#25F4EE`) tokens:
1. **KPI Row (4 Cards with `CountingNumber`):** Active Clients, Monthly Recurring Revenue (BDT ৳), Total Comments Scanned, Open Support Tickets.
2. **Monthly BDT Revenue & Client Growth (Line Chart):** Dual-axis smooth monotone line chart.
3. **Daily Comments Scanned vs. Spam Blocked (Bar Chart):** Grouped rounded-top bars (`--primary` vs. `--secondary`).
4. **Plan Tier Distribution (Donut Chart):** Starter vs. Growth vs. Agency share.
5. **Payment Gateway Split (Bar Chart):** bKash vs. Nagad vs. Visa/Mastercard volume via [SSLCommerz](https://sslcommerz.com/).

## 3. Clients List (`/admin/clients`) & 1-Click Client Login
- Searchable table with Plan badge, Quota progress bar, Status pill (`rounded-full`), and a prominent **`Login as Client`** (`rounded-full`, `--primary`) button per row.
- Clicking `Login as Client` invokes `POST /admin/clients/:workspaceId/impersonate` and opens `client/` `/impersonate?token=...` in a new tab.

## 4. Support Ticket Inbox (`/admin/tickets`)
- Split-pane inbox: Left ticket queue (filterable by `OPEN`, `IN_PROGRESS`, `RESOLVED`, Priority); Right conversation thread with internal admin notes toggle and status dropdown.
