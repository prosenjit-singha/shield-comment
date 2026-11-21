import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { getIPFromHeader } from '@better-auth/core/utils/ip';
import {
  CLIENT_IP_HEADER,
  clientIp,
  clientIpMiddleware,
  FLY_CLIENT_IP_HEADER,
  normaliseIp,
  resolveClientIp,
} from './client-ip.js';

const V6_64 = '2001:0db8:0001:0002:0000:0000:0000:0000';

describe('normaliseIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', V6_64],
    ['2001:DB8:1:2::9', V6_64],
    ['fe80::1%eth0', 'fe80:0000:0000:0000:0000:0000:0000:0000'],
  ])('normalises %j to %s', (value, ip) => {
    expect(normaliseIp(value)).toBe(ip);
  });

  it.each([undefined, '', ' ', 'unknown', '1.2.3.4, 5.6.7.8', '999.1.1.1'])(
    'gives null for %j',
    (value) => {
      expect(normaliseIp(value)).toBeNull();
    },
  );
});

describe('resolveClientIp', () => {
  const SOCKET = '::ffff:10.0.0.9';

  it('hops 0 = the socket address; X-Forwarded-For is ignored', () => {
    expect(resolveClientIp('203.0.113.7', SOCKET, 0)).toBe('10.0.0.9');
    expect(resolveClientIp(undefined, SOCKET, 0)).toBe('10.0.0.9');
  });

  it('hops 1 = the last X-Forwarded-For entry (the one the trusted proxy added)', () => {
    expect(resolveClientIp('203.0.113.7', SOCKET, 1)).toBe('203.0.113.7');
    expect(resolveClientIp('198.51.100.1, 203.0.113.7', SOCKET, 1)).toBe(
      '203.0.113.7',
    );
  });

  it('hops 2 = the second-to-last entry (load balancer + app proxy)', () => {
    expect(resolveClientIp('203.0.113.7, 172.16.0.2', SOCKET, 2)).toBe(
      '203.0.113.7',
    );
  });

  it('ignores spoofed entries left of the trusted hops', () => {
    const spoofed = '1.1.1.1, 2.2.2.2, 203.0.113.7, 172.16.0.2';
    expect(resolveClientIp(spoofed, SOCKET, 2)).toBe('203.0.113.7');
    expect(resolveClientIp(spoofed, SOCKET, 1)).toBe('172.16.0.2');
  });

  it('joins repeated headers in order', () => {
    expect(resolveClientIp(['1.1.1.1', '203.0.113.7'], SOCKET, 1)).toBe(
      '203.0.113.7',
    );
  });

  it.each([
    ['missing', undefined, 1],
    ['empty', '', 1],
    ['garbage at the trusted position', '203.0.113.7, unknown', 1],
    ['shorter than the trusted hops', '203.0.113.7', 2],
  ])('falls back to the socket when the header is %s', (_n, xff, hops) => {
    expect(resolveClientIp(xff, SOCKET, hops)).toBe('10.0.0.9');
  });

  it('normalises like Better Auth (IPv6 → /64, mapped IPv4 → IPv4)', () => {
    expect(resolveClientIp('2001:db8:1:2:aaaa::1', SOCKET, 1)).toBe(V6_64);
    expect(resolveClientIp('::ffff:203.0.113.7', SOCKET, 1)).toBe(
      '203.0.113.7',
    );
    expect(resolveClientIp(undefined, '2001:db8:1:2::42', 0)).toBe(V6_64);
  });

  it('gives null when neither the entry nor the socket is an IP', () => {
    expect(resolveClientIp('garbage', undefined, 1)).toBeNull();
    expect(resolveClientIp(undefined, 'unix-socket', 0)).toBeNull();
  });
});

describe('clientIpMiddleware', () => {
  function run(
    headers: IncomingMessage['headers'],
    remoteAddress: string | undefined,
    hops: number,
    trustFlyClientIp = false,
  ) {
    const req = {
      headers,
      socket: { remoteAddress } as Socket,
    } as IncomingMessage;
    const next = vi.fn<(error?: unknown) => void>();
    clientIpMiddleware(hops, trustFlyClientIp)(req, {} as ServerResponse, next);
    expect(next).toHaveBeenCalledExactlyOnceWith();
    return req;
  }

  it('always overwrites X-Forwarded-For with the resolved IP (no client-chosen pass-through)', () => {
    const req = run({ [CLIENT_IP_HEADER]: '203.0.113.7' }, '::1', 0);

    expect(req.headers[CLIENT_IP_HEADER]).toBe(
      '0000:0000:0000:0000:0000:0000:0000:0000',
    );
    expect(clientIp(req)).toBe(req.headers[CLIENT_IP_HEADER]);
  });

  it('writes one IP Better Auth accepts as is', () => {
    const req = run(
      { [CLIENT_IP_HEADER]: '1.1.1.1, 2001:db8:1:2::5' },
      '172.18.0.4',
      1,
    );

    expect(req.headers[CLIENT_IP_HEADER]).toBe(V6_64);
    expect(getIPFromHeader(V6_64)).toBe(V6_64);
  });

  it('removes the header when no IP can be resolved', () => {
    const req = run({ [CLIENT_IP_HEADER]: 'garbage' }, undefined, 1);

    expect(req.headers[CLIENT_IP_HEADER]).toBeUndefined();
    expect(clientIp(req)).toBeNull();
  });

  describe('TRUST_FLY_CLIENT_IP (M9-T14a)', () => {
    // What the Fly edge sends: its own address last in X-Forwarded-For, the visitor in Fly-Client-IP.
    const EDGE_XFF = '203.0.113.7, 66.241.125.10';

    it('switch on + valid Fly-Client-IP → that IP, whatever X-Forwarded-For says', () => {
      const req = run(
        {
          [FLY_CLIENT_IP_HEADER]: '198.51.100.20',
          [CLIENT_IP_HEADER]: EDGE_XFF,
        },
        'fdaa::3',
        1,
        true,
      );

      expect(clientIp(req)).toBe('198.51.100.20');
    });

    it('switch on + IPv6 Fly-Client-IP → its /64, like Better Auth', () => {
      const req = run(
        {
          [FLY_CLIENT_IP_HEADER]: ' 2001:db8:1:2::5 ',
          [CLIENT_IP_HEADER]: EDGE_XFF,
        },
        'fdaa::3',
        1,
        true,
      );

      expect(clientIp(req)).toBe(V6_64);
    });

    it.each([
      ['missing', undefined],
      ['empty', ''],
      ['not an IP', 'unknown'],
      ['a list (repeated header)', '198.51.100.20, 198.51.100.21'],
      ['an array', ['198.51.100.20']],
    ])(
      'switch on + Fly-Client-IP %s → the TRUST_PROXY_HOPS rule',
      (_name, fly) => {
        const req = run(
          { [FLY_CLIENT_IP_HEADER]: fly, [CLIENT_IP_HEADER]: EDGE_XFF },
          'fdaa::3',
          1,
          true,
        );

        expect(clientIp(req)).toBe('66.241.125.10');
      },
    );

    it('switch off (default, compose/Docker) → a client-sent Fly-Client-IP is ignored', () => {
      const req = run(
        {
          [FLY_CLIENT_IP_HEADER]: '198.51.100.20',
          [CLIENT_IP_HEADER]: '1.2.3.4',
        },
        '172.18.0.4',
        1,
      );

      expect(clientIp(req)).toBe('1.2.3.4');
    });
  });
});
