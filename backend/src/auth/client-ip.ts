import type { IncomingMessage, ServerResponse } from 'node:http';
import { getIPFromHeader } from '@better-auth/core/utils/ip';

/**
 * Client IP for Better Auth (rate-limit keys `<ip>|<path>`, session `ipAddress`), M4-T10 / D11.
 *
 * Better Auth reads the IP only from this header (`advanced.ipAddress.ipAddressHeaders`). Proxied
 * traffic (admin nginx, client `proxyToApi`) sets it. A request without a usable value (direct
 * callers: the e2e seed, scripts, curl) would land in one shared `no-trusted-ip|<path>` bucket, so
 * the auth integration's `middleware` fills the header with the socket address first.
 *
 * Trust is not widened: a value Better Auth already accepts is left alone (a direct caller could
 * always pick its own bucket that way); only values it would reject are replaced, with the one
 * address the caller cannot choose.
 */
export const CLIENT_IP_HEADER = 'x-forwarded-for';

/** The IP Better Auth takes from this header value, or null (missing, empty, list, garbage). */
export function headerClientIp(
  value: string | string[] | undefined,
): string | null {
  if (typeof value !== 'string') return null;
  return getIPFromHeader(value);
}

/**
 * The socket's remote address in Better Auth's normalised form (IPv4-mapped IPv6 → IPv4, IPv6 → /64
 * prefix), or null when Node has none (closed socket) or it isn't an IP.
 */
export function socketClientIp(
  remoteAddress: string | undefined,
): string | null {
  if (!remoteAddress) return null;
  // Link-local IPv6 can carry a zone id (`fe80::1%eth0`) that Better Auth's validator rejects.
  const address = remoteAddress.split('%', 1)[0] ?? '';
  return getIPFromHeader(address);
}

/** Replaces an unusable `X-Forwarded-For` with the socket address. Returns the IP Better Auth will use. */
export function ensureClientIpHeader(req: IncomingMessage): string | null {
  const fromHeader = headerClientIp(req.headers[CLIENT_IP_HEADER]);
  if (fromHeader) return fromHeader;
  const fromSocket = socketClientIp(req.socket.remoteAddress);
  if (fromSocket) req.headers[CLIENT_IP_HEADER] = fromSocket;
  return fromSocket;
}

/** `AuthModule` `middleware` option: runs before the Better Auth handler, on `/api/auth/*` only. */
export function clientIpMiddleware(
  req: IncomingMessage,
  _res: ServerResponse,
  next: (error?: unknown) => void,
): void {
  ensureClientIpHeader(req);
  next();
}
