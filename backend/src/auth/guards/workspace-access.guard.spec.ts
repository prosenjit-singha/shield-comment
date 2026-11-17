import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { findWorkspaceMembership } from '../authz-queries.js';
import {
  ADMIN_ID,
  fakeContext,
  fakeDb,
  fakeReflector,
  fakeRequest,
  fakeSession,
  USER_ID,
  WORKSPACE_A,
  WORKSPACE_B,
} from '../../../test/utils/guard-fakes.js';
import { WorkspaceAccessGuard } from './workspace-access.guard.js';

vi.mock('../authz-queries.js', () => ({ findWorkspaceMembership: vi.fn() }));
const membership = vi.mocked(findWorkspaceMembership);

describe('WorkspaceAccessGuard', () => {
  beforeEach(() => membership.mockReset());

  const run = (
    session = fakeSession(),
    workspaceId: string = WORKSPACE_A,
    roles?: string[],
  ) => {
    const request = fakeRequest(session, { workspaceId });
    const guard = new WorkspaceAccessGuard(fakeDb, fakeReflector(roles));
    return { request, result: guard.canActivate(fakeContext(request)) };
  };

  it('401 without a session', async () => {
    await expect(run(null as never).result).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('404 for a malformed workspace id, without querying', async () => {
    await expect(
      run(fakeSession(), 'not-a-uuid').result,
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(membership).not.toHaveBeenCalled();
  });

  it('404 for a non-member (same answer as a missing workspace)', async () => {
    membership.mockResolvedValue(undefined);
    await expect(run().result).rejects.toBeInstanceOf(NotFoundException);
    expect(membership).toHaveBeenCalledWith(fakeDb, WORKSPACE_A, USER_ID);
  });

  it('403 for a suspended workspace', async () => {
    membership.mockResolvedValue({ role: 'owner', status: 'SUSPENDED' });
    await expect(run().result).rejects.toThrow(
      new ForbiddenException('Workspace is suspended'),
    );
  });

  it('403 when the member role is not in @Roles', async () => {
    membership.mockResolvedValue({ role: 'moderator', status: 'ACTIVE' });
    await expect(
      run(fakeSession(), WORKSPACE_A, ['owner', 'admin']).result,
    ).rejects.toThrow(new ForbiddenException('Insufficient workspace role'));
  });

  it('passes a member and attaches request.workspace', async () => {
    membership.mockResolvedValue({ role: 'admin', status: 'ACTIVE' });
    const { request, result } = run(fakeSession(), WORKSPACE_A.toUpperCase(), [
      'owner',
      'admin',
    ]);
    await expect(result).resolves.toBe(true);
    expect(request.workspace).toEqual({ id: WORKSPACE_A, role: 'admin' });
  });

  it('passes any member when the route has no @Roles', async () => {
    membership.mockResolvedValue({ role: 'moderator', status: 'ACTIVE' });
    await expect(run().result).resolves.toBe(true);
  });

  describe('impersonated session', () => {
    const impersonated = fakeSession({
      impersonatedBy: ADMIN_ID,
      activeOrganizationId: WORKSPACE_A,
    });

    it('reaches its own workspace', async () => {
      membership.mockResolvedValue({ role: 'owner', status: 'ACTIVE' });
      await expect(run(impersonated, WORKSPACE_A).result).resolves.toBe(true);
    });

    it('404 for any other workspace, even one the user belongs to', async () => {
      membership.mockResolvedValue({ role: 'owner', status: 'ACTIVE' });
      await expect(
        run(impersonated, WORKSPACE_B).result,
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(membership).not.toHaveBeenCalled();
    });

    it('404 everywhere when it has no active workspace', async () => {
      const unlocked = fakeSession({
        impersonatedBy: ADMIN_ID,
        activeOrganizationId: null,
      });
      await expect(run(unlocked, WORKSPACE_A).result).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
