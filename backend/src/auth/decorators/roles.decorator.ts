import { SetMetadata } from '@nestjs/common';
import type { WorkspaceRole } from '../../db/schema/index.js';

/** Own key: the Better Auth integration's `@Roles` uses `ROLES` (platform `user.role`). */
export const WORKSPACE_ROLES_KEY = 'workspace:roles';

/**
 * Workspace member roles allowed on a route or controller (owner / admin / moderator).
 * Enforced by `WorkspaceAccessGuard` on `:workspaceId` routes and by `RolesGuard` on routes that
 * act on the session's active workspace. Without it, any member passes.
 */
export const Roles = (...roles: WorkspaceRole[]) =>
  SetMetadata(WORKSPACE_ROLES_KEY, roles);
