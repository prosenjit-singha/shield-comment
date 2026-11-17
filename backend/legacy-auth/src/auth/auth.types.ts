import type { UserRole } from '../generated/prisma/client.js';

/** Claims inside an access token. `sub` is the user id. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  typ: 'access';
  /** Set only on impersonation tokens: the super admin acting as this workspace. */
  impersonatedBy?: string;
  /** Set only on impersonation tokens: the single workspace the token may touch. */
  workspaceId?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  typ: 'refresh';
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** An Express request after `JwtAuthGuard` has verified the bearer token. */
export type AuthenticatedRequest = import('express').Request & {
  user: AccessTokenPayload;
  /** Set by `WorkspaceAccessGuard` on routes with a `:workspaceId` param. */
  workspace?: WorkspaceContext;
};

/** The workspace a request is scoped to, and the caller's role in it. */
export interface WorkspaceContext {
  id: string;
  role: import('../generated/prisma/client.js').WorkspaceMemberRole;
}
