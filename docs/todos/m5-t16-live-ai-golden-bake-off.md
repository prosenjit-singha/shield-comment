# TODO: Module 5 live AI golden bake-off (M5-T16)

Status: **waiting on credentials** (paused 2026-11-19). The Module 5 orchestration run is paused at this row, and M5-GATE needs its result.

M5-T16 now runs after PW-GATE (plans, subscriptions & wallet rows, TASKS.md section PW).

## What it is
Run the 48-comment golden suite (`backend/test/fixtures/golden-comments.ts`, labels reviewed by you) against real AI models. The cheapest model that scores **≥ 90 %** becomes ShieldComment's moderation model. The run records that model's answers so the automated tests can replay them without live calls.

## What you need to do first
Provide at least one of these. Never commit them, and nothing will print or log them.
- **Neon AI Gateway credits:** buy credits, then put the gateway base URL and token in `backend/.env.neon` (or `backend/.env`).
- **Direct provider key(s):** OpenAI, Anthropic and/or Google. Save them in admin `/admin/settings` → AI provider (encrypted in the DB), or in the git-ignored `backend/.env`.

## Answers already given (2026-11-19)
- **Models to compare** (only those with working credentials run):
  - Neon `gpt-oss-20b` + `gpt-oss-120b`
  - OpenAI `gpt-4.1-nano` + `gpt-4.1-mini`
  - Google `gemini-2.5-flash-lite` + `gemini-2.5-flash`
  - Anthropic `claude-haiku-5-5`, which also confirms the Anthropic API version header chosen in M5-T2
- **Spend cap:** up to **US$2** in total. The run adds up the estimated cost and stops at the cap.
- **Winner:** the cheapest model with ≥ 90 % accuracy. Ties go to higher accuracy, then lower latency. It is **set active in the local dev database's AI settings**, with a history entry, and its answers are recorded as `backend/test/fixtures/golden-responses.<provider>.<model>.json`.
- **Context level** (plan default, not asked): only "comment only" (`comment_only`) runs. The other levels multiply the number of calls.
- If no model reaches 90 %, nothing is changed. The run reports the misses and asks you what to do: a few-shot prompt `moderation-v3`, a bigger model, or the emoji fallback (hide all emoji-only comments, D12).

## How to resume
Once the credentials are in place, send:

```
/orchestration --continue
```

The full sub-agent prompt is in `docs/progress/ORCHESTRATION.md` under `## Next prompt (M5-T16)`. The row is `M5-T16` in `docs/progress/TASKS.md`.

## Related
- M5-T17 (live Meta smoke test) also stays pending until a Meta test app exists. The checklist is in `docs/project-documentation/meta-webhooks-local.md`.
- Your Docker compose backend still runs older code. Rebuild it to see the new admin and client screens in a browser.
