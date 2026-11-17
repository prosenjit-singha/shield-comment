# AGENTS.md — ShieldComment BD

AI moderation for Meta (FB/IG) ad comments for Bangladesh F-commerce brands. It hides bKash/Nagad scams, competitor poaching and abuse. It understands Bangla, Banglish and English.

## Repo layout (3 independent npm projects, no workspaces)
```
backend/   NestJS 12 (TS strict, ESM) · Drizzle ORM + drizzle-kit · PostgreSQL (Neon in prod, Docker locally) · Better Auth · Redis + BullMQ · port 3000, prefix /api
admin/     React SPA + Vite + TS · TanStack Router (file routes) · Better Auth client · Tailwind · shadcn/ui + Animate UI · Recharts   (built FIRST)
client/    TanStack Start (React, file routes, SSR landing) + TS · same UI stack · Better Auth client · bilingual content(en, bn)   (built SECOND)
docker-compose.yml   one command for postgres + redis + backend + admin + client
docs/      specs. Progress files: docs/progress/TASKS.md, docs/progress/MEMORY.md
```
**Stack source of truth:** `docs/project-documentation/tech-stack.md` (stack table, Neon/Redis hosting, Better Auth design, same-origin `/api` proxy, routing rules). Not used: Next.js, Supabase, Prisma, `@nestjs/jwt`, Jest.

## Token-saving rules for agents (IMPORTANT)
1. **Start every session by reading `docs/progress/MEMORY.md` and `docs/progress/TASKS.md`.** Read nothing else until you need it.
2. Open only the module spec you are working on: `docs/project-documentation/modules/module-N-*.md`. For UI work, also open `docs/design/base.md` plus `admin.md` or `client.md`.
3. Do **one task at a time** (one TASKS.md row). Don't build a whole module in one go.
4. When a task is finished, in this order:
   1. Update its row in TASKS.md (and the verification log) and add any lasting facts to MEMORY.md (keep it short).
   2. **Commit** all of the task's changes with a short, professional [Conventional Commits](https://www.conventionalcommits.org/) message: `type(scope): summary` (imperative, lower case, no period, ≤ 72 chars), e.g. `feat(backend): replace Prisma with Drizzle ORM (SW-T2)`. Types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`. Optional body: 2–4 bullet lines. Never commit `.env` files or build output.
   3. End with a copy-paste prompt for the next session.
5. Build modules 0 to 9 in order. Pass each module's "Agent Test & Verification Gate" before you start the next.

## Commands
```bash
# infra only (local dev)
docker compose up -d postgres redis
# everything
docker compose up --build
# backend
cd backend && npm run start:dev      # dev
cd backend && npm run build && npm test && npm run test:e2e
cd backend && npx drizzle-kit generate --name <name>   # after schema change, then review the SQL
cd backend && npx drizzle-kit migrate                  # apply migrations locally
```

## Backend gotchas (read before you edit backend/)
- The code is **ESM**: relative imports end in `.js`. Tests use **Vitest** (`vi.fn()`, not `jest`). Lint uses `oxlint`. See `backend/AGENTS.md` for NestJS 12 notes.
- Drizzle ORM: schema is TypeScript in `backend/src/db/schema/` (no code generation step). The app connects with a `pg` Pool on `DATABASE_URL` (Neon **pooled** URL in prod) through `@nestjs/drizzle`. `drizzle.config.ts` and the migrate script use `DIRECT_URL` (Neon direct URL). Set `casing: 'snake_case'` in both `drizzle()` and `drizzle.config.ts`. Migrations are SQL files in `backend/drizzle/`; never `drizzle-kit push` against shared databases. Details: `docs/project-documentation/tech-stack.md` §6.
- Prisma is gone (SW-T2). Ignore the `prisma-*` agent skills in `backend/.claude/skills`.
- Vitest doesn't emit decorator metadata. In DTOs/env classes, use an explicit `@Type(() => Number)` for numbers.
- npm 11 blocks install scripts unless they're listed in `allowScripts` in package.json. Run `npm approve-scripts <pkg>` when needed.
- Global wiring lives in `configureApp()` (`src/app.setup.ts`): prefix, ValidationPipe, AllExceptionsFilter, CORS. `main.ts` and e2e tests both call it. Build e2e apps with `test/utils/create-test-app.ts`.
- Auth is **Better Auth**, mounted at `/api/auth/*` (Drizzle adapter, Redis `secondaryStorage`, `organization` plugin = workspaces, `admin` plugin = super admin). A global session guard protects every route. Mark open routes with `@Public()`. Don't add `@nestjs/jwt` or hand-rolled tokens (the old JWT code was removed in SW-T4).
- Don't let uptime monitors hit `/api/health` often: it queries the DB and keeps Neon's free compute awake. Use `/api/health/live`.

## Engineering rules
- TypeScript strict everywhere. Don't use `any` unless you justify it.
- Backend: global `ValidationPipe` (whitelist, forbidNonWhitelisted, transform), global exception filter, Pino logging (`nestjs-pino`). Every tenant query must be scoped by `workspace_id`.
- Frontend: file-based TanStack Router routes in `src/routes/` (`admin/` SPA, `client/` via TanStack Start). Guards in `beforeLoad`, data in `loader`. Better Auth React client for auth; the session is an `httpOnly` cookie, so never keep tokens in Zustand or `localStorage`. Apps call the API at same-origin `/api/*`. Zustand for global UI state. TanStack Query for **all** API calls (Better Auth calls included). Use shadcn OKLCH tokens from `docs/design/base.md` and no custom CSS variable names. Buttons, pills and inputs are `rounded-full`. Cards are `rounded-2xl`/`3xl`.
- Client app text: always `content(english, bangla)` from `useLanguage()`. Default is `'en'`.
- Currency is BDT (৳). Payments go through SSLCommerz V4.
- Secrets live only in `.env` (git-ignored). Keep `.env.example` up to date.
