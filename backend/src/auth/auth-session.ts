import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { Request } from 'express';
import type { WorkspaceRole } from '../db/schema/index.js';
import type { BetterAuth } from './better-auth.js';

/**
 * The verified Better Auth session (`@Session()`), typed with our plugins:
 * `user.role` (admin plugin), `session.activeOrganizationId` (organization plugin, the current
 * workspace) and `session.impersonatedBy` (admin plugin / M1-T3 impersonation).
 */
export type AuthSession = UserSession<BetterAuth>;

/** Workspace scope resolved by `WorkspaceAccessGuard` / `RolesGuard` (read it with `@CurrentWorkspace()`). */
export interface WorkspaceContext {
  id: string;
  role: WorkspaceRole;
}

/** What the global Better Auth `AuthGuard` and our guards attach to the request. */
export type AuthRequest = Request & {
  session: AuthSession | null;
  workspace?: WorkspaceContext;
};
