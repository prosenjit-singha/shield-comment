# Module 4: Meta Webhook Ingestion & BullMQ Async Queue

> **Previous:** [`./module-3-client-meta.md`](./module-3-client-meta.md) | **Next:** [`./module-5-ai-moderation.md`](./module-5-ai-moderation.md)

## Objective & Dependencies
Ingest live Facebook Page and [Instagram Webhooks](https://developers.facebook.com/documentation/instagram-platform/webhooks) reliably with HMAC verification, sub-200ms responses, and idempotent BullMQ queuing. **Dependency:** Module 3.

## Backend Implementation (`backend/`)
- Tables: `WebhookEvent` (`id`, `event_id`, `payload_hash`, `processed_at`), `Comment` (`id`, `comment_id`, `workspace_id`, `page_id`, `post_id`, `author_name`, `author_id`, `message`, `platform`, `raw_payload`, `status`).
- `GET /webhooks/meta`: Handle Meta `hub.mode`, `hub.verify_token`, and `hub.challenge`.
- `POST /webhooks/meta`: Verify `X-Hub-Signature-256` HMAC against raw body using App Secret; enqueue to BullMQ `comment-moderation` queue and return `200 OK` within 200ms.
- Worker deduplicates by `comment_id` using `WebhookEvent` before persisting `Comment` with status `PENDING`.

## Agent Test & Verification Gate
- Invalid HMAC signature returns `401`/`403`.
- Valid signed payload returns `200 OK` in `<200ms`, enqueues BullMQ job, and ignores duplicate `comment_id` retries.
