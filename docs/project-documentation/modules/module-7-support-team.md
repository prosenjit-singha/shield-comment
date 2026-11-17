# Module 7: Client Support Ticket Portal, Team RBAC & Alerts

> **Previous:** [`./module-6-client-dashboard.md`](./module-6-client-dashboard.md) | **Next:** [`./module-8-billing-sslcommerz.md`](./module-8-billing-sslcommerz.md)

## Objective & Dependencies
Connect `client/` to the shared `SupportTicketsModule`, add team member RBAC invitations, and configure Email/Telegram/WhatsApp scam-spike alerts. **Dependency:** Module 6.

## Backend Implementation (`backend/`)
- Client-scoped ticket endpoints: `GET /support/tickets`, `POST /support/tickets`, `POST /support/tickets/:id/reply`.
- `AlertSettings` table + spike dispatcher queue when hourly scam count exceeds `spike_threshold`.
- Workspace invites and member roles through the Better Auth `organization` plugin (`organization/invite-member`, `organization/accept-invitation`, `organization/update-member-role`, `organization/remove-member`), with seat limits checked against the plan. Invitation emails use the transactional email provider.

## Frontend Implementation (`client/`)
Build Screens **C11** (`/settings/team`), **C12** (`/settings/alerts`), and **C13** (`/support`) with `content(english, bangla)`.

## Agent Test & Verification Gate
- Round-trip E2E test: Client creates ticket in `/support` -> appears in `admin/` `/admin/tickets` -> Admin replies -> Client sees reply in `/support`.
- Mocked alert test fires when scam threshold is exceeded.
