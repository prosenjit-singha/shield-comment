# ShieldComment BD

AI moderation for Meta (Facebook / Instagram) ad comments, built for Bangladesh F-commerce brands. It hides bKash/Nagad scams, competitor poaching and abuse, and understands Bangla, Banglish and English.

## Apps

Three independent npm projects (no workspaces):

| Folder | What | Local URL |
|---|---|---|
| `backend/` | NestJS API (Drizzle + PostgreSQL, Better Auth, Redis + BullMQ), prefix `/api` | `http://localhost:3000` |
| `admin/` | Super admin SPA (Vite + TanStack Router) | `http://admin.localhost:5173` |
| `client/` | Customer app + SSR landing page (TanStack Start, English/Bangla) | `http://app.localhost:5174` |

`docker-compose.yml` runs Postgres, Redis, the backend and both apps. `e2e/` holds the Playwright suite.

## Commands

```bash
cp .env.example .env && cp backend/.env.example backend/.env   # then fill in the values (never commit .env files)
docker compose up --build                 # everything
docker compose up -d postgres redis       # infra only, for local dev
cd backend && npm run start:dev           # backend dev server
cd backend && npm run build && npm test && npm run test:e2e
cd backend && npx drizzle-kit generate --name <name>   # after a schema change, then review the SQL
cd backend && npx drizzle-kit migrate                  # apply migrations locally
cd admin && npm run dev                   # same for client/
./shield-cli add super-admin              # create a platform super admin
scripts/tunnel.sh                         # public zrok2 tunnel to the backend for Meta webhooks
```

## Docs

- [`AGENTS.md`](AGENTS.md): rules for contributors and coding agents.
- [`docs/README.md`](docs/README.md): documentation index (project brief, tech stack, module specs, design).
- [`docs/progress/TASKS.md`](docs/progress/TASKS.md) and [`docs/progress/MEMORY.md`](docs/progress/MEMORY.md): progress and project facts.
- [`docs/project-documentation/meta-webhooks-local.md`](docs/project-documentation/meta-webhooks-local.md): Meta test app + local webhook tunnel setup.
