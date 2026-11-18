# Orchestration journal

Run state for `/orchestration` (skill: `.claude/skills/orchestration/`). Committed. Resume with `/orchestration --continue`. No secrets here.

## Run
- Scope: Module 4: rows M4-T1 … M4-T12 in order, then M4-GATE (stop there). **Not** M4-T13 (zrok tunnel + live Meta smoke: own session later; live Meta check stays skipped, D12). Decisions D1–D13 + gate finding (a) + run scope answered 2026-11-18 (TASKS.md "## Module 4", MEMORY.md): final. New product calls → "Choices to confirm", never guessed. No live Meta calls: extend `MetaGraphClient`, fake it in tests.
- Sub-agent reads: AGENTS.md, MEMORY.md, only the Module 4 header + decisions + its own row from TASKS.md, `docs/project-documentation/modules/module-4-webhooks-queue.md` (UI rows M4-T11/T12 also `docs/design/base.md` + `client.md`).
- Standing approvals: admin/ + client/ changes approved for the rest of this run (user, 2026-11-18).
- Row cap per session: 10 · Budget stop: 400k (est.)
- Session: #2 (2026-11-18) · rows this session: 0 · estimate: 70k

## State
dispatched M4-T1 (2026-11-18) · commit: "feat(backend): add bullmq queue foundation (M4-T1)"

## Resume
`/orchestration --continue`

## Next prompt (M4-T2)

You are implementing exactly ONE task row, **M4-T2**, in the ShieldComment BD repo at /home/veronica/projects/shield-comment (WSL2, Node 24, npm 11, Docker in WSL). Work directly; do not spawn sub-agents. Be token-lean: don't read the whole docs/ folder.

**Read first (only these)**
1. `AGENTS.md` and `backend/AGENTS.md`.
2. `docs/progress/MEMORY.md` (all; esp. "DB conventions", "Meta schema (M3-T2)", "Queues (M4-T1)", the e2e cleanup notes).
3. From `docs/progress/TASKS.md` (use `grep -n`/`sed -n`; the file is large): the `## Module 4` header paragraph, decisions **D2** (fields/verbs) and **D4** (storage + routing, daily aggregates, raw_payload purge), plus **D6/D7** only for what they say about comments (Data Deletion deletes a connection's comments; disconnect keeps comments with the Page link set to null), the M4-T1 row (context) and the M4-T2 row. All Module 4 decisions are answered (2026-11-18); treat them as final.
4. Spec: `docs/project-documentation/modules/module-4-webhooks-queue.md` (§ Backend Implementation: the table list).
5. Code to read or reuse: `backend/src/db/schema/columns.ts` (`id()`, `timestamptz()`, `timestamps`), `backend/src/db/schema/meta.ts` (the last schema row, M3-T2: text enums + checks, FK style, indexes) + `index.ts`, `backend/drizzle/0010_meta_connections.sql` (reviewed-migration style), `backend/test/meta-schema.e2e-spec.ts` (schema e2e to copy), `backend/test/utils/auth-actors.ts` `cleanup()` (FK-restrict delete order), `backend/src/meta/social-pages.queries.ts` (queries-file style, `workspace_id` scoping), `backend/src/queue/queue.constants.ts` (`commentJobId()` = the same `<platform>:<commentId>:<verb>` format D4 uses for `webhook_events.event_id`).

**Recorded decisions** — D4 (answered 2026-11-18): "`webhook_events.event_id` = `<platform>:<commentId>:<verb>` · comments for unknown / inactive Pages or REVOKED connections are **dropped** with a log line · `comments.status` only `PENDING` now (Module 5 adds values) · **only `raw_payload` is cleared after 30 days** (daily purge job; comment rows with text/author/status stay) · **lifetime analytics kept forever:** a daily aggregate table (per workspace + Page + platform + Dhaka day: received/edited/removed counts, Module 5 adds blocked etc.) updated by the worker in the same tx, never purged, no personal data · quota counting in Module 5/8." D2: Page `feed` + IG `comments`, verbs `add`/`edited`/`remove` (edited updates the message; remove marks deleted, never hidden later); own comments skipped. D7: disconnect hard-deletes `social_pages`, **comments kept with their Page link set to null** (so `comments.page_id` FK must allow that: nullable + `on delete set null` or an explicit update in M4-T9 — pick one and note it). D6: Data Deletion deletes the connection's Pages **and their comments**; daily aggregates stay.

**Task (M4-T2): backend schema for webhook events, comments and daily aggregates**
- Drizzle schema (new file, e.g. `src/db/schema/comments.ts`, exported from `index.ts`): `webhook_events` (`event_id` unique, `payload_hash`, `processed_at`, timestamps; workspace link if useful for scoping), `comments` (`comment_id` unique, `workspace_id` FK, `page_id` → `social_pages` (see D7), `post_id`, `author_name`, `author_id`, `message`, `platform` FACEBOOK|INSTAGRAM, `raw_payload` jsonb nullable (purged after 30 d), `status` PENDING (text + check, Module 5 extends), a deleted/removed marker for verb `remove`, edited time for `edited`), and the D4 daily aggregate table (workspace, Page, platform, Dhaka day `date`, received/edited/removed counts ≥ 0; unique per key; no personal data; decide what happens to its Page link on disconnect: aggregates are kept forever). Text enums + checks, numeric Meta id checks like `meta.ts`, indexes for workspace lists (e.g. `(workspace_id, created_at desc)`), FKs restrict unless D6/D7 say otherwise.
- `npx drizzle-kit generate --name <name>`, then review the SQL by hand (never `push`); apply to the dev + test DBs the usual way (`npx drizzle-kit migrate`; the e2e global setup migrates the test DB).
- Queries file (e.g. `src/comments/comments.queries.ts` or under `src/meta/`): typed insert/upsert helpers the M4-T5 worker will call inside its tx (`insertWebhookEvent … ON CONFLICT (event_id) DO NOTHING` returning whether it was new, `insertComment … ON CONFLICT (comment_id) DO NOTHING`, `incrementDailyCommentStats` upsert-increment, a `workspace_id`-scoped list/read) — every tenant query scoped by `workspace_id`. Keep business rules (routing, verbs) for M4-T5.
- `cleanup()` in `test/utils/auth-actors.ts` (and the M3-T12 Playwright teardown in `e2e/` if it deletes Meta rows by workspace) delete the new tables first, so the test DB still ends with only the 4 `plans` rows.
- Tests: schema e2e like `meta-schema.e2e-spec.ts` (unique `event_id`/`comment_id` → second insert is a no-op via the helpers, checks reject bad platform/status/negative counts/non-numeric ids, FK behaviour on Page delete per your D7 choice, aggregate upsert-increment adds up, tenant scoping of the list helper: other workspace's rows invisible) + unit tests for any pure helpers (e.g. Dhaka-day key). Columns spec if you add column helpers.

**Rules:** TS strict, ESM (`.js` relative imports), no `any`. Vitest (`vi.fn<Fn>()`). No live external calls in tests; tests must fail on unexpected requests. Every tenant query is scoped by `workspace_id`. Never commit `.env*` (except `.env.example`) or build/test output. **Never stop or kill the user's own processes** (local Postgres 5432, Redis 6379, dev servers); on a port clash use env overrides or stop and report. E2E apps come from `createTestApp()` (Redis stubbed, all 3 BullMQ queues are `FakeQueue`s; no real Redis).

**Verify** (run what applies; report real numbers):
- backend: `npm run build`, `npx tsc --noEmit -p tsconfig.json`, `npm test`, `npm run test:e2e`, `npm run lint`, `npx prettier --check "src/**/*.ts" "test/**/*.ts"`. The test DB must end empty except the 4 `plans` rows.
- compose: `docker compose up --build -d` → the `migrate` service applies the new migration, backend healthy.
- e2e/ touched (teardown): `cd e2e && npm run typecheck` (+ `npm test` against compose if the teardown changed).
- Current test counts: backend unit 597 · backend e2e 383 · admin 246 · client 301 · e2e 2/2.

**If a decision is missing:** if THIS row needs a product decision that is not recorded in TASKS.md/MEMORY.md/this prompt, STOP without coding that part. Report `STATUS: needs-decision` with the question and 2–4 options (recommended first). Implementation choices that are not product calls (column names, FK actions D6/D7 don't pin, index shapes): make them, and list them under CHOICES.

**Finish (in this order)**
1. TASKS.md: the M4-T2 row → `✅ <date>` + concise notes (built + choices). Add a Verification log entry at the TOP of `## Verification log`. Add short lasting facts to MEMORY.md (schema file, tables, queries helpers, cleanup order) and point its "Next:" phrase at M4-T3. Keep MEMORY.md short (edit, don't pile up).
2. Journal `docs/progress/ORCHESTRATION.md`:
   - append one `## Log` line (`- <date> M4-T2 ✅ · <tests> · <1-line summary>`); the orchestrator adds the commit hash;
   - append your choices under `## Choices to confirm` as `- M4-T2: …`;
   - **replace** the `## Next prompt` section with the M4-T3 prompt in the format of `.claude/skills/orchestration/subagent-prompt.md` (it must tell the next sub-agent to read only the Module 4 header + its decisions (D1, M3 D3 defaults) + its own row, and the module-4 spec; carry over anything M4-T3 needs from your work).
3. Commit everything, journal included, as `feat(backend): add webhook event and comment schema (M4-T2)` with an optional 2–4 bullet body. The last line is the Co-Authored-By trailer given in your dispatch message.
4. Return the report in the format of `.claude/skills/orchestration/subagent-prompt.md`.

## Choices to confirm
- M3-T8: whole query cache cleared on sign-in/up · /register field order name → business → email → password · own en/bn validation (noValidate) · EN/BN switch on auth cards · Bangla digits in wait times · `safeRedirect` refuses /register
- M3-T9: no separate Log out while impersonating (Exit only) · close-tab screen has no login link / no `window.close()` · banner `bg-secondary`, "Changes you make here are real" · failed normal log-out now shows an alert
- M3-T10: safe `?redirect=` wins over the 0-Pages check · Finish needs ≥ 1 active Page · onboarding toggles not optimistic · token-less Page keeps a working switch on onboarding · upgrade message without link (Module 8) · `?meta=` stays in URL · inline SVG brand icons
- M3-T11: token-less Pages show a reconnect hint + disabled switch on /pages · one switch covers Page + linked IG · Reconnect hidden when 0 Pages
- M3-T12: super admin seeded via `create-super-admin` (suite targets compose only) · host runs need `E2E_CHROMIUM_PATH` · e2e image ≈ 4 GB · suite not in CI yet
- M4-T1: admin queue counts: a queue whose count fails/times out (3 s) is left out, so Redis down → `queues: []` (card says "No queues yet"; the Redis pill shows the outage) instead of an error row (would need admin + DTO change) · one connection config for queues and workers with `maxRetriesPerRequest: null` (`@nestjs/bullmq` builds workers from the queue connection), so producers must time-box queue calls · each queue/worker has its own ioredis connection (3 now, +2 per worker; Redis Cloud free allows 30) · eviction check reads `INFO memory` (not `CONFIG GET`), runs in the background, warns only · `commentJobId()` rejects `:` inside a part (BullMQ allows `:` only in 3-part ids) · e2e `REDIS_URL` moved to `redis://127.0.0.1:1` · no worker test double yet (left to the first `@Processor` row)

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
- 2026-11-18 M4-T1 ✅ · backend 597 + e2e 383 · BullMQ QueueModule (3 D3 queues), eviction warning, real admin queue counts, e2e FakeQueue
