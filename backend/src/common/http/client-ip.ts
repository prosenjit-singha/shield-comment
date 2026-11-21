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
 * Compose 1 (admin nginx / client Start proxy append).
 *
 * Fly.io (M9-T14a): the edge adds more than one `X-Forwarded-For` entry (hops 1 = a Fly edge address),
 * but it always sets `Fly-Client-IP` to the visitor, overwriting a client-sent one. With
 * `TRUST_FLY_CLIENT_IP=true` (Fly only; off in compose, where anyone could send it) that header wins;
 * missing or not one IP → the `TRUST_PROXY_HOPS` rule. The app proxies forward it unchanged, and over
 * the private network only our own apps can reach the backend (deploy.md §2).
 */
export const CLIENT_IP_HEADER = 'x-forwarded-for';
export const FLY_CLIENT_IP_HEADER = 'fly-client-ip';

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
export function clientIpMiddleware(hops: number, trustFlyClientIp = false) {
  return (
    req: IncomingMessage,
    _res: ServerResponse,
    next: (error?: unknown) => void,
  ): void => {
    const fly = req.headers[FLY_CLIENT_IP_HEADER];
    const ip =
      (trustFlyClientIp && typeof fly === 'string' ? normaliseIp(fly) : null) ??
      resolveClientIp(
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
