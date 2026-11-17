# legacy-auth/ — reference only (not built, linted, tested or shipped)

Moved here in SW-T2 (Prisma → Drizzle). The repo has no git history, so this folder is the
only copy. Excluded in `tsconfig.json`, both Vitest configs, `.dockerignore` and `.prettierignore`;
`oxlint` only scans `src/` and `test/`. Delete the folder once M1-T1/M1-T3 have ported what they need.

| Path | What it is | Port in |
|---|---|---|
| `src/auth/guards/` (`jwt-auth`, `roles`, `super-admin`), `src/auth/decorators/` | Old M1-T4 guard drafts on the custom JWT (`AccessTokenPayload`). | M1-T1 (re-read Better Auth sessions instead) |
| `src/workspaces/` | `WorkspacesModule`: `GET/PATCH /workspaces/:workspaceId`, `WorkspaceAccessGuard` (404 non-member, 403 suspended / low role). Prisma queries. | M1-T1 (Drizzle + `eq(workspaceId)`) |
| `src/admin/` | `AdminModule`: `GET /admin/clients`. Prisma queries. | M1-T1 |
| `src/auth/token.service.ts` (+ spec), `auth.module.ts`, `auth.types.ts` | Custom JWT `TokenService` + module wiring. | Not ported; removed for good in SW-T4 |
| `recovered-js/auth/` | `AuthService` / `AuthController` / DTOs of the old `/auth/register|login|refresh|me`. The `.ts` sources were deleted by mistake during the first SW-T2 attempt; this is the compiled ESM JS + `.d.ts` copied out of the pre-change Docker image. Shows the old register flow (user + first workspace + owner membership in one transaction, slug helper). | SW-T4 sign-up hook (first workspace) |
| `better-auth-prisma-spike/` | Working Better Auth spike on **Prisma** (`better-auth` 1.7.25 + `@thallesp/nestjs-better-auth` 2.8.0): config + e2e (sign-up → sign-in → get-session, guard, body parsing), 6/6 green on NestJS 12 ESM before Prisma was dropped. | SW-T3 (swap to the Drizzle adapter) |
| `prisma/` | Last `schema.prisma` + its two migrations: the model reference (enums, indexes, `onDelete` rules, `impersonation_audit_logs`). | SW-T3/SW-T4/M1-T3 Drizzle schema |

The old auth e2e spec (`test/auth.e2e-spec.ts`, 11 tests) was deleted in the same mistake and could not be recovered (tests aren't in the build output).
