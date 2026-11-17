# Project Memory (keep this under ~40 lines: facts and decisions only)

## Decisions
- **Stack switch (2026-11-17), see `docs/project-documentation/tech-stack.md`:** admin = Vite SPA + TanStack Router file routes. client = TanStack Start (SSR landing at `/` + `/bn`, logged-in app rendered in the browser). Auth = Better Auth (replaces custom JWT; `organization` plugin = workspaces, `admin` plugin = super admin, Redis `secondaryStorage`). ORM = Drizzle (replaces Prisma, decided 2026-11-17). DB = Neon in prod (pooled `DATABASE_URL`, direct `DIRECT_URL` for migrate), Docker Postgres locally. Redis Cloud free in prod (`noeviction`). Not Next.js, not Supabase. Rework rows: TASKS.md Module 0b.
- Same-origin API: each app calls `/api/*` on its own origin, proxied to the backend, so session cookies are host-only per app (admin stays logged in while impersonating). Dev URLs: `admin.localhost:5173`, `app.localhost:5174`.
- Three independent npm projects (`backend/`, `admin/`, `client/`). No npm workspaces, which keeps the Docker builds simple.
- Docker: one **root `docker-compose.yml`** starts everything (`docker compose up --build`). Each project has its own multi-stage Dockerfile. Module 0 asked for `backend/docker-compose.yml`; it moved to the root so one command covers all three apps.
- The `migrate` compose service runs the backend **runtime** image with `node dist/db/migrate.js` (Drizzle `migrate()` on `backend/drizzle/`) before `backend` starts. Journal table: `drizzle.__drizzle_migrations`. Migrations use `DIRECT_URL` ‖ `DATABASE_URL` (`migrationDatabaseUrl()`; drizzle.config inline); runtime only `DATABASE_URL`. Scripts: `db:generate` / `db:migrate` (drizzle-kit, local) · `db:deploy` (built migrator).
- Health returns 503 (not 200) when any dependency is down. The body always has `database`, `redis` and `latencyMs`. `GET /api/health/live` is DB-free (Docker HEALTHCHECK + uptime monitors use it); both health routes are skipped by pino auto-logging (`isHealthProbe`).
- Admin UI: shadcn `radix-nova` preset (Radix base), Animate UI via `npx @animate-ui/cli@latest animate all` (rewrites installed shadcn components to `@animate-ui/react` primitives; run it again after every `shadcn add`). Buttons/badges/inputs edited to `rounded-full`. Fonts: Plus Jakarta Sans + Noto Sans Bengali (fontsource variable, `font-bangla` utility).
- Admin wiring: providers live in `src/providers/app-providers.tsx`. `createQueryClient()` defaults: staleTime 30s, retry 1, no refetch on focus. UI store persists to localStorage key `shield-admin-ui`; `.dark` on <html> follows it.
- Frontend Docker: `VITE_API_URL` is a **build arg** (Vite inlines it); compose passes `ADMIN_API_URL` / `CLIENT_API_URL`. **Goes away in SW-T6/T6** (same-origin `/api`). Client runtime becomes a Node server (TanStack Start). Runtime is `nginxinc/nginx-unprivileged` (non-root, listens on the app port directly).
- With `--radius: 1rem`, shadcn's scale differs from Tailwind defaults: `rounded-lg`=16px, `rounded-xl`≈22px, `rounded-2xl`≈29px, `rounded-3xl`≈35px.
- Client was scaffolded by **copying admin** (to be re-scaffolded on TanStack Start in SW-T7, reusing `components/ui` + `globals.css`) (same lockfile/versions, `globals.css`, `components/ui`). Keep the two in sync: a new shadcn component goes through `shadcn add` + `animate all` in each app.
- Client language: `useLanguage()` from `@/hooks/use-language` gives `content(en, bn)`; store persists to localStorage key `shield-client-lang` (moves to cookie `shield-lang` in SW-T7 for SSR); `<html lang>` follows it. Client tests: Vitest 5 + jsdom (`npm test`), config in `vite.config.ts`.
- DB conventions: use `id()`, `timestamptz()`, `timestamps` from `src/db/schema/columns.ts` (UUIDv7 via `uuidv7`, `timestamptz(3)`, `updatedAt` `$onUpdate`). camelCase TS → snake_case SQL via `casing: 'snake_case'` (db.module + drizzle.config). Plural snake_case tables, emails lower-cased. Inject `@InjectDrizzle() db: Database`; override in tests with `getDrizzleToken()`.
- `backend/legacy-auth/` = reference-only old code (JWT guards, workspaces/admin drafts, last Prisma schema). Excluded from build/lint/tests/Docker. Read its README before porting.
- Better Auth (SW-T3/T4, Drizzle): `better-auth` 1.7.25 + `@thallesp/nestjs-better-auth` 2.8.0. Config `src/auth/better-auth.ts`, module `src/auth/auth.module.ts`. Needs `bodyParser: false` in `NestFactory.create` **and** `createNestApplication`. `disableTrustedOriginsCors: true` (CORS in `configureApp`). Auth table TS keys must match Better Auth field names; org plugin uses modelName `workspace`/`workspaceMember`/`workspaceInvitation` (+ `usePlural`) and `fields.organizationId: 'workspaceId'`; session keeps `activeOrganizationId`. Env: `BETTER_AUTH_SECRET` (≥32), `BETTER_AUTH_URL`, `TRUSTED_ORIGINS`.
- **Global guard is on** (the lib's `AuthGuard`, metadata key `PUBLIC`). `@Public()` (`src/auth/decorators/public.decorator.ts`) re-exports `@AllowAnonymous()`; also `@OptionalAuth()`, `@Session()` from the lib. Unknown routes still 404.
- New sessions get `activeOrganizationId` = oldest membership (`session.create.before`); sign-up also creates that workspace. The Drizzle adapter runs **without transactions** (the hook relies on it). Users can still create more workspaces via `organization/create` (default; revisit with plans). Cookie cache 5 min ⇒ role/ban/revoke changes can lag ≤5 min.
- `AUTH_SECONDARY_STORAGE` (Redis, keys `auth:*`) lives in `RedisModule`; e2e overrides it with `test/utils/memory-secondary-storage.ts`. Rate limit off when `NODE_ENV=test`; IP comes from `X-Forwarded-For` (proxies must set it, SW-T5/T6). `PasswordService` (`@node-rs/argon2`, no install scripts; don't import `Algorithm`, the const enum breaks isolatedModules).
- Backend HTTP wiring is `configureApp()` in `src/app.setup.ts`; e2e uses `test/utils/create-test-app.ts` (real Postgres `shield_comment_test` on :5433, Redis stubbed, files run serially, use `uniqueEmail()`).
- Error shape for every error: `{ statusCode, error, message, path, timestamp }`.

## Environment facts
- WSL2, Node 24, npm 11 (it blocks install scripts; approved ones are in `allowScripts` in package.json).
- Docker 29.9 now works in WSL. A **local Postgres 18 owns 5432** and local Redis owns 6379, so root `.env` maps Docker to `POSTGRES_HOST_PORT=5433` / `REDIS_HOST_PORT=6380`. `backend/.env` uses Docker Postgres `localhost:5433` (user/pass `shield`) and local Redis 6379.
- Docker npm installs sometimes fail with `ECONNRESET`. Just retry the build.
- `nest new` / the old `prisma init` also wrote agent skill folders (`backend/.agents`, `.claude`, `.windsurf`, `skills-lock.json`). They're harmless and excluded in `.dockerignore`.

## Versions
- admin: Vite 8 · React 19 · TS 7 (tsgo) · Tailwind 4.3 · shadcn CLI 4.23 (`cn` package replaces clsx+tailwind-merge) · @animate-ui/react 2.4 + motion 14 · zustand 5.1 · @tanstack/react-query 5.108
- NestJS 12 (ESM) · drizzle-orm 0.45 + drizzle-kit 0.31 + @nestjs/drizzle 0.0.2 · ioredis 6 · nestjs-pino 5 · Vitest 4 · TypeScript 6

## Ports
- backend 3000 · admin 5173 · client 5174 · postgres 5432 · redis 6379
