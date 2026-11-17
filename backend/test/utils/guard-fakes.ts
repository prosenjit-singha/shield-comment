import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuthRequest, AuthSession } from '../../src/auth/auth-session.js';
import type { Database } from '../../src/db/database.js';

/** Fakes for the guard unit specs in src/auth/guards/. */

export const USER_ID = '01970000-0000-7000-8000-000000000001';
export const ADMIN_ID = '01970000-0000-7000-8000-000000000002';
export const WORKSPACE_A = '01970000-0000-7000-8000-00000000000a';
export const WORKSPACE_B = '01970000-0000-7000-8000-00000000000b';

export function fakeSession(
  overrides: {
    role?: string;
    activeOrganizationId?: string | null;
    impersonatedBy?: string | null;
  } = {},
): AuthSession {
  return {
    user: {
      id: USER_ID,
      email: 'u@test.shield.bd',
      name: 'U',
      role: overrides.role ?? 'user',
    },
    session: {
      id: 'session-id',
      userId: USER_ID,
      activeOrganizationId:
        'activeOrganizationId' in overrides
          ? overrides.activeOrganizationId
          : WORKSPACE_A,
      impersonatedBy: overrides.impersonatedBy ?? null,
    },
  } as unknown as AuthSession;
}

export function fakeRequest(
  session: AuthSession | null,
  params: Record<string, string> = {},
): AuthRequest {
  return { session, params } as unknown as AuthRequest;
}

export function fakeContext(request: AuthRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => fakeContext,
    getClass: () => Object,
  } as unknown as ExecutionContext;
}

export function fakeReflector(roles?: string[]): Reflector {
  return { getAllAndOverride: () => roles } as unknown as Reflector;
}

/** The guards only pass the db through to `authz-queries`, which the specs mock. */
export const fakeDb = {} as Database;
