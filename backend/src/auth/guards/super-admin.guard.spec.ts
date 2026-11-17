import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import {
  ADMIN_ID,
  fakeContext,
  fakeDb,
  fakeRequest,
  fakeSession,
  USER_ID,
} from '../../../test/utils/guard-fakes.js';
import type { AuthSession } from '../auth-session.js';
import { findPlatformUser } from '../authz-queries.js';
import { SuperAdminGuard } from './super-admin.guard.js';

vi.mock('../authz-queries.js', () => ({ findPlatformUser: vi.fn() }));
const platformUser = vi.mocked(findPlatformUser);

describe('SuperAdminGuard', () => {
  beforeEach(() => platformUser.mockReset());

  const run = (session: AuthSession | null) =>
    new SuperAdminGuard(fakeDb).canActivate(fakeContext(fakeRequest(session)));

  it('401 without a session', async () => {
    await expect(run(null)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('403 for a regular user, without querying', async () => {
    await expect(run(fakeSession({ role: 'user' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(platformUser).not.toHaveBeenCalled();
  });

  it('403 for an impersonated session, even with the super_admin role', async () => {
    const session = fakeSession({
      role: 'super_admin',
      impersonatedBy: ADMIN_ID,
    });
    await expect(run(session)).rejects.toBeInstanceOf(ForbiddenException);
    expect(platformUser).not.toHaveBeenCalled();
  });

  it('403 when Postgres no longer says super_admin (stale cookie cache)', async () => {
    platformUser.mockResolvedValue({ role: 'user', banned: false });
    await expect(
      run(fakeSession({ role: 'super_admin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(platformUser).toHaveBeenCalledWith(fakeDb, USER_ID);
  });

  it('403 for a banned or deleted super admin', async () => {
    platformUser.mockResolvedValue({ role: 'super_admin', banned: true });
    await expect(
      run(fakeSession({ role: 'super_admin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    platformUser.mockResolvedValue(undefined);
    await expect(
      run(fakeSession({ role: 'super_admin' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('passes a super admin', async () => {
    platformUser.mockResolvedValue({ role: 'super_admin', banned: false });
    await expect(run(fakeSession({ role: 'super_admin' }))).resolves.toBe(true);
  });
});
