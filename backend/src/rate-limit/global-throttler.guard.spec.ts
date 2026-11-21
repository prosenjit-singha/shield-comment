import { globalThrottleTracker } from './global-throttler.guard.js';

type Req = Parameters<typeof globalThrottleTracker>[0];

function req(session: unknown, ip?: string): Req {
  return {
    headers: ip === undefined ? {} : { 'x-forwarded-for': ip },
    session,
  } as Req;
}

describe('globalThrottleTracker', () => {
  it('signed in → the user id, whatever the IP', () => {
    expect(
      globalThrottleTracker(
        req({ user: { id: 'u1' }, session: {} }, '203.0.113.9'),
      ),
    ).toBe('user:u1');
  });

  it('impersonated session → the client user the session acts as', () => {
    expect(
      globalThrottleTracker(
        req(
          { user: { id: 'client-1' }, session: { impersonatedBy: 'admin-1' } },
          '203.0.113.9',
        ),
      ),
    ).toBe('user:client-1');
  });

  it('anonymous → the resolved client IP (the rewritten X-Forwarded-For)', () => {
    expect(globalThrottleTracker(req(null, '203.0.113.9'))).toBe(
      'ip:203.0.113.9',
    );
    expect(globalThrottleTracker(req(undefined, '2001:db8:1:2::'))).toBe(
      'ip:2001:db8:1:2::',
    );
  });

  it('anonymous without a resolved IP → one shared bucket', () => {
    expect(globalThrottleTracker(req(null))).toBe('ip:unknown');
  });
});
