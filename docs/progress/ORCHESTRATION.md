# Orchestration journal

Run state for `/orchestration` (skill: `.claude/skills/orchestration/`). Committed. Resume with `/orchestration --continue`. No secrets here.

## Run
- Scope: Module 4: rows M4-T1 … M4-T12 in order, then M4-GATE (stop there). **Not** M4-T13 (zrok tunnel + live Meta smoke: own session later; live Meta check stays skipped, D12). Decisions D1–D13 + gate finding (a) + run scope answered 2026-11-18 (TASKS.md "## Module 4", MEMORY.md): final. New product calls → "Choices to confirm", never guessed. No live Meta calls: extend `MetaGraphClient`, fake it in tests.
- Sub-agent reads: AGENTS.md, MEMORY.md, only the Module 4 header + decisions + its own row from TASKS.md, `docs/project-documentation/modules/module-4-webhooks-queue.md` (UI rows M4-T11/T12 also `docs/design/base.md` + `client.md`).
- Standing approvals: admin/ + client/ changes approved for the rest of this run (user, 2026-11-18).
- Row cap per session: 10 · Budget stop: 400k (est.)
- Session: #2 (2026-11-18) · rows this session: 1 · estimate: 78k

## State
dispatched M4-T2 (2026-11-18) · commit: "feat(backend): add webhook event and comment schema (M4-T2)"

## Resume
`/orchestration --continue`

## Next prompt (M4-T3)

You are implementing exactly ONE task row, **M4-T3**, in the ShieldComment BD repo at /home/veronica/projects/shield-comment (WSL2, Node 24, npm 11, Docker in WSL). Work directly; do not spawn sub-agents. Be token-lean: don't read the whole docs/ folder.

**Read first (only these)**
1. `AGENTS.md` and `backend/AGENTS.md`.
2. `docs/progress/MEMORY.md` (all; esp. "Meta Graph client (M3-T3)" for the `META_*` env + `MetaNotConfiguredError`, "Better Auth" (`bodyParser: false`, `@Public()`), "Queues (M4-T1)", "Comments schema (M4-T2)", the e2e notes).
3. From `docs/progress/TASKS.md` (use `grep -n`/`sed -n`; the file is large): the `## Module 4` header paragraph, decision **D1** (Module 4), Module 3's **D3** line (`grep -n '^- \*\*D3 Webhooks'`, only for what it says about webhooks/tunnel defaults), the M4-T2 row (context) and the M4-T3 row. All Module 4 decisions are answered (2026-11-18); treat them as final.
4. Spec: `docs/project-documentation/modules/module-4-webhooks-queue.md` (§ Backend Implementation: the `GET /webhooks/meta` + `POST` HMAC lines; § Agent Test & Verification Gate item 1).
5. Code to read or reuse: `backend/src/main.ts` + `test/utils/create-test-app.ts` (`bodyParser: false`, both must get the same raw-body wiring), `src/auth/auth.module.ts` (the library re-adds JSON/urlencoded parsing for non-auth routes: find out how, so the webhook route can keep its raw bytes), `src/app.setup.ts` (`configureApp()`), `src/config/env.validation.ts` (+ spec; the `META_*` group rule "all four or none"), `src/meta/meta-graph.config.ts` (how the app secret is read; disabled → 503 pattern), `src/meta/meta.module.ts` + `src/meta/meta-oauth.controller.ts` (`@Public()` callback controller style), `src/common/logging/redact-query.ts` (redact `hub.verify_token` + `hub.challenge`? decide), `docker-compose.yml` backend env block + `backend/.env.example` (`META_*` pass-through only when set), `test/meta-oauth.e2e-spec.ts` (e2e env/fake style).

**Recorded decisions** — Module 4 D1 (answered 2026-11-18): "`GET` + `POST /api/webhooks/meta` (spec path under the global prefix) · Meta calls the **backend host directly** (not the client proxy; raw body untouched; locally via the D5 tunnel → `localhost:3000`) · missing/invalid `X-Hub-Signature-256` → **401** · verify token env `META_WEBHOOK_VERIFY_TOKEN` (optional like the other `META_*`; unset → 503)." Module 3 D3: all webhook work is Module 4.

**Task (M4-T3): backend webhook verify endpoint + signature guard**
- New module/controller (e.g. `src/webhooks/meta-webhook.controller.ts`, `@Public()`): `GET /api/webhooks/meta` → `hub.mode === 'subscribe'` and `hub.verify_token` equals `META_WEBHOOK_VERIFY_TOKEN` (constant-time compare) → 200 `text/plain` echo of `hub.challenge`; wrong mode/token or missing challenge → 403; `META_WEBHOOK_VERIFY_TOKEN` unset → 503 (startup never fails). Note the query keys contain dots (`hub.mode`): check how Nest/`ValidationPipe` (`forbidNonWhitelisted`) treats them; don't let the global pipe 400 Meta's request.
- Raw body for the webhook route only: Better Auth needs `bodyParser: false`; capture the exact bytes for `POST /api/webhooks/meta` (route-scoped raw parser or `rawBody` option, whichever works with the auth library's re-added parsers) in **both** `main.ts` and `createTestApp`, size-limited (e.g. 1 MB). Other routes unchanged (Better Auth + existing JSON routes must keep working: the full e2e suite proves it).
- `MetaWebhookSignatureGuard`: `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 of the raw body with `META_APP_SECRET` (+ `timingSafeEqual`, length check first); missing/malformed/wrong → **401** (D1); Meta app vars unset → 503. A stub `POST` handler behind the guard that returns 200 `EVENT_RECEIVED` (M4-T4 fills the receiver: envelope parsing + enqueue; don't build that here).
- Env: `META_WEBHOOK_VERIFY_TOKEN` (optional, min length e.g. 16, no spaces) in `env.validation.ts` + spec, `backend/.env.example`, compose pass-through (only when set, like the other `META_*`), e2e env if the tests need it. Don't log the verify token, the challenge or the signature (pino redaction like `redact-query.ts`).
- Tests: unit (signature helper: valid, wrong secret, tampered body, missing prefix, bad hex/length, empty body; verify-token compare) + e2e (`createTestApp`): GET ok echoes challenge as text/plain, wrong token 403, wrong mode 403, unset token 503 (second app or config override), POST with valid signature 200, missing header 401, wrong signature 401, body re-serialised (whitespace changed) → 401 (proves raw bytes are used), Better Auth sign-in + a JSON route still work, route is reachable without a session.

**Rules:** TS strict, ESM (`.js` relative imports), no `any`. Vitest (`vi.fn<Fn>()`). No live external calls in tests; tests must fail on unexpected requests. Every tenant query is scoped by `workspace_id` (no DB work in this row). Never commit `.env*` (except `.env.example`) or build/test output. **Never stop or kill the user's own processes** (local Postgres 5432, Redis 6379, dev servers); on a port clash use env overrides or stop and report. E2E apps come from `createTestApp()` (Redis stubbed, all 3 BullMQ queues are `FakeQueue`s).

**Verify** (run what applies; report real numbers):
- backend: `npm run build`, `npx tsc --noEmit -p tsconfig.json`, `npm test`, `npm run test:e2e`, `npm run lint`, `npx prettier --check "src/**/*.ts" "test/**/*.ts"`. The test DB must end empty except the 4 `plans` rows.
- compose: `docker compose up --build -d` → backend healthy; with `META_WEBHOOK_VERIFY_TOKEN` + Meta vars unset, `curl 'localhost:<backend port>/api/webhooks/meta?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1'` → 503 (and, if you set a token in a throwaway shell env, 200 echo). Don't commit env values.
- Current test counts: backend unit 605 · backend e2e 397 · admin 246 · client 301 · e2e 2/2.

**If a decision is missing:** if THIS row needs a product decision that is not recorded in TASKS.md/MEMORY.md/this prompt, STOP without coding that part. Report `STATUS: needs-decision` with the question and 2–4 options (recommended first). Implementation choices that are not product calls (module/file names, raw-body mechanism, body size limit, env length rule): make them, and list them under CHOICES.

**Finish (in this order)**
1. TASKS.md: the M4-T3 row → `✅ <date>` + concise notes (built + choices). Add a Verification log entry at the TOP of `## Verification log`. Add short lasting facts to MEMORY.md (route, raw-body wiring, guard, env) and point its "Next:" phrase at M4-T4. Keep MEMORY.md short (edit, don't pile up).
2. Journal `docs/progress/ORCHESTRATION.md`:
   - append one `## Log` line (`- <date> M4-T3 ✅ · <tests> · <1-line summary>`); the orchestrator adds the commit hash;
   - append your choices under `## Choices to confirm` as `- M4-T3: …`;
   - **replace** the `## Next prompt` section with the M4-T4 prompt in the format of `.claude/skills/orchestration/subagent-prompt.md` (it must tell the next sub-agent to read only the Module 4 header + D1/D2/D3 + its own row, and the module-4 spec; carry over anything M4-T4 needs from your work: the guard, the stub handler to replace, how raw body reaches the handler, the < 200 ms + `withTimeout()` note for queue `add`, `commentJobId()`).
3. Commit everything, journal included, as `feat(backend): add meta webhook verify and signature guard (M4-T3)` with an optional 2–4 bullet body. The last line is the Co-Authored-By trailer given in your dispatch message.
4. Return the report in the format of `.claude/skills/orchestration/subagent-prompt.md`.

## Choices to confirm
- M3-T8: whole query cache cleared on sign-in/up · /register field order name → business → email → password · own en/bn validation (noValidate) · EN/BN switch on auth cards · Bangla digits in wait times · `safeRedirect` refuses /register
- M3-T9: no separate Log out while impersonating (Exit only) · close-tab screen has no login link / no `window.close()` · banner `bg-secondary`, "Changes you make here are real" · failed normal log-out now shows an alert
- M3-T10: safe `?redirect=` wins over the 0-Pages check · Finish needs ≥ 1 active Page · onboarding toggles not optimistic · token-less Page keeps a working switch on onboarding · upgrade message without link (Module 8) · `?meta=` stays in URL · inline SVG brand icons
- M3-T11: token-less Pages show a reconnect hint + disabled switch on /pages · one switch covers Page + linked IG · Reconnect hidden when 0 Pages
- M3-T12: super admin seeded via `create-super-admin` (suite targets compose only) · host runs need `E2E_CHROMIUM_PATH` · e2e image ≈ 4 GB · suite not in CI yet
- M4-T1: admin queue counts: a queue whose count fails/times out (3 s) is left out, so Redis down → `queues: []` (card says "No queues yet"; the Redis pill shows the outage) instead of an error row (would need admin + DTO change) · one connection config for queues and workers with `maxRetriesPerRequest: null` (`@nestjs/bullmq` builds workers from the queue connection), so producers must time-box queue calls · each queue/worker has its own ioredis connection (3 now, +2 per worker; Redis Cloud free allows 30) · eviction check reads `INFO memory` (not `CONFIG GET`), runs in the background, warns only · `commentJobId()` rejects `:` inside a part (BullMQ allows `:` only in 3-part ids) · e2e `REDIS_URL` moved to `redis://127.0.0.1:1` · no worker test double yet (left to the first `@Processor` row)
- M4-T2: `comments.social_page_id` (not `page_id`, to avoid clashing with Meta's `page_id` text) is nullable `on delete set null` (D7 via FK, no explicit update needed in M4-T9; D6 Data Deletion must delete comments before Pages) · `daily_comment_stats` keyed by Meta `page_id` text with no FK (counts survive disconnect/Data Deletion and continue on re-connect) · `webhook_events.workspace_id` NOT NULL (only routed events are recorded; dropped D4 comments leave no row) · `author_id`/`author_name`/`message` nullable · `edited_at` + `deleted_at` markers · checks on event id format, sha256 payload hash, numeric/`_`-joined Meta ids · partial purge index on `comments.created_at where raw_payload is not null` · `webhook_events` never purged yet (no personal data besides the comment id) · open for M4-T5: a 2nd `edited` of one comment reuses the D4 `event_id` → seen as duplicate unless the worker compares `payload_hash`

## Decisions asked
- 2026-11-18 M3-T10: D13 0-Pages redirect → entry points only (recorded in TASKS.md D13)
- 2026-11-18 Module 4 run: app approval → "Both, rest of run (Recommended)" (admin/ + client/ approved for every Module 4 row in this run)

## Log
- 2026-11-18 M3-T8 ✅ 1e341c6 · client 131 · login + register, workspaceName via fetchOptions.body
- 2026-11-18 M3-T9 ✅ dcab638 · client 151 · app shell + impersonation banner
- 2026-11-18 M3-T10 ✅ 02cbe8f · client 241 · onboarding wizard + D13 entry-point redirect
- 2026-11-18 M3-T11 ✅ fad5526 · client 301 · /pages base view, optimistic toggle
- 2026-11-18 M3-T12 ✅ 50c2849 · e2e 2/2 (host + docker) · Playwright gate suite, playwright-cli image + skill
- 2026-11-18 M3-GATE ✅ 1493dce · backend 570 + e2e 379 · admin 246 · client 301 · e2e 2/2 · Module 3 passed
- 2026-11-18 M4-PLAN ✅ db06752 + 2f671c1 · docs only · Module 4 planned, D1–D13 answered (run outside the journal)
- 2026-11-18 M4-T1 ✅ b4aca20 · backend 597 + e2e 383 · BullMQ QueueModule (3 D3 queues), eviction warning, real admin queue counts, e2e FakeQueue
- 2026-11-18 M4-T2 ✅ · backend 605 + e2e 397 · e2e 2/2 · webhook_events/comments/daily_comment_stats schema (0011) + comments.queries helpers
