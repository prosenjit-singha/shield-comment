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
- **Meta Action Executor:** Calls Meta Graph API `POST /{comment_id}?is_hidden=true`, `DELETE /{comment_id}`, or `POST /{comment_id}/comments` (auto-reply).

## Agent Test & Verification Gate
- Golden test suite of 30+ real-world Bangla, Banglish, and English F-commerce comments achieves **>=90% classification accuracy**.
- Mocked Meta Graph API integration tests verify exact hide, delete, and reply payloads.
