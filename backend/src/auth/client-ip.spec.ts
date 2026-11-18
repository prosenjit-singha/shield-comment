import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { getIPFromHeader } from '@better-auth/core/utils/ip';
import {
  CLIENT_IP_HEADER,
  clientIpMiddleware,
  ensureClientIpHeader,
  headerClientIp,
  socketClientIp,
} from './client-ip.js';

function fakeRequest(
  headers: IncomingMessage['headers'],
  remoteAddress: string | undefined,
): IncomingMessage {
  return {
    headers,
    socket: { remoteAddress } as Socket,
  } as IncomingMessage;
}

/**
 * What Better Auth's rate limiter keys on, without its dev/test localhost fallback (`getIP` returns
 * 127.0.0.1 under NODE_ENV=test, which would hide a `no-trusted-ip` bucket in this suite).
 */
function betterAuthIp(req: IncomingMessage): string | null {
  const value = req.headers[CLIENT_IP_HEADER];
  return typeof value === 'string' ? getIPFromHeader(value) : null;
}

describe('headerClientIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    [' 203.0.113.7 ', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', '2001:0db8:0001:0002:0000:0000:0000:0000'],
  ])('accepts %j as %s', (value, ip) => {
    expect(headerClientIp(value)).toBe(ip);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['garbage', 'not-an-ip'],
    ['a list (spoofable without trusted proxies)', '198.51.100.1, 203.0.113.7'],
    ['an array', ['203.0.113.7']],
    ['a zone id', 'fe80::1%eth0'],
  ])('rejects %s', (_name, value) => {
    expect(headerClientIp(value)).toBeNull();
  });
});

describe('socketClientIp', () => {
  it.each([
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:172.18.0.1', '172.18.0.1'],
    ['::1', '0000:0000:0000:0000:0000:0000:0000:0000'],
    ['fe80::1%eth0', 'fe80:0000:0000:0000:0000:0000:0000:0000'],
    ['2001:DB8::1', '2001:0db8:0000:0000:0000:0000:0000:0000'],
  ])('normalises %s to %s', (address, ip) => {
    expect(socketClientIp(address)).toBe(ip);
  });

  it.each([undefined, '', 'unix-socket'])('gives null for %j', (address) => {
    expect(socketClientIp(address)).toBeNull();
  });
});

describe('ensureClientIpHeader', () => {
  it('keeps a usable header IP (proxied traffic) and ignores the socket', () => {
    const req = fakeRequest(
      { [CLIENT_IP_HEADER]: '203.0.113.7' },
      '::ffff:172.18.0.5',
    );

    expect(ensureClientIpHeader(req)).toBe('203.0.113.7');
    expect(req.headers[CLIENT_IP_HEADER]).toBe('203.0.113.7');
    expect(betterAuthIp(req)).toBe('203.0.113.7');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['garbage', 'unknown'],
    ['a list', '198.51.100.1, 203.0.113.7'],
  ])('uses the socket address when the header is %s', (_name, value) => {
    const headers: IncomingMessage['headers'] =
      value === undefined ? {} : { [CLIENT_IP_HEADER]: value };
    const req = fakeRequest(headers, '::ffff:172.18.0.1');

    expect(ensureClientIpHeader(req)).toBe('172.18.0.1');
    expect(req.headers[CLIENT_IP_HEADER]).toBe('172.18.0.1');
    expect(betterAuthIp(req)).toBe('172.18.0.1');
  });

  it('writes the IPv6 socket address in the form Better Auth keys on', () => {
    const req = fakeRequest({}, '2001:db8::42');

    ensureClientIpHeader(req);

    expect(betterAuthIp(req)).toBe('2001:0db8:0000:0000:0000:0000:0000:0000');
  });

  it('leaves the request alone when neither header nor socket gives an IP', () => {
    const req = fakeRequest({ [CLIENT_IP_HEADER]: 'garbage' }, undefined);

    expect(ensureClientIpHeader(req)).toBeNull();
    expect(req.headers[CLIENT_IP_HEADER]).toBe('garbage');
  });

  it.each([
    [undefined, '127.0.0.1'],
    ['', '::1'],
    ['nope', '::ffff:10.0.0.9'],
    ['10.0.0.1,10.0.0.2', '192.0.2.1'],
  ])(
    'never leaves Better Auth without an IP (header %j, socket %s)',
    (value, socket) => {
      const headers: IncomingMessage['headers'] =
        value === undefined ? {} : { [CLIENT_IP_HEADER]: value };
      const req = fakeRequest(headers, socket);

      ensureClientIpHeader(req);

      expect(betterAuthIp(req)).not.toBeNull();
    },
  );
});

describe('clientIpMiddleware', () => {
  it('fills the header, then calls next once without an error', () => {
    const req = fakeRequest({}, '198.51.100.20');
    const next = vi.fn<(error?: unknown) => void>();

    clientIpMiddleware(req, {} as ServerResponse, next);

    expect(req.headers[CLIENT_IP_HEADER]).toBe('198.51.100.20');
    expect(next).toHaveBeenCalledExactlyOnceWith();
  });
});
