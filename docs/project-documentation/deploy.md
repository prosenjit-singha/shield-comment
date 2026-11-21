# Deploy runbook (Fly.io, Module 9)

Hosting per Module 9 **D1 (a)**: Fly.io region `sin` (next to Neon `aws-ap-southeast-1`), the three existing Docker images, always-on machines. Origins per **D3 (a)**, staging per **D5 (a)**, uptime per **D14 (a)**. The domain is not chosen yet: `<domain>` below is a placeholder (filled in at M9-T13).

> Nothing here has been run yet. Every `fly` / `neon` / DNS / Redis Cloud step needs the user's accounts and approval at its row's pre-check (M9-T13 staging, M9-T17 production).

## 1. Topology

| Fly app (production / staging) | Config | Hostname (prod / staging) | Port | Health check | Serves |
|---|---|---|---|---|---|
| `shield-comment-api` / `shield-comment-api-staging` | `backend/fly.toml` | `api.<domain>` / `api.staging.<domain>` | 3000 | `GET /api/health/live` | NestJS API + BullMQ workers/schedulers. Public host only for Meta webhooks + callbacks and Telegram |
| `shield-comment-app` / `shield-comment-app-staging` | `client/fly.toml` | `app.<domain>` / `app.staging.<domain>` | 5174 | `GET /healthz` | TanStack Start server (SSR landing + app), proxies `/api/*` |
| `shield-comment-admin` / `shield-comment-admin-staging` | `admin/fly.toml` | `admin.<domain>` / `admin.staging.<domain>` | 5173 | `GET /healthz` | nginx: admin SPA, proxies `/api/*` |

- **`/api` on each app origin** (tech-stack.md §4) goes to the backend over Fly's private network: `API_UPSTREAM=http://<backend app>.internal:3000`. `.internal` names are IPv6 only, so the backend listens on `HOST=::` (dual stack) and the admin nginx resolves with `NGINX_RESOLVER=[fdaa::3]` + `NGINX_RESOLVER_IPV6=on` (both in the fly.toml files).
- **Always on:** `auto_stop_machines = "off"`, `min_machines_running = 1` (BullMQ workers and the 03:00 / 15-min / hourly jobs run in the backend process). Deploys are `bluegreen` (the new machine passes its health check before the old one stops).
- **Never point a check or monitor at `/api/health`**: it queries the DB and keeps Neon's compute awake.
- Fly also serves every app on `<app>.fly.dev`. Those origins are not in `TRUSTED_ORIGINS`, so Better Auth refuses sign-ins there (403). Use only the custom hostnames.
- **One config file per app for both environments** (lighter than a second file per app): staging deploys the same file with `-a <app>-staging`. The files hold only values both environments share. Everything that differs (URLs, origins, `API_UPSTREAM`, Neon/Redis URLs, keys) is a `fly secrets` value per app (§7). Some of those values are not secret, but keeping them as secrets means there is one place per app for them.
- Offline check of the three files (no flyctl, no account calls): `python3 scripts/check-fly-config.py`.

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
1. Sign in on `https://app.staging.<domain>`, then open `https://app.staging.<domain>/api/auth/list-sessions`: `ipAddress` must be your public IP (`curl -s https://ifconfig.me`; IPv6 is stored as its /64).
2. Sign in once with a fake header straight at the backend: `curl -s https://api.staging.<domain>/api/auth/sign-in/email -H 'Origin: https://app.staging.<domain>' -H 'Content-Type: application/json' -H 'X-Forwarded-For: 203.0.113.99' -d '{"email":"…","password":"…"}'`. The new session's `ipAddress` must be your real IP, not `203.0.113.99`.
3. If either shows a Fly address (`172.16.*`, `fdaa:*`), the edge adds more than one entry: raise `TRUST_PROXY_HOPS` by that number in `backend/fly.toml`, redeploy and check again.

## 3. One-time setup per environment

Do staging first (M9-T13), then production (M9-T17) with the production values from §7.

1. **Neon**: the branches already exist (`production`, `staging`; project `calm-thunder-04124611`, `aws-ap-southeast-1`). Get the URLs with `neon connection-string <branch> --pooled` (→ `DATABASE_URL`, host has `-pooler`) and `neon connection-string <branch>` (→ `DIRECT_URL`).
2. **Redis Cloud**: one free 30 MB database per environment (never shared, D5), region `ap-southeast-1` (AWS Singapore). Configuration → *Data eviction policy* = **No eviction** (`noeviction`), then run the check in §6.
3. **Fly apps** (names are global; if one is taken, pick another and use it everywhere below, including `API_UPSTREAM`):
   ```bash
   fly apps create shield-comment-api-staging
   fly apps create shield-comment-app-staging
   fly apps create shield-comment-admin-staging
   ```
4. **Secrets**: use `--stage` before the first deploy so they wait for it (later `fly secrets set` restarts the machines with the new values). Put the values in a git-ignored file and import it, so they don't end up in shell history:
   ```bash
   fly secrets import --stage -a shield-comment-api-staging < backend/.env.fly.staging   # KEY=value lines, §7
   fly secrets set --stage -a shield-comment-app-staging API_UPSTREAM=http://shield-comment-api-staging.internal:3000 PUBLIC_SITE_URL=https://app.staging.<domain>
   fly secrets set --stage -a shield-comment-admin-staging API_UPSTREAM=http://shield-comment-api-staging.internal:3000
   ```
   (`backend/.env.*` is git-ignored; delete the file after the import.)
5. **Deploy, backend first** (its release step migrates the DB):
   ```bash
   cd backend && fly deploy -a shield-comment-api-staging
   cd ../client && fly deploy -a shield-comment-app-staging
   cd ../admin && fly deploy -a shield-comment-admin-staging
   ```
   Production: the same commands without `-a` (the fly.toml `app` names are the production apps).
6. **Hostnames + TLS**: `fly certs add api.staging.<domain> -a shield-comment-api-staging` (same for `app.` → the client app and `admin.` → the admin app), then create the DNS records `fly certs show` prints (a CNAME to `<app>.fly.dev`, or A/AAAA to `fly ips list`). Wait until `fly certs check` says the certificate is issued.
7. **Super admin**: `fly ssh console -a shield-comment-api-staging`, then inside the machine run `SUPER_ADMIN_EMAIL=… SUPER_ADMIN_PASSWORD=… SUPER_ADMIN_NAME='Super Admin' node dist/scripts/create-super-admin.js` (DB + secret come from the machine's env). Idempotent.
8. **Outside services** (staging: Meta test app, SSLCommerz sandbox store, test bot):
   - Meta app → Webhooks: callback `https://api.<host>/api/webhooks/meta`, verify token = `META_WEBHOOK_VERIFY_TOKEN`. Deauthorize callback `https://api.<host>/api/meta/deauthorize`, Data Deletion callback `https://api.<host>/api/meta/data-deletion`. Facebook Login for Business redirect URI = `META_OAUTH_REDIRECT_URI` (`https://app.<host>/api/meta/oauth/callback`).
   - Telegram: `setWebhook` with `url=https://api.<host>/api/telegram/webhook` and `secret_token=$TELEGRAM_WEBHOOK_SECRET` (command in `backend/.env.example`).
   - SSLCommerz merchant panel IPN URL = `https://app.<host>/api/billing/sslcommerz/ipn` (D8). The success/fail/cancel URLs are built from `CLIENT_APP_URL`.
   - Resend: `EMAIL_FROM` on a verified domain.
   (`<host>` = `<domain>` in production, `staging.<domain>` on staging.)
   App Review (permissions, URLs table, reviewer account, screencast, pre-submit checklist): [`meta-app-review.md`](meta-app-review.md).
9. **Smoke**: `curl -fsS https://api.<host>/api/health/live`, `https://app.<host>/healthz`, `https://admin.<host>/healthz`, then the M9-T11 smoke suite and the §2 IP check.
   The smoke suite (`e2e/smoke/`, read-only, no Docker/DB/Redis) runs from any machine with the e2e deps: `cd e2e && SMOKE_CLIENT_URL=https://app.staging.<domain> SMOKE_ADMIN_URL=https://admin.staging.<domain> SMOKE_API_URL=https://api.staging.<domain> SMOKE_OWNER_EMAIL=… SMOKE_OWNER_PASSWORD=… SMOKE_ADMIN_EMAIL=… SMOKE_ADMIN_PASSWORD=… npm run smoke` (the fixed staging owner has a verified email and a workspace; the super admin comes from `create-super-admin`; keep the values in a password manager or a shell env file, never in git). It refuses hosts without a `staging` label (or `localhost`/`*.localhost`); in production set `SMOKE_ALLOW_PRODUCTION=1` and it runs only the public checks (health, landing, robots/sitemap, headers), no sign-in. Locally against compose: `cd e2e && npm run smoke:local` (the global setup creates a throwaway verified owner + super admin, passes them in as `SMOKE_*`, and the teardown deletes their rows and `auth:*` keys).
10. **Uptime monitor** (§6).

## 4. Redeploy, rollback, migrations

**Redeploy**: `cd <app dir> && fly deploy [-a <app>-staging]`. Do staging first and run the smoke suite, then production. When backend and app changes go together, deploy the backend first (the apps call `/api` routes that must already exist).

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
- **Uptime monitor (D14)**: UptimeRobot free, HTTP(s) monitors every 5 minutes with email alerts to the owner, on `https://api.<domain>/api/health/live`, `https://app.<domain>/healthz`, `https://admin.<domain>/healthz` (staging the same with `.staging.` if wanted). Never `/api/health`.
- **Config files**: `python3 scripts/check-fly-config.py` and `docker compose config -q`.

## 7. Environment variables

Legend: **fly.toml** = `[env]` in the app's config (same in both environments, committed). **secret** = `fly secrets set` on that app (per environment; "secret?" = whether the value itself must be kept private). Neon values come from `neon connection-string` / `neon env pull` for that environment's branch. Never set `META_GRAPH_BASE_URL`, `SSLCOMMERZ_BASE_URL` or `TELEGRAM_API_BASE_URL` on Fly (test stubs; production refuses them). Leave `CORS_ORIGINS` unset (D3: CORS off).

### Backend (`shield-comment-api`, `shield-comment-api-staging`)

| Variable | Where | Secret? | Production | Staging |
|---|---|---|---|---|
| `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` | fly.toml | no | `production`, `3000`, `::`, `info` | same |
| `TRUST_PROXY_HOPS` | fly.toml | no | `1` (§2) | same |
| `DATABASE_URL` | secret | yes | Neon `production` branch, **pooled** (`ep-…-pooler.ap-southeast-1.aws.neon.tech`, `sslmode=require`) | Neon `staging` branch, pooled |
| `DIRECT_URL` | secret | yes | Neon `production` branch, **direct** (no `-pooler`; migrations only) | Neon `staging` branch, direct |
| `REDIS_URL` | secret | yes | Redis Cloud production DB (`noeviction`) | Redis Cloud staging DB |
| `BETTER_AUTH_SECRET` | secret | yes | `openssl rand -base64 48` | its own value |
| `BETTER_AUTH_URL` | secret | no | `https://api.<domain>` | `https://api.staging.<domain>` |
| `TRUSTED_ORIGINS` | secret | no | `https://app.<domain>,https://admin.<domain>` | `https://app.staging.<domain>,https://admin.staging.<domain>` |
| `CLIENT_APP_URL` | secret | no | `https://app.<domain>` | `https://app.staging.<domain>` |
| `TOKEN_ENCRYPTION_KEY` | secret | yes | `openssl rand -base64 32` | its own value |
| `TOKEN_ENCRYPTION_KEY_ID` | secret | no | e.g. `k2026a` | e.g. `s2026a` |
| `TOKEN_ENCRYPTION_PREVIOUS_KEYS` | secret | yes | only during a rotation (§5) | same |
| `META_APP_ID`, `META_LOGIN_CONFIG_ID` | secret | no | live Meta app | Meta **test app** |
| `META_APP_SECRET` | secret | yes | live app secret | test app secret |
| `META_OAUTH_REDIRECT_URI` | secret | no | `https://app.<domain>/api/meta/oauth/callback` | `https://app.staging.<domain>/api/meta/oauth/callback` |
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
| `PUBLIC_SITE_URL` | secret | no | `https://app.<domain>` (canonical, hreflang, og:url, HSTS) | `https://app.staging.<domain>` |

### Admin (`shield-comment-admin`, `shield-comment-admin-staging`)

| Variable | Where | Secret? | Production | Staging |
|---|---|---|---|---|
| `NGINX_RESOLVER`, `NGINX_RESOLVER_IPV6` | fly.toml | no | `[fdaa::3]`, `on` | same |
| `FORWARDED_FOR_MODE` | fly.toml | no | `pass` (§2) | same |
| `API_UPSTREAM` | secret | no | `http://shield-comment-api.internal:3000` | `http://shield-comment-api-staging.internal:3000` |
