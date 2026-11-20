# Module 5: Bangla/Banglish AI Classifier & Meta Action Executor

> **Previous:** [`./module-4-webhooks-queue.md`](./module-4-webhooks-queue.md) | **Next:** [`./module-6-client-dashboard.md`](./module-6-client-dashboard.md)

## Objective & Dependencies
Classify incoming comments across Bangla, Banglish, and English using structured LLM outputs and execute hide/delete/reply actions via Meta Graph API. **Dependency:** Module 4.

## Backend Implementation (`backend/`)
- **AI Classifier:** Structured JSON output `{ category, confidence_score, reasoning }`:
  - `SAFE_INQUIRY` (e.g., `"price koto?"`, `"Sylhet e delivery hobe?"`)
  - `COMPETITOR_POACH` (external shop links, `"amader page e kom"`, WhatsApp numbers)
  - `SCAM_PHISHING` (fake bKash/Nagad cashback or lottery links)
  - `SPAM_IRRELEVANT`
  - `ABUSIVE_TOXIC`
- **Usage limit:** the Module 5 run first built per-plan AI credits (D7/D15, cost by context level). **Replaced 2026-11-19 by monthly comments (PW rows):** each comment counts 1 against the client account's wallet before its first AI call, edits are re-checked for free, and without a live plan or with the limit used up the comment stays visible as `SKIPPED` (`no_active_plan` / `comment_limit_reached`). See TASKS.md section PW.
- **AI models (re-planned 2026-11-20, M5-AIPLAN):** the admin uses the Neon AI Gateway only for now (direct-provider code stays as a fallback). A backend catalog file of Neon models (name, code, lab, input types, context window, input/output price) feeds cost estimates and two admin dropdowns: a **Text** model and a **Text + Image** model (image-capable models only). Today only comment text reaches the classifier. See TASKS.md Module 5 D17–D23.
- **Meta Action Executor:** Calls Meta Graph API `POST /{comment_id}?is_hidden=true`, `DELETE /{comment_id}`, or `POST /{comment_id}/comments` (auto-reply).

## Agent Test & Verification Gate
- Golden test suite of 30+ real-world Bangla, Banglish, and English F-commerce comments achieves **>=90% classification accuracy**.
- Mocked Meta Graph API integration tests verify exact hide, delete, and reply payloads.
