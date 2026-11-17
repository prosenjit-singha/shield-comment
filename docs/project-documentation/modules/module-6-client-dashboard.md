# Module 6: Client Dashboard Charts, Live Feed, Rules Engine & Playground

> **Previous:** [`./module-5-ai-moderation.md`](./module-5-ai-moderation.md) | **Next:** [`./module-7-support-team.md`](./module-7-support-team.md) | **Client UI Spec:** [`../../design/client.md`](../../design/client.md)

## Objective & Dependencies
Build the core `client/` moderation workspace: Dashboard with Recharts visualizations, Live Comment Feed with manual overrides, Rules Engine, AI Playground, and Agency Analytics. **Dependency:** Module 5.

## Backend Implementation (`backend/`)
- Tables: `ModerationRule` (`blocked_keywords`, `block_urls`, `block_phone_numbers`, `auto_hide_threshold`, `auto_reply_templates`), `DailyAnalytics`.
- Static Rule Engine runs **before** AI Classifier (matching URLs and BD phone regex `(?:\+88)?01[3-9]\d{8}`) to save LLM token costs.
- Endpoints: `GET /dashboard/summary` (KPIs + chart arrays), `GET /comments`, `POST /comments/:id/override`, `GET/POST/PATCH /rules`, `POST /playground/test`, `GET /analytics`, `GET /analytics/export.csv`.

## Frontend Implementation (`client/`)
Build Screens **C4** (`/dashboard` with Recharts Line, Bar & Donut charts), **C5** (`/comments`), **C7** (`/rules`), **C8** (`/playground`), and **C9** (`/analytics`) as TanStack Start file routes under the logged-in `_app` layout (rendered in the browser; filters as typed search params via `validateSearch`) using [Animate UI](https://animate-ui.com/docs), [Zustand](https://zustand-demo.pmnd.rs/), [TanStack Query](https://tanstack.com/query/latest), and `content(english, bangla)`.

## Agent Test & Verification Gate
- Rule priority unit test confirms custom keyword/BD-phone match bypasses AI LLM call.
- E2E UI test verifies dashboard charts render and clicking "Unhide" on `/comments` mutates comment status.
