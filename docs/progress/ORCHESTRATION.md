# Orchestration journal

Run state for `/orchestration` (skill: `.claude/skills/orchestration/`). Committed. Resume with `/orchestration --continue`. No secrets here.

## Run
- Scope: Module 4: M4-PLAN, then rows until M4-GATE (after the user answers the planned decisions)
- Standing approvals: none yet for Module 4 (ask before the first admin/ or client/ row)
- Row cap per session: 10 · Budget stop: 400k (est.)
- Session: #2 not started · rows this session: 0 · estimate: 40k

## State
idle (Module 3 run finished 2026-11-18, M3-GATE passed)

## Resume
`/orchestration --continue`

## Next prompt (M4-PLAN)

You are implementing exactly ONE task row, **M4-PLAN**, in the ShieldComment BD repo at /home/veronica/projects/shield-comment (WSL2, Node 24, npm 11, Docker in WSL). Work directly; do not spawn sub-agents. Be token-lean: don't read the whole docs/ folder.

**Read first (only these)**
1. `AGENTS.md`.
2. `docs/progress/MEMORY.md` (all).
3. From `docs/progress/TASKS.md` (use `grep -n`/`sed -n`): the Module 3 header, decisions D1–D14 (especially D3, D7, D8 and the "Implementation choices M3-T4…T6" line), the M3-T7 row (moved to Module 4), the M3-GATE row and the top Verification log entry.
4. Spec: `docs/project-documentation/modules/module-4-*.md` in full, plus only the BullMQ/Redis parts of `docs/project-documentation/tech-stack.md`.

**Task (M4-PLAN): plan Module 4 (docs only, no code)**
- Add `## Module 4 — …` to TASKS.md, after Module 3 and before `## Verification log`. It needs a header paragraph (spec link, what it builds on, conventions as in Module 3) and one-session rows M4-T1…Tn + M4-GATE. Copy the gate from the spec's "Agent Test & Verification Gate".
- The rows must cover:
  1. The M3-T7 work moved here per D3/D8:
     - webhook verify `GET /api/meta/webhook` (`hub.challenge`, `@Public()`, verify token from env)
     - the `X-Hub-Signature-256` check on the raw body in a route guard
     - the Deauthorize + Data Deletion signed-request callbacks
     - a cloudflared tunnel for local testing
  2. The BullMQ `debug_token` job (D8: NEEDS_REAUTH/REVOKED).
  3. Module 3 carry-overs:
     - a connection-wide needs-reauth status in `GET /api/workspaces/:id/pages`
     - a disconnect endpoint (frees `page_id`/`ig_business_id` claims per D7)
     - `subscribed_apps` subscribe/unsubscribe on the Page toggle (D3)
  4. Everything else the module-4 spec requires (ingestion queue, workers, admin system-health `queues` in `AdminSystemService.queues()`, etc.).
  5. The M3-GATE findings:
     - the impersonated `/pages` empty state still shows the Connect button
     - direct-to-backend sign-ups share the `auth:no-trusted-ip` rate-limit bucket
- Mark rows that touch `admin/` or `client/` clearly, so the orchestrator can get approval first.
- Flag every open product decision as **needs user decision** (Module 4 D1…Dn): webhook fields/topics, queue names/retry policy, tunnel setup, Data Deletion status URL/confirmation code, disconnect semantics, and Module 3's still-open D1 items (app owner/Business portfolio, App Review + Business Verification timeline). Don't guess the answers.

**Verify:** docs only. `git diff --stat` shows only `docs/progress/*`.

**If a decision is missing:** this row only lists decisions; it never answers them.

**Finish (in this order)**
1. TASKS.md: add an M4-PLAN row (`✅ <date>`) and a Verification log entry at the top. MEMORY.md: note "Module 4 planned (M4-PLAN)" and the next row (short).
2. Journal: append the `## Log` line and replace `## Next prompt` with the M4-T1 prompt (in the format of `.claude/skills/orchestration/subagent-prompt.md`). Because the Module 4 decisions are unanswered, put this line at its top: `PRE-CHECK: needs user decisions <list> before dispatch`.
3. Commit as `docs(progress): plan module 4 (M4-PLAN)` with the Co-Authored-By trailer from your dispatch message.
4. Report in the contract format with `STATUS: done`, plus the full decision list under DECISION NEEDED (one question per decision, options with the recommended one first), so the orchestrator can ask the user before M4-T1.

## Choices to confirm
- M3-T8: whole query cache cleared on sign-in/up · /register field order name → business → email → password · own en/bn validation (noValidate) · EN/BN switch on auth cards · Bangla digits in wait times · `safeRedirect` refuses /register
- M3-T9: no separate Log out while impersonating (Exit only) · close-tab screen has no login link / no `window.close()` · banner `bg-secondary`, "Changes you make here are real" · failed normal log-out now shows an alert
- M3-T10: safe `?redirect=` wins over the 0-Pages check · Finish needs ≥ 1 active Page · onboarding toggles not optimistic · token-less Page keeps a working switch on onboarding · upgrade message without link (Module 8) · `?meta=` stays in URL · inline SVG brand icons
- M3-T11: token-less Pages show a reconnect hint + disabled switch on /pages · one switch covers Page + linked IG · Reconnect hidden when 0 Pages
- M3-T12: super admin seeded via `create-super-admin` (suite targets compose only) · host runs need `E2E_CHROMIUM_PATH` · e2e image ≈ 4 GB · suite not in CI yet

## Decisions asked
- 2026-11-18 M3-T10: D13 0-Pages redirect → entry points only (recorded in TASKS.md D13)

## Log
- 2026-11-18 M3-T8 ✅ 1e341c6 · client 131 · login + register, workspaceName via fetchOptions.body
- 2026-11-18 M3-T9 ✅ dcab638 · client 151 · app shell + impersonation banner
- 2026-11-18 M3-T10 ✅ 02cbe8f · client 241 · onboarding wizard + D13 entry-point redirect
- 2026-11-18 M3-T11 ✅ fad5526 · client 301 · /pages base view, optimistic toggle
- 2026-11-18 M3-T12 ✅ 50c2849 · e2e 2/2 (host + docker) · Playwright gate suite, playwright-cli image + skill
- 2026-11-18 M3-GATE ✅ 1493dce · backend 570 + e2e 379 · admin 246 · client 301 · e2e 2/2 · Module 3 passed
