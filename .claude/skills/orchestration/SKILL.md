---
name: orchestration
description: Use when the user invokes /orchestration to run TASKS.md rows through sequential sub-agents (start a run, `--continue` after a stop or disconnect, or `--status`), with this session acting only as task manager.
argument-hint: "[--continue | --status] [--rows N] [run instructions]"
disable-model-invocation: true
---

# Orchestration (ShieldComment BD)

You are the **task manager**, not the implementer. You run `docs/progress/TASKS.md` rows one at a time through fresh sub-agents. You verify each result yourself and keep the run journal current so any stop can be resumed.

Invoking this skill is the user's explicit opt-in. It overrides CLAUDE.md's "don't spawn sub-agents" for this run only.

Arguments: `$ARGUMENTS`

Tools: `Agent` (`general-purpose`, runs in the background), `SendMessage` (continue the same sub-agent, even after its hand-back), `TaskStop`, `AskUserQuestion`, `Bash` (git/grep checks), `Edit` (journal only).

## Iron rules
1. **One sub-agent at a time.** Never run two in parallel, and never start the next one before the current row is verified or paused.
2. **Never implement or patch.** Anything wrong in a sub-agent's work, even a typo in TASKS.md, goes back to that sub-agent (SendMessage). The only file you edit is `docs/progress/ORCHESTRATION.md` (the journal).
3. **The journal is the source of truth.** Write it before every dispatch and after every verification. A stop at any moment must be resumable from the journal plus git.
4. **Never invent results.** Until the sub-agent's hand-back arrives, say "still running".
5. **Don't stop the user's processes.** Don't discard uncommitted work without asking. Never amend or rewrite commits.

## Files
- Journal: `docs/progress/ORCHESTRATION.md`, committed. Start it from `journal-template.md` if it is missing.
- Sub-agent prompt + report contract: `subagent-prompt.md` (in this folder). Every dispatched prompt and every "next prompt" a sub-agent writes follows it.

## Modes
- **Start** (`/orchestration <instructions>`):
  1. Read `docs/progress/MEMORY.md`, the TASKS.md header, the current module's section (decisions + rows; use `grep -n`/`sed -n`, the file is large) and the journal if it exists.
  2. Record in `## Run`: the scope (rows / "until X-GATE"), standing approvals, the row cap and the budget.
  3. Write the first `## Next prompt` yourself, following the contract.
  4. Enter the loop.
- **Continue** (`--continue`):
  1. Read the journal, the "next" pointer in MEMORY.md, `git log -5 --format='%h %s'` and `git status --short`.
  2. Reconcile using the table below.
  3. Start a new session in `## Run` (`rows this session = 0`, `estimate = 40k`) and enter the loop.
- **Status** (`--status`): print the journal's `## State`, the last 5 `## Log` lines, `## Choices to confirm` and any pending decision. Do nothing else.

### Reconcile on `--continue`
`## State` for a dispatched row reads `dispatched ROW (date) · commit: "<expected subject>"`. A commit "matches" when its subject contains `(ROW)`; find them with `git log --oneline --grep="(ROW)" -F`. Match on `## State` first: a `paused:` state wins over whatever the tree looks like. An unknown or missing state means: show `--status` and ask the user.

| Journal state | Git | Action |
|---|---|---|
| `dispatched ROW` | a matching commit, tree clean | The row finished while you were gone: run **Verify** without the report checks, then continue. |
| `dispatched ROW` | a matching commit, tree dirty | Show `git status --short` and ask the user before doing anything. |
| `dispatched ROW` | no matching commit, tree clean | Nothing landed: dispatch the same `## Next prompt` again. |
| `dispatched ROW` | no matching commit, tree dirty | Interrupted mid-row: set `paused: interrupted ROW`, commit the journal, then AskUserQuestion with `git status --short`. Options: a fresh sub-agent inspects and finishes the partial work, or the user discards it. Never discard on your own. |
| `paused: needs decision` | — | Ask that decision now (AskUserQuestion), record the answer, continue. |
| `paused: <other reason>` | — | Tell the user the reason. Continue only when they say it is cleared. |
| `idle` / `verified ROW` | — | Continue from `## Next prompt`. |
| `done: …` | — | The run finished. Tell the user and wait for new `/orchestration <instructions>`. |

## The loop (one row per turn)
1. **Pre-check the next prompt.** Read `## Next prompt` and the target TASKS.md row. Ask the user with AskUserQuestion **before dispatching** if any of these holds:
   - **Missing decision:** the prompt or row needs a product decision that is not recorded. Signs: a `PRE-CHECK:` line, "needs user decision", a choice between behaviours, credentials or external accounts.
   - **App approval:** the row touches `admin/` or `client/` and `## Run` has no standing approval for that app. Ask whether the approval covers this row only or the rest of the run. Record the answer in `Standing approvals`.

   Recording answers:
   - Write each answer to the journal as you get it: verbatim under `## Decisions asked`, and under `### Decisions added by orchestrator` at the end of the prompt (the sub-agent records it in TASKS.md). Delete a `PRE-CHECK:` line once it is answered.
   - AskUserQuestion takes at most 4 questions per call, so make several calls for longer lists.
   - If the user answers "Other" with free text, record their words verbatim.
2. **Dispatch.**
   - Set `## State` to `dispatched ROW (date) · commit: "<the row's commit message>"`.
   - Your pre-dispatch journal edits are not committed separately; they go into the sub-agent's commit.
   - Launch ONE `general-purpose` Agent with this prompt: *"You are the sub-agent for row ROW. Your full instructions are the `## Next prompt` section of `docs/progress/ORCHESTRATION.md` (read only that section of the journal). Follow them exactly, including the report format in `.claude/skills/orchestration/subagent-prompt.md`. Commit trailer to use: `<the Co-Authored-By line from this session's attribution instructions>`."*
   - Wait for the hand-back. Don't poll the output file. User messages still reach you while it runs.
3. **Verify** after the hand-back (one Bash call for the git/grep part):
   - **Report checks:** `STATUS: done`; the CHECKS test counts did not drop compared with the last `## Log` line for the same project, unless the report explains why.
   - **Git checks:** `git status --short` is empty. HEAD is a matching commit (its subject contains `(ROW)`), and its body ends with the Co-Authored-By trailer. `git show --stat HEAD` has no `.env*` file except `.env.example`, and no `dist/`, `build/`, `test-results/` or `node_modules/`.
   - **Docs checks:**
     - The TASKS.md row status is `✅ <date>` (or `➡️ moved` if the prompt allowed it).
     - The top `## Verification log` entry is this row.
     - The MEMORY.md "next" pointer names the next row.
     - The journal has this row's `## Log` line, its choices under `## Choices to confirm` (the sub-agent writes them; you don't copy them again) and a new `## Next prompt` (or `RUN COMPLETE`).
   - **Any other defect you notice** (a typo in the row, a wrong file, a missing test the prompt required) counts as a failed check.
   - **If the report says `blocked` or `needs-decision`** (this row stopped), skip the checks above. Check only that no partial code was committed. Then **pause**; `## Next prompt` stays the same row.
     - Missing 🟡 `## Log` line: add it yourself (the journal is yours).
     - Leftover changed files: list them in `## State` (`paused: blocked ROW · uncommitted: <files>`).
   - A row that **finished** but leaves decisions for the next row (e.g. a planning row) reports `STATUS: done` with a `PRE-CHECK:` line on the next prompt. It is verified normally, and step 1 asks those decisions.
4. **If a check fails:**
   - SendMessage the same sub-agent **once**, naming the exact failed check(s). The fix is a follow-up commit whose subject also contains `(ROW)` (e.g. `docs(progress): fix row record (ROW)`), never an amend. Verify again. The `## Log` line keeps the row's main commit hash and adds the fix hash.
   - If it still fails, **pause**.
   - If the hand-back says the sub-agent is still "waiting on its own background work", stop that sub-agent's task (TaskStop with its id, never a user process) **before Record**, then re-run `git status --short`.
5. **Record**, in this order:
   1. Add the commit hash to the row's `## Log` line and set `## State` to `verified ROW` (keep any `stop requested` note).
   2. Increment `rows this session` and add the row's estimate to the budget.
   3. Run the stop test (below). Name every trigger that fired in the pause reason.
   4. Commit the journal, one commit only. If you are pausing, it is the pause commit (`docs(orchestration): pause at ROW (<reason>)`); otherwise it is `docs(orchestration): verify ROW`. Both carry the Co-Authored-By trailer.
6. **Tell the user 3–6 lines:** row, commit, tests, notable choices, and what you dispatch next or why you paused. If you are not pausing, go to step 1.

## When to stop (pause)
Pause at the stop test (step 5.3), never mid-row, when **any** of these is true:
- **Row outcome:** the report says `blocked` or `needs-decision`, or the row ends 🟡. A test that fails and the sub-agent can't fix counts as blocked.
- **Failed check:** a check still fails after one fix round.
- **User input needed:** credentials, a manual step, or a denied permission (surface it; never work around it).
- **Run boundary:** a module `GATE` row passed, the run scope in `## Run` is done, or `## Next prompt` is `RUN COMPLETE`.
- **Row cap:** `rows this session` ≥ the row cap (default 10, `--rows N` overrides).
- **Budget:** the estimate is ≥ **400k** tokens. The real limit is ~500k; the margin covers estimate error.
- **The user asks to stop** (stop, pause, halt, enough, …). Write `stop requested (date)` into `## State` right away, so a disconnect can't lose it. Let the running row finish, verify it, then pause. Only an explicit "now", "immediately", "abort" or "kill" means TaskStop at once; then record `paused: interrupted ROW` and handle it like the dirty-tree row of the reconcile table on `--continue`.

On pause:
- Set `## State` to `paused: <reason>`. If the run scope is finished (`RUN COMPLETE` / the scope's last row passed), set it to `done: <scope> (date)` instead and commit as `docs(orchestration): finish run (ROW)`; its `## Resume` text asks for a new `/orchestration <instructions>`.
- Fill `## Resume` with the exact text the user should send. Usually it is `/orchestration --continue`; add any pending decision question.
- Make the pause commit (journal only). If a blocked sub-agent left code changes, leave them uncommitted and list them.
- Report:
  - rows done this session, with commit hashes
  - the checks
  - all of `## Choices to confirm` not yet shown to the user
  - open decisions
  - the resume text in a plain fenced code block

## Budget estimate
You can't read your context usage, so estimate:
- **Start:** 40k per new session (system prompt, this skill, MEMORY.md, the TASKS.md section).
- **Each row:** add `(characters of the report + characters of the next prompt you read + verification output) / 4`, plus 5k overhead. If you're unsure, use 20k.
- **Extra reads:** add `characters / 4` for any extra file you read in full.
- Keep the running total in `## Run`.

## Red flags: stop and re-read the rules
- "This fix is tiny, I'll just do it myself" → no. Send it back to the sub-agent (SendMessage), or pause.
- "Two independent rows can run in parallel" → no, one at a time.
- "The report says done, so I'll skip verification" → no. Verify every row.
- "I'll update the journal after the next row" → no. Write it before every dispatch and after every verification.
- "The choice looks fine, I'll treat it as confirmed" → no. It stays in `## Choices to confirm` for the user.
- "I can guess this decision from context" → no. Ask with AskUserQuestion before dispatching.
