# Meta webhooks on a local machine (zrok2 tunnel + test app)

How to point the Meta **test app** at a backend running on your machine, and the checklist for the live smoke test. Built in M4-T13 (TASKS.md Module 4 D1, D5, D6, D12). The live smoke has **not been run yet** (D12: no test app credentials yet); run the checklist below once the test app exists.

Meta calls the **backend** directly (D1), never the client proxy, so the raw body that the `X-Hub-Signature-256` check needs arrives untouched. Locally the zrok2 share forwards `https://shield-comment-dev.shares.zrok.io` to `localhost:3000`.

## 1. Start the stack and the tunnel

```bash
docker compose up -d            # or: docker compose up -d postgres redis && cd backend && npm run start:dev
scripts/tunnel.sh --check       # prerequisites + URLs, starts nothing
scripts/tunnel.sh               # creates the zrok2 name on first use, runs the share; Ctrl-C stops it
```

- Needs `zrok2` v2 with an enabled environment (`zrok2 enable <account token>`; the token never goes into the repo).
- Defaults: name `shield-comment-dev`, namespace `public`, target `localhost:3000`. Overrides: `TUNNEL_NAME`, `TUNNEL_NAMESPACE`, `TUNNEL_PORT`, `TUNNEL_HOST`, `CLIENT_PUBLIC_URL` (only for the OAuth hint). Extra `zrok2 share public` flags go after `--`.
- The script checks `/api/health/live` on the target and probes the verify endpoint with a wrong token: `403` = verify token set, `503` = `META_WEBHOOK_VERIFY_TOKEN` unset.
- Without a terminal (background run) it adds `--headless`. It always passes `--force-local`, so Ctrl-C really ends the share even if a zrok2 agent runs.

URLs it prints (base `https://shield-comment-dev.shares.zrok.io`):

| Meta setting | URL |
|---|---|
| Webhooks callback (Page + Instagram) | `<base>/api/webhooks/meta` |
| Deauthorize callback | `<base>/api/meta/deauthorize` |
| Data deletion callback | `<base>/api/meta/data-deletion` |
| OAuth redirect (**not** the tunnel) | `META_OAUTH_REDIRECT_URI` on the client origin, `http://app.localhost:5174/api/meta/oauth/callback` (Module 3 D6: the session cookie lives on the client origin) |

## 2. Environment variables

Names only (values from the Meta test app; descriptions in `backend/.env.example`). Host runs (`npm run start:dev`) read `backend/.env`. Docker compose reads the **repo-root `.env`** and passes these through only when set; recreate the backend after a change (`docker compose up -d backend`).

- `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID`, `META_OAUTH_REDIRECT_URI`: all four or none. `META_APP_SECRET` also signs webhooks and `signed_request` (unset → 503).
- `META_WEBHOOK_VERIFY_TOKEN`: random, 16–256 printable chars, no spaces (`openssl rand -hex 24`); the same value goes into the Meta Webhooks settings.
- `TOKEN_ENCRYPTION_KEY` + `TOKEN_ENCRYPTION_KEY_ID`: needed to store Page tokens (connect fails with 503 without them).
- Optional: `META_GRAPH_API_VERSION`. The Data Deletion status link uses `CLIENT_APP_URL` (compose: `CLIENT_PUBLIC_URL`).

## 3. Meta test app dashboard

Meta App Review (per-permission use cases, production URLs, screencast shot list): [`meta-app-review.md`](meta-app-review.md).

1. **Facebook Login for Business** → Settings: add the OAuth redirect URI above to *Valid OAuth Redirect URIs*; set *Deauthorize callback URL* to `<base>/api/meta/deauthorize`. The configuration id goes into `META_LOGIN_CONFIG_ID`.
2. **App settings → Basic** → *User data deletion* → *Data deletion callback URL* = `<base>/api/meta/data-deletion`.
3. **App settings → Advanced** → switch on **Require App Secret** (every token call sends `appsecret_proof`).
4. **Webhooks** product: object **Page** → callback `<base>/api/webhooks/meta` + the verify token → *Verify and save* (the tunnel must be running) → subscribe the **`feed`** field. Object **Instagram** → same callback + token → subscribe **`comments`** (D2).
5. App roles: while the app is in development mode Meta only sends webhooks for content made by people with a role on the app, so the test commenter must be an admin, developer or tester.

## 4. Connect a test Page

1. Sign in on the client (`http://app.localhost:5174`), go to `/onboarding` or `/pages` and connect Facebook with an account that manages the test Page (and its linked Instagram professional account).
2. Switch the Page on: this calls `POST /{page-id}/subscribed_apps` (`subscribed_fields=feed`). Pages switched on before M4-T8 need the backfill once: `cd backend && npm run build && npm run meta:subscribe-pages` (compose: `docker compose exec backend node dist/scripts/subscribe-active-pages.js`).

## 5. Live smoke checklist

Check the DB with `docker compose exec postgres psql -U shield -d shield_comment` and follow the backend log (`docker compose logs -f backend`).

- [ ] Meta *Verify and save* succeeds for both objects (backend log: `GET /api/webhooks/meta` 200).
- [ ] Post a comment on a test Page post from a second account with an app role → backend log shows `POST /api/webhooks/meta` 200 and the line `Meta webhook enqueued 1 (…)`.
- [ ] `select comment_id, platform, status, message from comments order by created_at desc limit 5;` → a new row, status `PENDING`.
- [ ] `select event_id, processed_at from webhook_events order by created_at desc limit 5;` → `FACEBOOK:<commentId>:add`, `processed_at` set.
- [ ] Edit the comment → same row, new `message`, `edited_at` set, event `…:edited-<hash>`.
- [ ] Delete the comment → `deleted_at` set, message kept, event `…:remove`.
- [ ] Repeat with an Instagram comment on the linked IG account (`platform = 'INSTAGRAM'`).
- [ ] Facebook → Settings & privacy → *Business integrations* → remove the app → `meta_connections.status = 'REVOKED'`, Pages switched off.
- [ ] Reconnect, then remove the app again with **Send request to delete data** (or send a data deletion request) → Facebook shows a link to `http://app.localhost:5174/data-deletion?code=…`; the page shows *pending*, then *completed* once the `data-deletion` job ran (connection, Pages and their comments gone; `daily_comment_stats` kept).
- [ ] Stop the tunnel (Ctrl-C) and record the result in TASKS.md (M4-T13).

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Webhook POST `401` | Wrong `META_APP_SECRET` (test app and live app have different secrets), or something re-serialised the body. Meta must hit the backend through the tunnel, never the client `/api` proxy. |
| `503 Meta webhooks are not configured` | `META_WEBHOOK_VERIFY_TOKEN` (GET) or `META_APP_SECRET` (POST) unset in the env the backend actually reads (root `.env` for compose). |
| Verify and save fails with `403` | Verify token in the dashboard differs from `META_WEBHOOK_VERIFY_TOKEN`. |
| Public URL answers the zrok `404` page | The share isn't running (or still starting); run `scripts/tunnel.sh`. |
| `could not create name` | The name is taken by another account or the account's name limit is reached: `TUNNEL_NAME=<other> scripts/tunnel.sh`, then update the URLs in the dashboard. |
| `not reachable on http://localhost:3000` | Start the backend, or point the tunnel elsewhere with `TUNNEL_PORT`. |
| No webhook after a comment | Page not switched on / not subscribed (run the backfill), commenter has no app role, comment written by the Page itself (skipped by design), or the Page belongs to no workspace (dropped, D4). |

The headless zrok2 log prints every request path including query strings (e.g. `hub.verify_token`). Don't paste it anywhere public.
