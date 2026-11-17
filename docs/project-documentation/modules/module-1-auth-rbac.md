# Module 1: Backend Auth (Better Auth), Super Admin RBAC, Multi-Tenancy & 1-Click Impersonation API

> **Previous:** [`./module-0-scaffolding.md`](./module-0-scaffolding.md) | **Next:** [`./module-2-admin-panel.md`](./module-2-admin-panel.md) | **Brief:** [`../base.md`](../base.md) | **Auth design:** [`../tech-stack.md`](../tech-stack.md#3-authentication-better-auth)

## Objective & Dependencies
Implement [Better Auth](https://www.better-auth.com/) session authentication, Super Admin role separation, strict multi-tenant workspace isolation, and the audit-logged 1-click client impersonation token API. **Dependency:** Module 0.

## Database Schema (`backend/`)
Better Auth owns the core auth tables. Generate the Drizzle schema with the Better Auth CLI (`npx @better-auth/cli generate`), then edit it to repo conventions (UUIDv7 ids, plural snake_case tables, `casing: 'snake_case'` columns, `timestamptz(3)`) in `src/db/schema/`:
- `User` (Better Auth core + `admin` plugin): `id`, `email`, `email_verified`, `name` (full name), `role`: `super_admin` | `user`, `banned`, `created_at`, `updated_at`
- `Session` (core + plugins): `id`, `user_id`, `token`, `expires_at`, `ip_address`, `user_agent`, `active_organization_id` (current workspace), `impersonated_by`
- `Account` (core): password hash (argon2id) for email/password, later OAuth providers
- `Verification` (core): email verification and password reset tokens
- `Workspace` (`organization` plugin, renamed): `id`, `name`, `slug`, `status`: `ACTIVE` | `SUSPENDED`, `created_at`
- `WorkspaceMember` (`organization` plugin `member`, renamed): `id`, `workspace_id`, `user_id`, `role`: `owner` | `admin` | `moderator`
- `WorkspaceInvitation` (`organization` plugin `invitation`, renamed). Used by Module 7.
- `ImpersonationAuditLog` (custom): `id`, `admin_id`, `target_workspace_id`, `token_hash`, `expires_at`, `used_at`, `ip_address`

## API Endpoints & Guards (`backend/`)
- **Better Auth (built in, `/api/auth/*`):** `POST /sign-up/email` (creates the user; a hook also creates their first Workspace with role `owner`), `POST /sign-in/email`, `POST /sign-out`, `GET /get-session`, plus `organization/*` and `admin/*` plugin routes.
- `GET /api/me`: the user plus their workspaces, active workspace and `impersonatedBy`.
- `POST /api/admin/clients/:workspaceId/impersonate` (protected by `SuperAdminGuard`): generates a 60-second single-use token, hashes it into `ImpersonationAuditLog`, and returns `{ token, redirectUrl }` (`redirectUrl` = client `/impersonate?token=...`).
- `POST /api/auth/impersonate-exchange` (custom Better Auth plugin endpoint): validates the token and marks it `used_at = now()`, then creates a short Better Auth session for the workspace owner with `impersonatedBy: adminId` and `activeOrganizationId: workspaceId`, and sets the session cookie on the client origin.
- Guards: global session guard (`@Public()` to opt out), `RolesGuard`, `SuperAdminGuard` (`user.role === 'super_admin'`, rejects impersonated sessions), `WorkspaceAccessGuard` (non-member → `404`, suspended workspace or too-low member role → `403`, impersonated session locked to its workspace). Every tenant query is scoped by `workspace_id`.
- `npm run create-super-admin` script (email and password from env) to create the first super admin.

## Agent Test & Verification Gate
- Vitest unit tests verify argon2id password hashing and single-use impersonation token expiration/reuse rejection.
- Supertest E2E tests verify: Better Auth sign-up/sign-in/session; tenant isolation (User A cannot access Workspace B → `403`/`404`); a non-admin cannot call `/api/admin/clients/:id/impersonate`; the exchange returns a session with `impersonatedBy`.
