import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  ADMIN_ID,
  fakeContext,
  fakeDb,
  fakeReflector,
  fakeRequest,
  fakeSession,
  USER_ID,
  WORKSPACE_A,
} from '../../../test/utils/guard-fakes.js';
import type { AuthSession } from '../auth-session.js';
import { findWorkspaceMembership } from '../authz-queries.js';
import { RolesGuard } from './roles.guard.js';

vi.mock('../authz-queries.js', () => ({ findWorkspaceMembership: vi.fn() }));
const membership = vi.mocked(findWorkspaceMembership);

describe('RolesGuard', () => {
  beforeEach(() => membership.mockReset());

  const run = (session: AuthSession | null, roles?: string[]) => {
    const request = fakeRequest(session);
    const guard = new RolesGuard(fakeDb, fakeReflector(roles));
    return { request, result: guard.canActivate(fakeContext(request)) };
  };

  it('is a no-op without @Roles (no session needed, no query)', async () => {
    await expect(run(null).result).resolves.toBe(true);
    expect(membership).not.toHaveBeenCalled();
  });

  it('401 without a session', async () => {
    await expect(run(null, ['owner']).result).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('checks the active workspace membership and attaches request.workspace', async () => {
    membership.mockResolvedValue({ role: 'owner', status: 'ACTIVE' });
    const { request, result } = run(fakeSession(), ['owner', 'admin']);
    await expect(result).resolves.toBe(true);
    expect(membership).toHaveBeenCalledWith(fakeDb, WORKSPACE_A, USER_ID);
    expect(request.workspace).toEqual({ id: WORKSPACE_A, role: 'owner' });
  });

  it('403 when the role is too low', async () => {
    membership.mockResolvedValue({ role: 'moderator', status: 'ACTIVE' });
    await expect(run(fakeSession(), ['owner', 'admin']).result).rejects.toThrow(
      new ForbiddenException('Insufficient workspace role'),
    );
  });

  it('403 when the active workspace is suspended', async () => {
    membership.mockResolvedValue({ role: 'owner', status: 'SUSPENDED' });
    await expect(run(fakeSession(), ['owner']).result).rejects.toThrow(
      new ForbiddenException('Workspace is suspended'),
    );
  });

  it('403 without an active workspace or membership', async () => {
    await expect(
      run(fakeSession({ activeOrganizationId: null }), ['owner']).result,
    ).rejects.toThrow(new ForbiddenException('No active workspace'));
    membership.mockResolvedValue(undefined);
    await expect(run(fakeSession(), ['owner']).result).rejects.toThrow(
      new ForbiddenException('No active workspace'),
    );
  });

  it('impersonated sessions are checked against their locked workspace', async () => {
    membership.mockResolvedValue({ role: 'owner', status: 'ACTIVE' });
    const session = fakeSession({
      impersonatedBy: ADMIN_ID,
      activeOrganizationId: WORKSPACE_A,
    });
    await expect(run(session, ['owner']).result).resolves.toBe(true);
    expect(membership).toHaveBeenCalledWith(fakeDb, WORKSPACE_A, USER_ID);
  });

  it('reuses request.workspace from WorkspaceAccessGuard without querying', async () => {
    const request = fakeRequest(fakeSession());
    request.workspace = { id: WORKSPACE_A, role: 'moderator' };
    const guard = new RolesGuard(fakeDb, fakeReflector(['owner', 'admin']));
    await expect(
      guard.canActivate(fakeContext(request)),
    ).rejects.toBeInstanceOf(ForbiddenException);
    request.workspace = { id: WORKSPACE_A, role: 'admin' };
    await expect(guard.canActivate(fakeContext(request))).resolves.toBe(true);
    expect(membership).not.toHaveBeenCalled();
  });
});
