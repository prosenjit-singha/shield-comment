import { requestIp } from './admin-impersonation.service.js';

const req = (headers: Record<string, string | string[]>, ip?: string) =>
  ({ headers, ip, socket: { remoteAddress: '10.0.0.9' } }) as never;

describe('requestIp', () => {
  it('takes the first X-Forwarded-For entry (set by the app proxies)', () => {
    expect(
      requestIp(
        req({ 'x-forwarded-for': '203.0.113.7, 172.18.0.4' }, '172.18.0.4'),
      ),
    ).toBe('203.0.113.7');
    expect(requestIp(req({ 'x-forwarded-for': ['2001:db8::1'] }))).toBe(
      '2001:db8::1',
    );
  });

  it('falls back to req.ip, then the socket, and drops non-IP values', () => {
    expect(
      requestIp(
        req({ 'x-forwarded-for': 'not-an-ip<script>' }, '::ffff:127.0.0.1'),
      ),
    ).toBe('::ffff:127.0.0.1');
    expect(requestIp(req({}))).toBe('10.0.0.9');
    expect(
      requestIp({ headers: {}, ip: undefined, socket: {} } as never),
    ).toBeNull();
  });
});
