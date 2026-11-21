import type { IncomingMessage, ServerResponse } from 'node:http';
import { isValidIP, normalizeIP } from '@better-auth/core/utils/ip';

/**
 * The one client IP of a request (M9-T1, Module 9 D2), the key of every per-IP limit: Better Auth's
 * rate limiter + session `ipAddress`, `req.ip` (Meta callbacks throttler), the SSLCommerz callbacks
 * throttler and audit `requestIp()`.
 *
 * `TRUST_PROXY_HOPS` = proxies in front of the backend that append to `X-Forwarded-For`. From
 * `[...X-Forwarded-For entries, socket address]` the entry `hops` places from the right is the
 * client; everything left of it is client-chosen and ignored. 0 = socket only (nothing in front).
 * Count the proxies on the **app path** (browser → host load balancer → app proxy → backend):
 * compose 1 (admin nginx / client Start proxy), Fly.io 2 (Fly edge + app proxy). Traffic that
 * skips the app proxy (`api.<domain>`: Meta, Telegram) has one hop fewer, so its left neighbour is
 * read: such routes must not rely on the IP for security (see TASKS.md M9-T1 notes).
 */
export const CLIENT_IP_HEADER = 'x-forwarded-for';

/**
 * Better Auth's form (IPv4-mapped → IPv4, IPv6 → /64 prefix, lower case), or null for anything that
 * isn't one IP. A link-local zone id (`fe80::1%eth0`) is dropped first.
 */
export function normaliseIp(value: string | undefined): string | null {
  const ip = value?.trim().split('%', 1)[0];
  return ip && isValidIP(ip) ? normalizeIP(ip) : null;
}

/**
 * The client IP for `hops` trusted proxies; the socket address when the chosen entry is missing (a
 * shorter chain than configured) or isn't an IP; null only when the socket has no IP either.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  socketAddress: string | undefined,
  hops: number,
): string | null {
  const socket = normaliseIp(socketAddress);
  const forwarded = (
    Array.isArray(forwardedFor) ? forwardedFor.join(',') : (forwardedFor ?? '')
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (hops <= 0) return socket;
  return normaliseIp(forwarded[forwarded.length - hops]) ?? socket;
}

/**
 * First middleware of the app (`configureApp()`): replaces `X-Forwarded-For` with the resolved IP
 * (or removes it), so nothing downstream ever sees a client-chosen value. With Express
 * `trust proxy` = 1, `req.ip` is that same IP.
 */
export function clientIpMiddleware(hops: number) {
  return (
    req: IncomingMessage,
    _res: ServerResponse,
    next: (error?: unknown) => void,
  ): void => {
    const ip = resolveClientIp(
      req.headers[CLIENT_IP_HEADER],
      req.socket.remoteAddress,
      hops,
    );
    if (ip) req.headers[CLIENT_IP_HEADER] = ip;
    else delete req.headers[CLIENT_IP_HEADER];
    next();
  };
}

/** The resolved client IP of a request that went through `clientIpMiddleware`. */
export function clientIp(req: Pick<IncomingMessage, 'headers'>): string | null {
  const value = req.headers[CLIENT_IP_HEADER];
  return typeof value === 'string' ? value : null;
}
