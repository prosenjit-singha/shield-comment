import { type ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { WorkspaceRole } from '../../db/schema/index.js';
import type { WorkspaceMembership } from '../authz-queries.js';
import { WORKSPACE_ROLES_KEY } from '../decorators/roles.decorator.js';

/** `@Roles(...)` on the handler, else the controller; `undefined` = any member. */
export function requiredWorkspaceRoles(
  reflector: Reflector,
  context: ExecutionContext,
): WorkspaceRole[] | undefined {
  const roles = reflector.getAllAndOverride<WorkspaceRole[] | undefined>(
    WORKSPACE_ROLES_KEY,
    [context.getHandler(), context.getClass()],
  );
  return roles?.length ? roles : undefined;
}

/** 403 for a suspended workspace or a member role outside `allowed`. */
export function assertWorkspaceAllowed(
  membership: WorkspaceMembership,
  allowed: WorkspaceRole[] | undefined,
): void {
  if (membership.status !== 'ACTIVE') {
    throw new ForbiddenException('Workspace is suspended');
  }
  if (allowed && !allowed.includes(membership.role)) {
    throw new ForbiddenException('Insufficient workspace role');
  }
}
