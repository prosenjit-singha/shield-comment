import { parseSuperAdminInput } from './super-admin.js';

describe('parseSuperAdminInput', () => {
  it('reads env vars, normalises the email and defaults the name', () => {
    expect(
      parseSuperAdminInput([], {
        SUPER_ADMIN_EMAIL: '  Admin@Shield.BD ',
        SUPER_ADMIN_PASSWORD: 'long-enough-pw',
      }),
    ).toEqual({
      email: 'admin@shield.bd',
      password: 'long-enough-pw',
      name: 'Super Admin',
    });
  });

  it('args win over env vars', () => {
    expect(
      parseSuperAdminInput(
        ['--email=a@b.co', '--name', 'Rahim', '--password=another-pw'],
        {
          SUPER_ADMIN_EMAIL: 'env@b.co',
          SUPER_ADMIN_PASSWORD: 'env-password',
          SUPER_ADMIN_NAME: 'Env',
        },
      ),
    ).toEqual({ email: 'a@b.co', password: 'another-pw', name: 'Rahim' });
  });

  it('the password is optional (promote only)', () => {
    expect(
      parseSuperAdminInput(['--email=a@b.co'], {}).password,
    ).toBeUndefined();
  });

  it('rejects a missing/invalid email, a short password and unknown args', () => {
    expect(() => parseSuperAdminInput([], {})).toThrow(/SUPER_ADMIN_EMAIL/);
    expect(() => parseSuperAdminInput(['--email=nope'], {})).toThrow(
      /valid email/,
    );
    expect(() =>
      parseSuperAdminInput(['--email=a@b.co', '--password=short'], {}),
    ).toThrow(/at least 8/);
    expect(() =>
      parseSuperAdminInput(['--email=a@b.co', '--role=x'], {}),
    ).toThrow();
  });
});
