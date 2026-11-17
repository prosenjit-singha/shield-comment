# Module 0: Three-Project Monorepo Scaffolding, Database & Infra

> **Parent Brief:** [`../base.md`](../base.md) | **Tech Stack:** [`../tech-stack.md`](../tech-stack.md) | **Design Tokens:** [`../../design/base.md`](../../design/base.md) | **Next:** [`./module-1-auth-rbac.md`](./module-1-auth-rbac.md)

## Objective & Dependencies
Initialize the `backend/`, `admin/`, and `client/` projects with shared TypeScript strictness, Docker infrastructure, Better Auth, file-based routing, and UI/state foundations. Stack details: [`../tech-stack.md`](../tech-stack.md). **Dependencies:** None.

## Backend Tasks (`backend/`)
1. Scaffold [NestJS 12](https://docs.nestjs.com/) + TypeScript (strict, ESM, Vitest, oxlint).
2. Create the root `docker-compose.yml` with PostgreSQL 15+ (local dev and e2e only) and Redis 7+. Staging/prod use **Neon** Postgres and Redis Cloud instead.
3. Initialize [Drizzle ORM](https://orm.drizzle.team/) (`drizzle-orm/node-postgres` + `pg`, via `@nestjs/drizzle`), the TypeScript schema in `src/db/schema/`, and the initial drizzle-kit migration. `drizzle.config.ts` and the migrate script use `DIRECT_URL`. The app connects with `DATABASE_URL` (Neon pooled URL in prod). Rules: [`../tech-stack.md`](../tech-stack.md#6-database-layer-drizzle).
4. Install [Better Auth](https://www.better-auth.com/) with the Drizzle adapter, mounted at `/api/auth/*` through the NestJS integration. Add the global session guard (`@Public()` to opt out). Use Redis as `secondaryStorage`.
5. Expose `GET /api/health` (DB latency + Redis ping) and a DB-free `GET /api/health/live` for uptime monitors.
6. Configure global `ValidationPipe`, HTTP exception filter, and Pino structured logging.

## Frontend Tasks (`admin/` & `client/`)
1. **`admin/`:** React + TypeScript SPA on Vite with **TanStack Router file-based routes** (`@tanstack/router-plugin/vite`, `src/routes/`, `autoCodeSplitting`). Router context carries `queryClient`.
2. **`client/`:** **TanStack Start** app (React + TypeScript, file-based routes, SSR). Public routes server-rendered. Logged-in routes under an `_app` layout rendered in the browser.
3. In both: Tailwind CSS, [shadcn/ui](https://ui.shadcn.com/docs/theming), and [Animate UI](https://animate-ui.com/docs) (`npx @animate-ui/cli@latest animate all`). Standard shadcn/ui OKLCH CSS variables in `globals.css` per [`../../design/base.md`](../../design/base.md).
4. In both: [Zustand](https://zustand-demo.pmnd.rs/) + [TanStack Query](https://tanstack.com/query/latest) (`QueryClientProvider`). Better Auth React client (`authClient`) with `sessionQueryOptions`. Calls go to same-origin `/api/*` (dev-server proxy locally; nginx / Start server proxy in prod).
5. **In `client/` only:** `useLanguageStore` (Zustand, `'en' | 'bn'`, default `'en'`, persisted to the `shield-lang` **cookie** so SSR matches) and export `content(english: string, bangla: string)` via `useLanguage()`.

## Agent Test & Verification Gate
- `npm run build` succeeds in `backend/`, `admin/`, and `client/` with zero TypeScript errors.
- `GET /api/health` returns `200 OK` with `"database": "up"` and `"redis": "up"`.
- Better Auth e2e: sign up → sign in → `GET /api/auth/get-session` returns the user. A protected route returns `401` without a session cookie.
- `admin/`: visiting a protected route without a session redirects to `/admin/login`.
- `client/`: the server HTML for `/` already contains the landing `<h1>` (SSR works without JavaScript).
- Unit test in `client/` verifies `content("Hello", "হ্যালো")` returns `"Hello"` by default and `"হ্যালো"` when switched to `'bn'`.
