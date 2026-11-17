# Tech Stack & Architecture (source of truth)

> **Parent Brief:** [`./base.md`](./base.md) | **Design:** [`../design/base.md`](../design/base.md)
>
> Decided 2026-11-17. If another doc disagrees with this file, this file wins.

## 1. Stack at a glance

| Layer | `backend/` | `admin/` (Super Admin panel) | `client/` (landing + merchant app) |
|---|---|---|---|
| Framework | [NestJS 12](https://docs.nestjs.com/) (TS strict, ESM) | [React](https://react.dev/) SPA on [Vite](https://vite.dev/) | [TanStack Start](https://tanstack.com/start/latest) (React, Vite-based, SSR) |
| Routing | NestJS controllers, prefix `/api` | [TanStack Router](https://tanstack.com/router/latest), **file-based** (`src/routes/`, `@tanstack/router-plugin/vite`) | TanStack Router file routes (built into Start) |
| Rendering | — | Client-side only, static build | Public pages SSR / prerendered. Logged-in app pages rendered in the browser |
| Auth | [Better Auth](https://www.better-auth.com/) server (mounted at `/api/auth/*`) | Better Auth React client (`better-auth/react`) | Better Auth React client |
| Data fetching | — | [TanStack Query](https://tanstack.com/query/latest) for **all** API calls | TanStack Query for **all** API calls |
| Client state | — | [Zustand](https://zustand-demo.pmnd.rs/) (UI, filters, theme) | Zustand (UI, filters, language) |
| UI | — | Tailwind 4 · [shadcn/ui](https://ui.shadcn.com/docs/theming) · [Animate UI](https://animate-ui.com/docs) · Recharts | Same as admin |
| ORM | [Drizzle ORM](https://orm.drizzle.team/) (`drizzle-orm/node-postgres` + `pg` Pool, wired through Nest's first-party [`@nestjs/drizzle`](https://docs.nestjs.com/data/drizzle.md)) · migrations with [drizzle-kit](https://orm.drizzle.team/docs/kit-overview) | — | — |
| Database | PostgreSQL: **[Neon](https://neon.tech/)** in staging/prod, Docker Postgres for local dev and e2e tests | — | — |
| Queue / cache | Redis + [BullMQ](https://docs.bullmq.io/). Redis also stores Better Auth sessions and rate limits | — | — |
| Tests | Vitest (unit + Supertest e2e) | Vitest | Vitest |
| Lint | oxlint | oxlint | oxlint |
| Container | Node 24 | nginx (static files + `/api` proxy) | Node 24 (TanStack Start server) |

**Not used:** Next.js, Supabase, Prisma, custom JWT auth (`@nestjs/jwt`), Jest.

## 2. Hosting & cost plan (launch on free tiers)

| Piece | Local dev | Staging / production |
|---|---|---|
| PostgreSQL | Docker `postgres` (host port 5433) | **Neon free tier**, Singapore region (`ap-southeast-1`). One branch per environment. |
| Redis | Docker `redis` or local Redis | **Redis Cloud free (30 MB)** with eviction set to `noeviction` (BullMQ needs this). Not Upstash: BullMQ uses up its command limit. |
| backend / admin / client | `npm run dev` or `docker compose up --build` | Docker images. Hosting provider not decided yet (Module 9). |

**Neon rules**
- `DATABASE_URL` = Neon **pooled** URL (host contains `-pooler`). The app uses it at runtime.
- `DIRECT_URL` = Neon **direct** URL. `drizzle.config.ts` and the migrate script use it. Locally both point at Docker Postgres.
- On the free tier, compute sleeps after about 5 minutes idle and wakes in under a second. Uptime monitors must **not** call `/api/health` every minute (it queries the DB and keeps Neon awake, which uses up free compute hours). Give monitors a DB-free liveness route (`/api/health/live`).

## 3. Authentication (Better Auth)

**Server (`backend/`)**
- `better-auth` with the **Drizzle adapter** (`better-auth/adapters/drizzle`, `provider: 'pg'`, `usePlural: true`, ids from `advanced.database.generateId` = UUIDv7), mounted in NestJS at `/api/auth/*` through the NestJS integration (`@thallesp/nestjs-better-auth`; NestJS 12 + ESM support must be proven in task SW-T3).
- Login method: email + password. Passwords are hashed with **argon2id** (`@node-rs/argon2`) through Better Auth's custom `password.hash/verify`.
- Sessions are stored in **Postgres** (`session` table, so they can be listed and revoked) with **Redis as `secondaryStorage`** for fast lookups. `cookieCache` is on (short max-age) so most requests skip the DB. This also keeps Neon asleep longer.
- Plugins:
  - **`organization`**: an organization **is a Workspace**. Rename the models to `Workspace` / `WorkspaceMember` / `WorkspaceInvitation`. Member roles: `owner`, `admin`, `moderator` (custom access control). Extra field `status`: `ACTIVE` | `SUSPENDED`. The session's `activeOrganizationId` is the current workspace.
  - **`admin`**: user `role` is `super_admin` or `user` (`adminRoles: ['super_admin']`). Ban and list users come from this plugin. It also adds `impersonatedBy` to the session.
  - Better Auth **rate limiting** with Redis storage.
- Email verification and password reset are turned on once an email provider is chosen (Module 1 or 7 decision).
- Global NestJS guard: every route needs a valid session. Open routes use `@Public()` (or the integration's `@AllowAnonymous()`). Health, Meta webhooks and the SSLCommerz IPN are public.
- **Impersonation** keeps the spec flow (Module 1): `POST /api/admin/clients/:workspaceId/impersonate` creates a 60-second single-use token, stores its hash in `ImpersonationAuditLog`, and returns `{ token, redirectUrl }`. A small custom Better Auth plugin endpoint `POST /api/auth/impersonate-exchange` checks and burns the token, then creates a short session for the workspace owner with `impersonatedBy = adminId` and `activeOrganizationId = workspaceId`, and sets the cookie on the **client** origin.

**Frontends**
- `authClient = createAuthClient({ plugins: [organizationClient(), adminClient()] })` from `better-auth/react`.
- Wrap auth reads in TanStack Query (`sessionQueryOptions` → `authClient.getSession()`), and wrap sign-in, sign-out and similar calls in `useMutation`. Route guards use `queryClient.ensureQueryData(sessionQueryOptions)`.
- The **session lives in an `httpOnly` cookie.** JavaScript never reads it, and auth tokens are never put in Zustand or `localStorage`.

## 4. Same-origin API and cookie isolation

Each frontend calls the API on **its own origin** at `/api/*`, and a proxy forwards it to the backend:

| Origin (prod) | Serves | `/api/*` goes to backend through |
|---|---|---|
| `admin.<domain>` | `admin/` static build | nginx in the admin container |
| `app.<domain>` | `client/` TanStack Start server | Start server route proxy (or a front reverse proxy) |
| `api.<domain>` | backend directly | used only by Meta webhooks and the SSLCommerz IPN/redirects |

Why:
- The session cookie becomes **host-only** to each app. A super admin stays logged in to `admin.` while impersonating a client in a new `app.` tab.
- Requests are same-origin, so no CORS or `SameSite` problems for the apps. Better Auth `trustedOrigins` lists both app origins.
- No `VITE_API_URL` build arg. The apps always call `/api`.
- **Local dev:** cookies ignore ports, so open the apps on `http://admin.localhost:5173` and `http://app.localhost:5174` (both resolve to 127.0.0.1). The Vite / Start dev servers proxy `/api` to `localhost:3000`.

## 5. Routing rules

**`admin/` (TanStack Router, SPA)**
- File routes in `src/routes/`. `__root.tsx` creates the router with context `{ queryClient }`.
- A `_authed.tsx` layout route checks the session in `beforeLoad` and redirects to `/admin/login`. It also requires `user.role === 'super_admin'`.
- Use `loader` with `queryClient.ensureQueryData(...)` to prefetch page data, and `validateSearch` for typed filters. `autoCodeSplitting` is on.

**`client/` (TanStack Start)**
- Public routes (`/`, `/bn`, legal pages) are **SSR / prerendered** for SEO and Meta link previews (`og:` tags in `head()`).
- Logged-in routes sit under a `_app` layout. Its `beforeLoad` checks the session; on the server it uses a server function that forwards the request cookie. The page components render in the browser: `ssr: 'data-only'` (SW-T7), so a signed-out request gets a server-side redirect and the session is dehydrated into the page.
- Language: `en` by default. The preference is stored in a **cookie** (`shield-lang`) so server-rendered HTML matches the browser. The public landing page also has a fixed Bangla URL `/bn` with `hreflang` links.

## 6. Database layer (Drizzle)

- **Schema** lives in TypeScript under `backend/src/db/schema/` (one file per area: `auth.ts`, `workspaces.ts`, …) and is re-exported from `schema/index.ts`. Better Auth tables are first generated with `npx @better-auth/cli generate` (Drizzle output) and then edited to our conventions.
- **Conventions:** table names are plural snake_case (`pgTable('workspace_members', …)`). Columns are camelCase in TS and become snake_case in SQL through `casing: 'snake_case'`, set in **both** `drizzle()` and `drizzle.config.ts`. Ids are `uuid().primaryKey().$defaultFn(() => uuidv7())`, made by the app. Timestamps are `timestamp({ withTimezone: true, precision: 3 })`. Postgres enums use `pgEnum`. Emails are stored lower-cased.
- **Client:** one `pg` Pool on `DATABASE_URL` → `drizzle({ client: pool, schema, casing: 'snake_case' })`, provided through `@nestjs/drizzle` and injected into services. Use the relational query API (`db.query.users.findFirst`) for reads and the SQL builder for writes. Wrap multi-step writes in `db.transaction()`.
- **Migrations:** `npx drizzle-kit generate --name <name>` writes SQL files to `backend/drizzle/` (commit them and review the SQL). Apply locally with `npx drizzle-kit migrate`. In Docker and prod, the `migrate` service runs a small script using `migrate()` from `drizzle-orm/node-postgres/migrator`, so the production image doesn't need drizzle-kit. Don't use `drizzle-kit push` outside throwaway local databases.
- **Tenant scoping:** every tenant query includes `eq(table.workspaceId, workspaceId)`. Keep this inside repository/service helpers so it can't be forgotten.
- **Tests:** e2e global setup runs the migrator against `shield_comment_test`.

## 7. Environment variables (backend)

`DATABASE_URL`, `DIRECT_URL`, `REDIS_URL`, `BETTER_AUTH_SECRET` (≥32 chars), `BETTER_AUTH_URL`, `TRUSTED_ORIGINS` (comma list of app origins), plus existing app vars. The old `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` are removed.
