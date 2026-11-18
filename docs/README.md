# ShieldComment BD — AI Agent Documentation Index

Welcome to the modular documentation for **ShieldComment BD** (working title), an AI-powered ad-comment spam, scam, and competitor-poaching blocker built for **Bangladesh F-commerce & DTC brands** (Phase 1: Bangladesh only; Phase 2: International expansion).

> **How AI Coding Agents Should Use This Folder:**
> Do **not** read every file at once. Start with [`./project-documentation/base.md`](./project-documentation/base.md), [`./project-documentation/tech-stack.md`](./project-documentation/tech-stack.md) and [`./design/base.md`](./design/base.md), then open **only** the specific module file in `./project-documentation/modules/` that you are currently implementing and testing.

## Folder Structure

```text
docs/
├── README.md
├── project-documentation/
│   ├── base.md
│   ├── tech-stack.md
│   ├── screens-inventory.md
│   ├── meta-webhooks-local.md
│   └── modules/
│       ├── module-0-scaffolding.md
│       ├── module-1-auth-rbac.md
│       ├── module-2-admin-panel.md
│       ├── module-3-client-meta.md
│       ├── module-4-webhooks-queue.md
│       ├── module-5-ai-moderation.md
│       ├── module-6-client-dashboard.md
│       ├── module-7-support-team.md
│       ├── module-8-billing-sslcommerz.md
│       └── module-9-launch-security.md
├── progress/
│   ├── TASKS.md
│   └── MEMORY.md
└── design/
    ├── base.md
    ├── admin.md
    └── client.md
```

## Quick Navigation

- **Progress (read first every session):** [`./progress/TASKS.md`](./progress/TASKS.md) · [`./progress/MEMORY.md`](./progress/MEMORY.md)

- **Project Brief & Architecture Rules:** [`./project-documentation/base.md`](./project-documentation/base.md)
- **Tech Stack, Hosting & Auth Design (source of truth):** [`./project-documentation/tech-stack.md`](./project-documentation/tech-stack.md) — NestJS · Drizzle ORM · Neon · Redis/BullMQ · Better Auth · TanStack Router (admin) · TanStack Start (client)
- **Meta test app + local webhook tunnel (zrok2, live-smoke checklist):** [`./project-documentation/meta-webhooks-local.md`](./project-documentation/meta-webhooks-local.md)
- **All 20 Screens (7 Admin + 13 Client):** [`./project-documentation/screens-inventory.md`](./project-documentation/screens-inventory.md)
- **Shared UI Tokens, Animate UI, Zustand & TanStack Query:** [`./design/base.md`](./design/base.md)
- **Super Admin Panel UI & Charts Spec:** [`./design/admin.md`](./design/admin.md)
- **Client App & Landing Page SEO/UI Spec:** [`./design/client.md`](./design/client.md)
