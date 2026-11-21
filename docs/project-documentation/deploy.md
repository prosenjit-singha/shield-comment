# Deploy runbook (Module 9)

**Staging runs on Fly.io's Free plan** (Module 9 D16, revised 2026-11-21 in M9-T10b; the Oracle VPS plan was dropped because the Oracle sign-up did not work): see [Staging (Fly.io Free plan)](#staging-flyio-free-plan) below. Sections 1–7 describe **Fly.io production, the production candidate**: the production host is still open and is decided at the M9-T17 pre-check. Their "staging" columns give the staging values for the same variables.

## Staging (Fly.io Free plan)

Decision D16 (user, 2026-11-21: "Fly.io free plan"). Plan terms as the user saw them: "$5 of usage, every month · Up to 3 Machines and 3 Sprites · 1 user · At $5, you move to Pay As You Go and keep running · Credit card required". **Target: $0.** The $5 is not a hard cap: past it Fly bills the card. Data stays on Neon `staging` + its own Redis Cloud DB (D5); no Fly Postgres, no Fly volumes.

| Fly app | Config | Host | Machine | Serves |
|---|---|---|---|---|
| `shield-comment-api-staging` | `backend/fly.staging.toml` | `https://shield-comment-api-staging.fly.dev` | shared-cpu-1x **512 MB, always on** | API + BullMQ workers/schedulers; Meta webhooks, deauthorize/data deletion and Telegram hit it directly |
| `shield-comment-app-staging` | `client/fly.staging.toml` | `https://shield-comment-app-staging.fly.dev` | shared-cpu-1x 256 MB, **auto-stop** | client (Start server), `/api/*` → backend over the private network |
| `shield-comment-admin-staging` | `admin/fly.staging.toml` | `https://shield-comment-admin-staging.fly.dev` | shared-cpu-1x 256 MB, **auto-stop** | admin nginx, `/api/*` → backend over the private network |

App names are placeholders until created (names are global: if one is taken, change it in the file, the secrets and every URL below). Production files (`fly.toml`) are unchanged; the staging files differ only in app name, sizing, auto-stop and deploy strategy, and `python3 scripts/check-fly-config.py` checks both (`--self-test` proves each rule fails when broken).

- **Why 512 MB for the backend:** it idles at ~170 MB RSS in local compose; 256 MB leaves no room for load or a `fly ssh` migration. The client (~80 MB) and admin nginx (~20 MB) fit 256 MB.
- **Auto-stop (client, admin):** `auto_stop_machines = "stop"`, `auto_start_machines = true`, `min_machines_running = 0`. The Fly proxy stops an idle machine after a few minutes and starts it on the next request (that request waits a few seconds). The backend stays on (`"off"`, exactly 1): Meta webhooks and the BullMQ jobs (03:00 / 15-min / hourly) need it.
- **Exactly 3 machines (the plan's cap):** first deploy with `--ha=false` (else Fly creates 2 machines per app); `strategy = "rolling"` (updates the one machine in place; `bluegreen`/`canary` start a second one); **no `release_command`** (it runs on an extra one-off machine); build with `--local-only` (local Docker, no remote builder machine; whether a builder counts against the cap is not verified). Don't use `fly console` (starts a new machine), `fly scale count 2` or `fly machine clone` on staging; `fly ssh console` is fine (it enters the running machine).

### Monthly cost (verified 2026-11-21, M9-T13)

| Item | Price / month |
|---|---|
| Backend, shared-cpu-1x 512 MB, always on in `sin` (730 h) | ≈ US$4.68 |
| Client + admin, shared-cpu-1x 256 MB in `sin`, only while running | ≈ US$0.0038 per machine-hour each |
| Stopped machines (root filesystem) | a few cents |
| Shared IPv4 + IPv6 (no dedicated IPv4) | US$0 |
| Outbound data (staging traffic) | cents |
| **Total** | **≈ US$4.7 + US$0.0038 per client/admin running hour** |

Prices from fly.io/pricing, checked at M9-T13 (`sin` costs more than the US regions). The backend alone uses most of the US$5: client + admin fit about **84 machine-hours a month** (≈ 42 h with both up) before the total passes US$5. Fly's docs say a personal org's bill under US$5 is waived. **No spend alert or limit** was found in the billing settings. The Fly CLI does not show usage: check the dashboard's usage/billing page (weekly at first).

**Staying under US$5:** keep the sizes above; never add a dedicated IPv4 (`fly ips allocate-v4` without `--shared`), volumes, Fly Postgres/Redis or a second machine; leave client/admin on auto-stop; point uptime monitors only at the always-on backend (a 5-minute monitor on `/healthz` would keep client/admin awake all month). The org is at the plan's 3-machine cap after the first deploy (flyctl prints "Your organization has reached its limit of 3 Machines"): rolling deploys update in place and still work.

### Staging env (D3 revised in M9-T10b)

Secrets per app, as in §7 (staging column): `TRUSTED_ORIGINS=https://shield-comment-app-staging.fly.dev,https://shield-comment-admin-staging.fly.dev`, `BETTER_AUTH_URL=https://shield-comment-api-staging.fly.dev`, `CLIENT_APP_URL=https://shield-comment-app-staging.fly.dev`, client `PUBLIC_SITE_URL=https://shield-comment-app-staging.fly.dev`, client + admin `API_UPSTREAM=http://shield-comment-api-staging.internal:3000`, `CORS_ORIGINS` unset. In the files (`[env]`): backend `TRUST_PROXY_HOPS=1`, client + admin `FORWARDED_FOR_MODE=pass`. Separate admin origin = separate Better Auth cookies.

**Client IP:** the `*.fly.dev` hosts go through the same Fly edge as a custom domain (it appends the visitor to `X-Forwarded-For`), and an auto-started machine gets the same request with the same headers once it is up, so §2 holds unchanged: `TRUST_PROXY_HOPS=1` on both paths (app proxy → backend, and direct `shield-comment-api-staging.fly.dev`). Verify with the §2 steps on the staging hosts at M9-T13.

### First deploy (M9-T13, each step with the user's approval)

1. **Account** (user): Fly.io account on the Free plan with a card; `fly auth login` on the developer machine.
2. **Apps**: `fly apps create shield-comment-api-staging`, `… shield-comment-app-staging`, `… shield-comment-admin-staging`.
3. **Data**: Neon **schema-only** `staging` branch (see "Staging data" below; git-ignored `backend/.env.staging` holds its URLs + `DIRECT_URL` for migrations) and a new Redis Cloud free DB with `noeviction` (§3 step 2, §6 check). **Object storage stays unset on staging** (user, M9-T13: the schema-only branch has no bucket; `AWS_*`/`STORAGE_BUCKET` are optional, uploads answer "Object storage is not configured").
4. **Secrets** (`--stage`, before the first deploy): `fly secrets import --stage -a shield-comment-api-staging < backend/.env.fly.staging` (KEY=value lines per §7 staging column, **values unquoted**: `neon env pull` writes `"…"` around URLs, strip them; git-ignored by `.env.*`; delete it after the import), `fly secrets set --stage -a shield-comment-app-staging API_UPSTREAM=http://shield-comment-api-staging.internal:3000 PUBLIC_SITE_URL=https://shield-comment-app-staging.fly.dev`, `fly secrets set --stage -a shield-comment-admin-staging API_UPSTREAM=http://shield-comment-api-staging.internal:3000`.
5. **Migrations, from the developer machine, before the backend deploy** (same order as production's release step: the schema is ready before the new code starts): `cd backend && npm run build && npm run db:deploy:staging` (Drizzle `migrate()` on the Neon `staging` **direct** URL). Never `drizzle-kit push`.
6. **Backend**: `fly auth docker` first (writes a short-lived registry login for local Docker; without it a `--local-only` push fails with "app repository not found"; repeat it if a later deploy is more than a few minutes away), then `cd backend && fly deploy -c fly.staging.toml --ha=false --local-only`, then `curl -fsS https://shield-comment-api-staging.fly.dev/api/health/live` and once `…/api/health` (DB + Redis up; don't repeat it, it keeps Neon awake).
7. **Client + admin**: `cd client && fly deploy -c fly.staging.toml --ha=false --local-only`, same in `admin/`; `curl -fsS https://shield-comment-app-staging.fly.dev/healthz` and `https://shield-comment-admin-staging.fly.dev/healthz`. `fly machine list -a <app>` shows one machine per app; after a few idle minutes client/admin show `stopped` (seen in M9-T13a: both `stopped` about 5 minutes after the last request).
8. **Super admin**: `fly ssh console -a shield-comment-api-staging`, then `SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… SUPER_ADMIN_NAME='Super Admin' node dist/scripts/create-super-admin.js`. Then sign up the fixed staging test owner on the client (verified email + workspace) for the smoke suite.
9. **Outside services** (Meta test app, SSLCommerz sandbox, test bot): webhook `https://shield-comment-api-staging.fly.dev/api/webhooks/meta`, deauthorize `…/api/meta/deauthorize`, data deletion `…/api/meta/data-deletion` (api host); OAuth redirect `https://shield-comment-app-staging.fly.dev/api/meta/oauth/callback` (`META_OAUTH_REDIRECT_URI`, app host: the browser flow needs the app cookies); Telegram `setWebhook` `https://shield-comment-api-staging.fly.dev/api/telegram/webhook`; SSLCommerz sandbox IPN `https://shield-comment-app-staging.fly.dev/api/billing/sslcommerz/ipn` (the backend sends it per payment from `CLIENT_APP_URL`; set the merchant panel to the same; a stopped client machine wakes for it in a few seconds).
10. **Checks**: §2 client-IP steps on the staging hosts, then the smoke suite:
    ```bash
    cd e2e && SMOKE_CLIENT_URL=https://shield-comment-app-staging.fly.dev \
      SMOKE_ADMIN_URL=https://shield-comment-admin-staging.fly.dev \
      SMOKE_API_URL=https://shield-comment-api-staging.fly.dev \
      SMOKE_STAGING_HOSTS=shield-comment-app-staging.fly.dev,shield-comment-admin-staging.fly.dev,shield-comment-api-staging.fly.dev \
      SMOKE_OWNER_EMAIL=… SMOKE_OWNER_PASSWORD=… SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run smoke
    ```
    `SMOKE_STAGING_HOSTS` is an exact-hostname allow-list (case-insensitive, no suffix match): any other `*.fly.dev` host is refused like production.
11. **Monitor (D14, optional on staging)**: UptimeRobot on `https://shield-comment-api-staging.fly.dev/api/health/live` only (never `/api/health`; not on client/admin `/healthz`, see "Staying under US$5").

### Staging data (Neon schema-only branch, M9-T13)

Staging never holds production rows (user, M9-T13: "Schema only"). Project `calm-thunder-04124611`: `production` = `br-winter-leaf-a1j7hozl` / `ep-bold-dawn-a1xh3drl` (default); `staging` = `br-blue-waterfall-a1lipa9o` / `ep-morning-meadow-a17o9g0x`. To (re)create it:

1. `neon branches create --project-id calm-thunder-04124611 --name staging --parent production --schema-only` (a schema-only branch copies the tables but no rows: `drizzle.__drizzle_migrations` is empty and the rows the migrations seed, e.g. the 4 `plans`, are missing).
2. `cd backend && neon env pull --project-id calm-thunder-04124611 --branch staging --file .env.staging`, then set `DIRECT_URL` = `DATABASE_URL_UNPOOLED` (keep `REDIS_URL`). **Check the endpoint id** in `DATABASE_URL`/`DIRECT_URL` is the staging one and never `ep-bold-dawn` (print the host only, never the URL). The `*:staging` scripts check it too (Neon branch guard, §7) and stop before any DB call on a mismatch.
3. Reset on the staging endpoint only (check the id again first): `BEGIN; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public AUTHORIZATION pg_database_owner; GRANT USAGE ON SCHEMA public TO PUBLIC; COMMIT;` (same owner/ACL as Neon's default `public`).
4. `npm run build && npm run db:deploy:staging` runs every migration from 0000 (M9-T13: 48/48, 4 `plans`, 45 tables).
5. Re-stage the backend's branch secrets (`DATABASE_URL`, `DIRECT_URL`, `NEON_AI_GATEWAY_*`; unquoted) and redeploy.

**Fixed (M9-T13a):** the client Start server used to exit on real browser traffic (`TypeError [ERR_INVALID_STATE]: ReadableStream is already closed` in undici's `ReadableStreamFrom`, Node 24.22). Cause: the `server-http.ts` middleware read `response.body` of srvx/static file responses (Node streams), which wraps them in undici's web stream; when a browser left as a file finished, its queued `close()` threw uncaught. The middleware now sets headers in place and passes such responses on untouched (srvx pipes the Node stream itself). If it ever comes back: `fly logs -a shield-comment-app-staging --no-tail | grep ERR_INVALID_STATE`.

### Redeploy, migrations, rollback (staging)

- **Redeploy**: new SQL in `backend/drizzle/`? Run `npm run db:deploy:staging` first (migrations stay backwards compatible, §4). Then backend, then client/admin: `fly deploy -c fly.staging.toml --ha=false --local-only` in each app dir. A rolling deploy of one machine has a short gap (seconds) while it restarts; Meta retries webhooks.
- **Migration fallback** (no local build at hand): after the backend deploy, `fly ssh console -a shield-comment-api-staging -C "node dist/db/migrate.js"` runs it on the running machine with its `DIRECT_URL` secret. The new code then runs on the old schema for a moment, so only for additive migrations.
- **Rollback**: `fly releases -a shield-comment-api-staging --image`, then `cd backend && fly deploy -c fly.staging.toml --ha=false --image registry.fly.io/shield-comment-api-staging:<previous tag>` (same for the apps). Migrations are not undone (§4).
- **Secrets / key rotation**: as §5, with `-a <app>-staging`.

## Production candidate: Fly.io

Hosting per Module 9 **D1 (a)** (revised: production only, host still open): Fly.io region `sin` (next to Neon `aws-ap-southeast-1`), the three existing Docker images, always-on machines. Origins per **D3 (a)**, staging per **D5 (a)**, uptime per **D14 (a)**. The production domain is not chosen yet: `<domain>` below is a placeholder (filled in at M9-T17).

> Nothing here has been run yet. Every `fly` / `neon` / DNS / Redis Cloud step needs the user's accounts and approval at its row's pre-check (M9-T17 production).

## 1. Topology

| Fly app (production / staging) | Config | Hostname (prod / staging) | Port | Health check | Serves |
|---|---|---|---|---|---|
| `shield-comment-api` / `shield-comment-api-staging` | `backend/fly.toml` / `fly.staging.toml` | `api.<domain>` / `shield-comment-api-staging.fly.dev` | 3000 | `GET /api/health/live` | NestJS API + BullMQ workers/schedulers. Public host only for Meta webhooks + callbacks and Telegram |
| `shield-comment-app` / `shield-comment-app-staging` | `client/fly.toml` / `fly.staging.toml` | `app.<domain>` / `shield-comment-app-staging.fly.dev` | 5174 | `GET /healthz` | TanStack Start server (SSR landing + app), proxies `/api/*` |
| `shield-comment-admin` / `shield-comment-admin-staging` | `admin/fly.toml` / `fly.staging.toml` | `admin.<domain>` / `shield-comment-admin-staging.fly.dev` | 5173 | `GET /healthz` | nginx: admin SPA, proxies `/api/*` |

- **`/api` on each app origin** (tech-stack.md §4) goes to the backend over Fly's private network: `API_UPSTREAM=http://<backend app>.internal:3000`. `.internal` names are IPv6 only, so the backend listens on `HOST=::` (dual stack) and the admin nginx resolves with `NGINX_RESOLVER=[fdaa::3]` + `NGINX_RESOLVER_IPV6=on` (both in the fly.toml files).
- **Always on (production):** `auto_stop_machines = "off"`, `min_machines_running = 1` (BullMQ workers and the 03:00 / 15-min / hourly jobs run in the backend process). Deploys are `bluegreen` (the new machine passes its health check before the old one stops). Staging differs (auto-stop client/admin, `rolling`, no release step): see the staging section.
- **Never point a check or monitor at `/api/health`**: it queries the DB and keeps Neon's compute awake.
- Fly also serves every app on `<app>.fly.dev`. In production those origins are not in `TRUSTED_ORIGINS`, so Better Auth refuses sign-ins there (403): use only the custom hostnames. Staging uses its `*.fly.dev` hosts as its origins.
- **Two config files per app:** `fly.toml` (production) and `fly.staging.toml` (staging, M9-T10b: Free-plan sizing, auto-stop, `rolling`, no release step). The `[env]` blocks hold only values both environments share. Everything that differs (URLs, origins, `API_UPSTREAM`, Neon/Redis URLs, keys) is a `fly secrets` value per app (§7). Some of those values are not secret, but keeping them as secrets means there is one place per app for them.
- Offline check of the six files (no flyctl, no account calls): `python3 scripts/check-fly-config.py` (`--self-test` breaks each rule and expects a failure).

## 2. Client IP and forwarded headers (M9-T1 / M9-T8 carry-overs)

Every per-IP limit (Better Auth sign-in 10/min, the global throttler's 60/min anonymous bucket, Meta + SSLCommerz callback throttlers) keys on the IP that `backend/src/common/http/client-ip.ts` picks: the entry `TRUST_PROXY_HOPS` places from the right of `X-Forwarded-For`.

There are two paths to the backend:

| Path | Who | Proxies that touch `X-Forwarded-For` |
|---|---|---|
| browser → Fly edge → app proxy (client Start / admin nginx) → backend | users | Fly edge appends the visitor; app proxy **passes it on unchanged** |
| caller → Fly edge → backend (`api.<domain>`) | Meta, Telegram, anyone who finds the host | Fly edge appends the caller |

**Choice:** the app proxies run with `FORWARDED_FOR_MODE=pass` on Fly (`client/src/server/api-proxy.ts`, `admin/nginx.conf.template`), so both paths have the same count and **`TRUST_PROXY_HOPS=1`** resolves the real IP on both. With the old "append" behaviour, Fly would need 2 on the app path and 1 on the direct path. With 2, anyone could pick their own bucket on `api.<domain>` (for example to get around the sign-in limit), because every backend route is reachable there. Compose keeps the default `append` (no edge in front) and also uses 1.

`X-Forwarded-Proto`: Fly reaches the containers over plain http, so `$scheme` is `http` there. Both proxies now keep an incoming `X-Forwarded-Proto` (the edge sets `https`) and only fall back to their own scheme, so the backend and HSTS see `https`.

**Verify on staging (M9-T13), both paths:**
1. Sign in on `https://shield-comment-app-staging.fly.dev`, then open `https://shield-comment-app-staging.fly.dev/api/auth/list-sessions`: `ipAddress` must be your public IP (`curl -s https://ifconfig.me`; IPv6 is stored as its /64).
2. Sign in once with a fake header straight at the backend: `curl -s https://shield-comment-api-staging.fly.dev/api/auth/sign-in/email -H 'Origin: https://shield-comment-app-staging.fly.dev' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.99' -d '{"email":"…","password":"…"}'`. The new session's `ipAddress` must be your real IP, not `203.0.113.99`.
3. If either shows a Fly address (`172.16.*`, `fdaa:*`), the edge adds more than one entry: raise `TRUST_PROXY_HOPS` by that number in `backend/fly.toml` and `fly.staging.toml`, redeploy and check again.

## 3. One-time setup per environment

Production pass (M9-T17), with the production values from §7. Staging has its own steps in [Staging (Fly.io Free plan)](#staging-flyio-free-plan) (steps 1, 2 and 8 below apply there too).

1. **Neon**: the branches already exist (`production`, `staging`; project `calm-thunder-04124611`, `aws-ap-southeast-1`). Get the URLs with `neon connection-string <branch> --pooled` (→ `DATABASE_URL`, host has `-pooler`) and `neon connection-string <branch>` (→ `DIRECT_URL`).
2. **Redis Cloud**: one free 30 MB database per environment (never shared, D5), region `ap-southeast-1` (AWS Singapore). Configuration → *Data eviction policy* = **No eviction** (`noeviction`), then run the check in §6.
3. **Fly apps** (names are global; if one is taken, pick another and use it everywhere below, including `API_UPSTREAM`):
   ```bash
   fly apps create shield-comment-api
   fly apps create shield-comment-app
   fly apps create shield-comment-admin
   ```
4. **Secrets**: use `--stage` before the first deploy so they wait for it (later `fly secrets set` restarts the machines with the new values). Put the values in a git-ignored file and import it, so they don't end up in shell history:
   ```bash
   fly secrets import --stage -a shield-comment-api < backend/.env.fly.production   # KEY=value lines, §7
   fly secrets set --stage -a shield-comment-app API_UPSTREAM=http://shield-comment-api.internal:3000 PUBLIC_SITE_URL=https://app.<domain>
   fly secrets set --stage -a shield-comment-admin API_UPSTREAM=http://shield-comment-api.internal:3000
   ```
   (`backend/.env.*` is git-ignored; delete the file after the import.)
5. **Deploy, backend first** (its release step migrates the DB):
   ```bash
   cd backend && fly deploy
   cd ../client && fly deploy
   cd ../admin && fly deploy
   ```
   (`fly.toml` names the production apps, so no `-a`.)
6. **Hostnames + TLS**: `fly certs add api.<domain> -a shield-comment-api` (same for `app.` → the client app and `admin.` → the admin app), then create the DNS records `fly certs show` prints (a CNAME to `<app>.fly.dev`, or A/AAAA to `fly ips list`). Wait until `fly certs check` says the certificate is issued.
7. **Super admin**: `fly ssh console -a shield-comment-api`, then inside the machine run `SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… SUPER_ADMIN_NAME='Super Admin' node dist/scripts/create-super-admin.js` (DB + secret come from the machine's env). Idempotent.
8. **Outside services** (staging: Meta test app, SSLCommerz sandbox store, test bot):
   - Meta app → Webhooks: callback `https://api.<host>/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Deauthorize callback `https://api.<host>/api/meta/deauthorize`, Data Deletion callback `https://api.<host>/api/meta/data-deletion`. Facebook Login for Business redirect URI = `META_OAUTH_REDIRECT_URI` (`https://app.<host>/api/meta/oauth/callback`).
   - Telegram: `setWebhook` with `url=https://api.<host>/api/telegram/webhook` and `secret_token=$TELEGRAM_WEBHOOK_SECRET` (command in `backend/.env.example`).
   - SSLCommerz merchant panel IPN URL = `https://app.<host>/api/billing/sslcommerz/ipn` (D8). The success/fail/cancel URLs are built from `CLIENT_APP_URL`.
   - Resend: `EMAIL_FROM` on a verified domain.
   (`<host>` = `<domain>`; staging URLs are in the staging section.)
   App Review (permissions, URLs table, reviewer account, screencast, pre-submit checklist): [`meta-app-review.md`](meta-app-review.md).
9. **Smoke**: `curl -fsS https://api.<host>/api/health/live`, `https://app.<host>/healthz`, `https://admin.<host>/healthz`, then the M9-T11 smoke suite and the §2 IP check.
   The smoke suite (`e2e/smoke/`, read-only, no Docker/DB/Redis) runs from any machine with the e2e deps: `cd e2e && SMOKE_CLIENT_URL=https://shield-comment-app-staging.fly.dev SMOKE_ADMIN_URL=https://shield-comment-admin-staging.fly.dev SMOKE_API_URL=https://shield-comment-api-staging.fly.dev SMOKE_STAGING_HOSTS=<those three hostnames> SMOKE_OWNER_EMAIL=… SMOKE_OWNER_PASSWORD=… SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run smoke` (the fixed staging owner has a verified email and a workspace; the super admin comes from `create-super-admin`; keep the values in a password manager or a shell env file, never in git). It refuses hosts without a `staging` label, `localhost`/`*.localhost` or an exact `SMOKE_STAGING_HOSTS` entry; in production set `SMOKE_ALLOW_PRODUCTION=1` and it runs only the public checks (health, landing, robots/sitemap, headers), no sign-in. Locally against compose: `cd e2e && npm run smoke:local` (the global setup creates a throwaway verified owner + super admin, passes them in as `SMOKE_*`, and the teardown deletes their rows and `auth:*` keys).
10. **Uptime monitor** (§6).

## 4. Redeploy, rollback, migrations

**Redeploy**: `cd <app dir> && fly deploy` (staging: `fly deploy -c fly.staging.toml --ha=false --local-only`, migrations before it, see the staging section). Do staging first and run the smoke suite, then production. When backend and app changes go together, deploy the backend first (the apps call `/api` routes that must already exist).

**Migrations** run as the backend's `release_command` (`node dist/db/migrate.js`, Drizzle's `migrate()` over `backend/drizzle/*.sql`) on a one-off machine with the app's secrets, using `DIRECT_URL` (the Neon direct host; pgbouncer's transaction mode doesn't suit DDL). If it fails, the deploy stops and the old version keeps running. Rules:
- Generate locally (`npx drizzle-kit generate --name <name>`), review the SQL, commit it. **Never `drizzle-kit push`** against Neon.
- Keep migrations backwards compatible with the running version (add first, drop in a later release), because during a blue-green deploy the old code still runs for a moment on the new schema, and a rollback runs old code on it too.
- Before a deploy with a risky migration, note the UTC time: it is your restore point (§5).

**Rollback** (code):
```bash
fly releases -a shield-comment-api --image        # lists versions with their image refs
fly deploy -a shield-comment-api --image registry.fly.io/shield-comment-api:<previous tag>
```
The release step runs again and applies nothing (the journal is already ahead of the old image's migration folder). If the bad release had a migration the old code can't live with, roll forward with a fix, or restore the database (§5).

## 5. Keys, secrets and data recovery

**Key rotation** (each `fly secrets set` restarts that app's machines; rotate on staging first):
- **`TOKEN_ENCRYPTION_KEY` / `_KEY_ID`** (Meta user + Page tokens, AI provider keys, SSLCommerz auto-renew tokens at rest): generate `openssl rand -base64 32` and a new id that was never used (e.g. `k2027a`). Set in **one** command: `TOKEN_ENCRYPTION_KEY=<new> TOKEN_ENCRYPTION_KEY_ID=<new id> TOKEN_ENCRYPTION_PREVIOUS_KEYS=<old id>:<old key>[,<older>]`. New writes use the new key; old ciphertexts still decrypt. There is no bulk re-encrypt job: rows move to the new key when they are rewritten (Page reconnect, key save in `/admin/settings`, new auto-renew token). Drop an old key from `PREVIOUS_KEYS` only once no row uses it any more:
  ```sql
  SELECT count(*) FROM meta_connections WHERE encrypted_user_access_token LIKE 'v1:<old id>:%';
  SELECT count(*) FROM social_pages WHERE encrypted_page_access_token LIKE 'v1:<old id>:%';
  SELECT count(*) FROM ai_provider_keys WHERE key_ciphertext LIKE 'v1:<old id>:%';
  SELECT count(*) FROM billing_accounts WHERE auto_renew_token LIKE 'v1:<old id>:%';
  ```
  Losing a key = those tokens are gone (Pages must reconnect, admin re-enters AI keys).
- **`BETTER_AUTH_SECRET`** (`openssl rand -base64 48`, different per environment): it signs the session cookies, so changing it signs **everyone** out (they sign in again; no data is lost). Rotate only after a suspected leak or on a schedule, at a quiet hour.
- **`META_APP_SECRET`**: reset in the Meta app, then set the secret right away (webhook signatures and `appsecret_proof` fail in between). **`META_WEBHOOK_VERIFY_TOKEN`**: set the secret first, then save it in the Meta Webhooks settings. **`TELEGRAM_WEBHOOK_SECRET`**: set it, then run `setWebhook` again. **SSLCommerz store password, Resend key, Neon AI Gateway token, Neon storage credentials, Redis / Neon passwords**: create the new one in the provider, `fly secrets set`, then revoke the old one.

**Neon restore window**: Neon can restore a branch to any moment inside its history window (Free plan: a few hours, 6 h at the time of writing; paid plans up to 7 or 30 days; check *Project settings → Instant restore* in the console, and raise it before go-live if the plan allows). Restore keeps the same endpoint, so `DATABASE_URL` / `DIRECT_URL` don't change:
```bash
neon branches restore production ^self@2026-11-21T10:00:00Z --preserve-under-name production_before_restore
```
Everything written after that moment is lost (keep the preserved branch until you are sure). Stop the backend first (`fly scale count 0 -a shield-comment-api`) so no jobs write during the restore, then `fly scale count 1`.

## 6. Checks

- **Redis `noeviction`** (Redis Cloud blocks `CONFIG GET`; `INFO` works):
  ```bash
  redis-cli -u "$REDIS_URL" --no-auth-warning INFO memory | grep maxmemory_policy   # must print maxmemory_policy:noeviction
  ```
  Any other policy can silently drop BullMQ job keys and Better Auth sessions when the 30 MB fill up.
- **Uptime monitor (D14)**: UptimeRobot free, HTTP(s) monitors every 5 minutes with email alerts to the owner, on `https://api.<domain>/api/health/live`, `https://app.<domain>/healthz`, `https://admin.<domain>/healthz` (staging: only `https://shield-comment-api-staging.fly.dev/api/health/live`, so client/admin can sleep). Never `/api/health`.
- **Config files**: `python3 scripts/check-fly-config.py` (+ `--self-test`) and `docker compose config -q`.

## 7. Environment variables

**Local env files (M9-T13b).** Fly machines get real env vars only (`[env]` + secrets). On the developer machine each project loads git-ignored files by environment, real env vars always win, and every file keeps the same keys (so a block can be pasted into `.env.local`):
- **backend** (Node `--env-file-if-exists`, later wins): `.env` → `.env.<env>` → `.env.local`. `development` = `start`, `start:dev`, `db:deploy`, `create-super-admin`, `ai:golden`, drizzle-kit (`drizzle.config.ts` uses `process.loadEnvFile`, no `dotenv`); `staging` = `start:staging`, `db:deploy:staging`, `neon:smoke:staging`; `production` = `start:production`, `db:deploy:production`, `neon:smoke:production`, `ai:golden:production` (the old `*:neon` names and `backend/.env.neon` are gone: the file is now `backend/.env.production`). The staging/production scripts set `NEON_BRANCH` and preload `dist/scripts/neon-branch-guard.js`, which exits 1 before any DB call unless `DATABASE_URL` (required) and `DIRECT_URL` (if set) use that branch's endpoint (ids only in `backend/src/config/neon-branch.ts`). So a local `DATABASE_URL` in `.env.local` blocks the staging/production scripts on purpose. `./shield-cli add super-admin` uses the same files + guard.
- **admin / client** (Vite, highest first): `.env.[mode].local` > `.env.[mode]` > `.env.local` > `.env` (mode `development` for `dev`, `production` for build/preview/`npm start`, else `--mode <name>`). The keys are server-side only (`API_PROXY_TARGET`; `API_UPSTREAM`, `PUBLIC_SITE_URL`, `FORWARDED_FOR_MODE`), never `VITE_*`: `vite.config.ts` reads them from the files, client `npm start` loads the production files with `--env-file-if-exists`. Compose and Fly set them as real env vars.

Legend: **fly.toml** = `[env]` in the app's `fly.toml` and `fly.staging.toml` (same values in both, committed). **secret** = `fly secrets set` on that app (per environment; "secret?" = whether the value itself must be kept private). Neon values come from `neon connection-string` / `neon env pull` for that environment's branch. Never set `META_GRAPH_BASE_URL`, `SSLCOMMERZ_BASE_URL` or `TELEGRAM_API_BASE_URL` on Fly (test stubs; production refuses them). Leave `CORS_ORIGINS` unset (D3: CORS off).

### Backend (`shield-comment-api`, `shield-comment-api-staging`)

| Variable | Where | Secret? | Production | Staging |
|---|---|---|---|---|
| `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` | fly.toml | no | `production`, `3000`, `::`, `info` | same |
| `TRUST_PROXY_HOPS` | fly.toml | no | `1` (§2) | same |
| `DATABASE_URL` | secret | yes | Neon `production` branch, **pooled** (`ep-…-pooler.ap-southeast-1.aws.neon.tech`, `sslmode=require`) | Neon `staging` branch, pooled |
| `DIRECT_URL` | secret | yes | Neon `production` branch, **direct** (no `-pooler`; migrations only) | Neon `staging` branch, direct |
| `REDIS_URL` | secret | yes | Redis Cloud production DB (`noeviction`) | Redis Cloud staging DB |
| `BETTER_AUTH_SECRET` | secret | yes | `openssl rand -base64 48` | its own value |
| `BETTER_AUTH_URL` | secret | no | `https://api.<domain>` | `https://shield-comment-api-staging.fly.dev` |
| `TRUSTED_ORIGINS` | secret | no | `https://app.<domain>,https://admin.<domain>` | `https://shield-comment-app-staging.fly.dev,https://shield-comment-admin-staging.fly.dev` |
| `CLIENT_APP_URL` | secret | no | `https://app.<domain>` | `https://shield-comment-app-staging.fly.dev` |
| `TOKEN_ENCRYPTION_KEY` | secret | yes | `openssl rand -base64 32` | its own value |
| `TOKEN_ENCRYPTION_KEY_ID` | secret | no | e.g. `k2026a` | e.g. `s2026a` |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` | secret | yes | only during a rotation (§5) | same |
| `META_APP_ID`, `META_LOGIN_CONFIG_ID` | secret | no | live Meta app | Meta **test app** |
| `META_APP_SECRET` | secret | yes | live app secret | test app secret |
| `META_OAUTH_REDIRECT_URI` | secret | no | `https://app.<domain>/api/meta/oauth/callback` | `https://shield-comment-app-staging.fly.dev/api/meta/oauth/callback` |
| `META_WEBHOOK_VERIFY_TOKEN` | secret | yes | `openssl rand -hex 24` | its own value |
| `META_GRAPH_API_VERSION` | (unset) | no | only to override the pinned version | same |
| `RESEND_API_KEY` | secret | yes | Resend sending key | Resend test key |
| `EMAIL_FROM` | secret | no | `ShieldComment BD <alerts@<domain>>` | a staging sender |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | secret | yes | production bot (BotFather) / `openssl rand -hex 32` | test bot / its own value |
| `TELEGRAM_BOT_USERNAME` | secret | no | production bot username | test bot username |
| `SSLCOMMERZ_STORE_ID` | secret | no | live store (M9-T18) | sandbox store |
| `SSLCOMMERZ_STORE_PASSWORD` | secret | yes | live store password | sandbox password |
| `SSLCOMMERZ_SANDBOX` | secret | no | `false` (from go-live, D8) | `true` |
| `SSLCOMMERZ_TOKENIZATION` | secret | no | `false` until SSLCommerz approves it | `false` |
| `INVOICE_SELLER_NAME`, `INVOICE_SELLER_ADDRESS` | secret | no | legal facts (M9-T7) | same |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | secret | yes | Neon object storage, `production` branch | `staging` branch |
| `AWS_ENDPOINT_URL_S3`, `AWS_REGION`, `STORAGE_BUCKET` | secret | no | `https://<branch-id>.storage.ap-southeast-1.aws.neon.tech`, `ap-southeast-1`, `assets` | staging branch values |
| `NEON_AI_GATEWAY_BASE_URL` | secret | no | `https://<branch-id>-api.ai.ap-southeast-1.aws.neon.tech` | staging branch value |
| `NEON_AI_GATEWAY_TOKEN` | secret | yes | gateway token (or saved in `/admin/settings`) | same |
| `CORS_ORIGINS` | (unset) | no | unset | unset |

`backend/src/config/env.validation.spec.ts` ("documented deploy env") checks that a full production and staging env of this shape passes the production boot checks.

### Client (`shield-comment-app`, `shield-comment-app-staging`)

| Variable | Where | Secret? | Production | Staging |
|---|---|---|---|---|
| `NODE_ENV`, `PORT`, `HOST` | Dockerfile | no | `production`, `5174`, `0.0.0.0` | same |
| `FORWARDED_FOR_MODE` | fly.toml | no | `pass` (§2) | same |
| `API_UPSTREAM` | secret | no | `http://shield-comment-api.internal:3000` | `http://shield-comment-api-staging.internal:3000` |
| `PUBLIC_SITE_URL` | secret | no | `https://app.<domain>` (canonical, hreflang, og:url, HSTS) | `https://shield-comment-app-staging.fly.dev` |

### Admin (`shield-comment-admin`, `shield-comment-admin-staging`)

| Variable | Where | Secret? | Production | Staging |
|---|---|---|---|---|
| `NGINX_RESOLVER`, `NGINX_RESOLVER_IPV6` | fly.toml | no | `[fdaa::3]`, `on` | same |
| `FORWARDED_FOR_MODE` | fly.toml | no | `pass` (§2) | same |
| `API_UPSTREAM` | secret | no | `http://shield-comment-api.internal:3000` | `http://shield-comment-api-staging.internal:3000` |
