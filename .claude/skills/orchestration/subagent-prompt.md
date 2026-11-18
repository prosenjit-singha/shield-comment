# Sub-agent prompt + report contract

Every `## Next prompt` in `docs/progress/ORCHESTRATION.md` has the sections below, in this order. The orchestrator writes the first one. After that, **each sub-agent writes the next one** when it finishes its row.

## Prompt sections (in order)

```markdown
## Next prompt (ROW-ID)

You are implementing exactly ONE task row, **ROW-ID**, in the ShieldComment BD repo at /home/veronica/projects/shield-comment (WSL2, Node 24, npm 11, Docker in WSL). Work directly; do not spawn sub-agents. Be token-lean: don't read the whole docs/ folder.

**Read first (only these)**
1. `AGENTS.md`.
2. `docs/progress/MEMORY.md` (all).
3. From `docs/progress/TASKS.md` (use `grep -n`/`sed -n`; the file is large): the module header, the decision lines this row depends on (name them, e.g. D5, D13), the previous row (for context) and this row with its notes/carry-overs. If the row still says "needs user decision X" but X is answered, say so here.
4. Spec: `docs/project-documentation/modules/module-N-*.md` (name the section). UI rows also: `docs/design/base.md` + the relevant `admin.md`/`client.md` sections + the screens-inventory entry.
5. Code to read or reuse: exact paths, and the test harness to copy.

**Recorded decisions** (only if the row needs them): quote the answer, with its date and ID.

**Task (ROW-ID): <one-line title>**
- Concrete deliverables: routes, files, behaviour, error cases.
- Tests to write: name the cases (incl. en + bn for client copy).

**Rules:** TS strict, ESM, no `any`. Vitest. No live external calls in tests (Meta/SSLCommerz/etc. mocked); tests must fail on unexpected requests. Every tenant query is scoped by `workspace_id`. Frontend: TanStack Query for all API calls, client copy via `content(en, bn)`, shadcn OKLCH tokens, `rounded-full` buttons/inputs/pills, `rounded-2xl`/`3xl` cards. A new shadcn component needs `shadcn add` + `animate all` in BOTH apps. Never commit `.env*` (except `.env.example`) or build/test output. **Never stop or kill the user's own processes** (local Postgres 5432, Redis 6379, dev servers); on a port clash use env overrides or stop and report.

**Verify** (run what applies; report real numbers):
- backend touched: `npm run build`, `npx tsc --noEmit -p tsconfig.json`, `npm test`, `npm run test:e2e`, `npm run lint`, `npx prettier --check "src/**/*.ts" "test/**/*.ts"`. The test DB must end empty except the 4 `plans` rows.
- admin/client touched: `npm run build`, `npm test`, `npm run lint` in that app.
- e2e/ or compose touched: `cd e2e && npm test` (+ `npm run test:docker` when the image changes). The DB must return to its baseline.
- Current test counts: <project: N> (so drops are visible).

**If a decision is missing:** if THIS row needs a product decision that is not recorded in TASKS.md/MEMORY.md/this prompt, STOP without coding that part. Report `STATUS: needs-decision` with the question and 2–4 options (recommended first). If your row finishes but the NEXT row needs decisions (e.g. a planning row), report `STATUS: done`, list them under DECISION NEEDED and start the next prompt with `PRE-CHECK: needs user decisions <ids> before dispatch`.

**Finish (in this order)**
1. TASKS.md: the row → `✅ <date>` + concise notes (built + choices). Add a Verification log entry at the TOP of `## Verification log`. Add short lasting facts to MEMORY.md and point its "next" phrase at the next row.
2. Journal `docs/progress/ORCHESTRATION.md`:
   - append one `## Log` line (`- <date> ROW ✅ · <tests> · <1-line summary>`); the orchestrator adds the commit hash;
   - append your choices under `## Choices to confirm` as `- ROW: …`;
   - **replace** the `## Next prompt` section with the next row's prompt in this same format. Write `RUN COMPLETE` instead if the run scope in `## Run` is finished, or if no rows are left in the module.
3. Commit everything, journal included, with `<the row's Conventional Commits message>` (its subject must contain `(ROW-ID)`) and an optional 2–4 bullet body. The last line is the Co-Authored-By trailer given in your dispatch message.
4. Return the report below.
```

## Report format (the hand-back; exactly these fields, short)

```
STATUS: done | blocked | needs-decision
ROW: <id>
COMMIT: <hash> <subject>   (or: none)
CHECKS: <project>: build ✅ · test N/N (was M) · lint ✅ · …   (one line per project run)
FILES: <short list or "see commit">
CHOICES: 1. … 2. …   (or: none)
OPEN: …   (or: none)
DECISION NEEDED: <question> — options: (a) … (recommended) (b) …   (needs-decision, or decisions the next row needs)
NEXT: <next row id> — written to the journal's "## Next prompt"   (or: RUN COMPLETE)
```

Blocked or needs-decision rows: don't commit partial code. Leave the tree clean if you can, and list any files you leave changed. Still write the `## Log` line (`🟡 blocked: …`) to the journal; the orchestrator commits it.
