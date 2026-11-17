# Module 3: Client Auth, Impersonation Handoff & Meta (FB/IG) OAuth Connection

> **Previous:** [`./module-2-admin-panel.md`](./module-2-admin-panel.md) | **Next:** [`./module-4-webhooks-queue.md`](./module-4-webhooks-queue.md) | **Client UI Spec:** [`../../design/client.md`](../../design/client.md)

## Objective & Dependencies
Begin building the `client/` app (TanStack Start): Better Auth sign-in/sign-up, Admin 1-click impersonation token exchange, and Meta OAuth to connect Facebook Pages & Instagram Business accounts. **Dependency:** Module 2.

## Backend Implementation (`backend/`)
- `MetaConnection` (`id`, `workspace_id`, `facebook_user_id`, `encrypted_user_access_token`, `token_expires_at`)
- `SocialPage` (`id`, `workspace_id`, `page_id`, `ig_business_id`, `page_name`, `encrypted_page_access_token`, `is_active`)
- AES-256-GCM token encryption/decryption service.
- Endpoints using [Meta Facebook Pages API](https://developers.facebook.com/documentation/pages-api) (`pages_manage_engagement`, `pages_read_user_content`) and [Instagram Platform](https://developers.facebook.com/documentation/instagram-platform/comment-moderation) (`instagram_manage_comments`): `GET /meta/oauth/url`, `GET /meta/oauth/callback`, `GET /pages`, `PATCH /pages/:id/toggle`.

## Frontend Implementation (`client/`)
- Build **C2** (`/login`, `/register` with `authClient.signIn.email` / `signUp.email`; `/impersonate` calls `POST /api/auth/impersonate-exchange` then goes to `/dashboard`), **C3** (`/onboarding`), and **C6** (`/pages` base view). Logged-in routes sit under the `_app` layout, whose `beforeLoad` redirects to `/login` when there is no session.
- Include top-bar **English / Bangla** switcher persisted via Zustand `useLanguageStore` (cookie `shield-lang`), with all copy wrapped in `content(english, bangla)`.
- Render a persistent `"Admin Impersonation Mode"` banner whenever `session.impersonatedBy` is present in the Better Auth session.

## Agent Test & Verification Gate
- AES-256-GCM encryption/decryption unit test passes.
- Mocked Meta OAuth callback maps Pages and IG accounts into `SocialPage`.
- E2E test: 1-click login from `admin/` lands on `client/` `/dashboard` with the impersonation banner visible.
