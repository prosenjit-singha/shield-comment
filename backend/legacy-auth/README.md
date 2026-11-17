# legacy-auth/ — reference only (not built, linted, tested or shipped)

Moved here in SW-T2 (Prisma → Drizzle). The Better Auth-on-Prisma spike was ported to Drizzle in SW-T3
(`src/auth/better-auth.ts`, `test/better-auth.e2e-spec.ts`) and removed; it is in git at `b6ab00d`.
SW-T4 removed the custom JWT code (`TokenService`, `JwtAuthGuard`, auth module/types, old `@Public()`); it is in git at `48d36cb`. Excluded in `tsconfig.json`, both Vitest configs, `.dockerignore` and `.prettierignore`;
`oxlint` only scans `src/` and `test/`. Delete the folder once M1-T1/M1-T3 have ported what they need.

| Path | What it is | Port in |
|---|---|---|
| `src/auth/guards/` (`roles`, `super-admin`), `src/auth/decorators/` (`current-user`, `roles`) | Old M1-T4 guard drafts on the custom JWT (`AccessTokenPayload`, whose type file is gone). | M1-T1 (re-read Better Auth sessions instead) |
| `src/workspaces/` | `WorkspacesModule`: `GET/PATCH /workspaces/:workspaceId`, `WorkspaceAccessGuard` (404 non-member, 403 suspended / low role). Prisma queries. | M1-T1 (Drizzle + `eq(workspaceId)`) |
| `src/admin/` | `AdminModule`: `GET /admin/clients`. Prisma queries. | M1-T1 |
| `recovered-js/auth/` | `AuthService` / `AuthController` / DTOs of the old `/auth/register|login|refresh|me`. The `.ts` sources were deleted by mistake during the first SW-T2 attempt; this is the compiled ESM JS + `.d.ts` copied out of the pre-change Docker image. | Ported in SW-T4 (`src/auth/first-workspace.ts`); can go with the folder |
| `prisma/` | Last `schema.prisma` + its two migrations: the model reference (enums, indexes, `onDelete` rules, `impersonation_audit_logs`). | SW-T3/SW-T4/M1-T3 Drizzle schema |

The old auth e2e spec (`test/auth.e2e-spec.ts`, 11 tests) was deleted in the same mistake and could not be recovered (tests aren't in the build output).
