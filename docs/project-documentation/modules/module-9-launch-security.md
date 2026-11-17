# Module 9: Security Hardening, Meta App Review & Bangladesh Production Launch

> **Previous:** [`./module-8-billing-sslcommerz.md`](./module-8-billing-sslcommerz.md) | **Brief:** [`../base.md`](../base.md)

## Objective & Dependencies
Harden API security, complete Meta App Review for live permissions, and switch SSLCommerz to production Bangladesh merchant credentials. **Dependency:** Modules 0–8.

## Implementation Checklist
- Global rate limiting (`@nestjs/throttler`) plus Better Auth rate limits on `/api/auth/*`, Helmet HTTP headers, Better Auth `trustedOrigins` and strict CORS limited to the `admin/` and `client/` origins, `Secure` + `httpOnly` session cookies, immutable audit logs.
- Production data: Neon production branch (pooled `DATABASE_URL`, direct `DIRECT_URL` for the Drizzle migrate script), Redis Cloud with `noeviction`, uptime monitor on `/api/health/live` (not the DB health route).
- Choose hosting for the `backend/` and `client/` Node containers and the `admin/` static build, with `/api` proxied on each app origin (see [`../tech-stack.md`](../tech-stack.md#4-same-origin-api-and-cookie-isolation)).
- Meta App Review submission package (screencast + privacy policy + data deletion callback) for `pages_manage_engagement` and `instagram_manage_comments`.
- Switch [SSLCommerz](https://developer.sslcommerz.com/doc/v4/) env from sandbox to live Store ID/Password.

## Agent Test & Verification Gate
- Full staging E2E smoke test across `admin/`, `client/`, and `backend/`.
- Live Meta webhook test on a real test Facebook Page confirms end-to-end comment hiding and auto-reply.
