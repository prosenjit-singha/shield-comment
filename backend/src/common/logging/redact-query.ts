/**
 * Query keys whose values must never reach logs or error bodies: the Meta OAuth callback carries a
 * one-time `code` and our `state` (M3-T4); token-ish names are covered defensively.
 */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set([
  'code',
  'state',
  'token',
  'access_token',
]);

const REDACTED = '[Redacted]';

/** `/api/meta/oauth/callback?code=abc&state=x` → `…?code=[Redacted]&state=[Redacted]`. */
export function redactUrlQuery(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let changed = false;
  for (const key of new Set(params.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
      params.set(key, REDACTED);
      changed = true;
    }
  }
  return changed ? `${url.slice(0, q)}?${params.toString()}` : url;
}

/** Copy of a parsed query object with sensitive values replaced (never mutates the request's). */
export function redactQueryObject(query: unknown): unknown {
  if (typeof query !== 'object' || query === null) return query;
  return Object.fromEntries(
    Object.entries(query).map(([key, value]) => [
      key,
      SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ? REDACTED : value,
    ]),
  );
}

/**
 * pino-http `req` serializer (runs on the already-serialized request): redacts `url` + `query`.
 */
export function redactRequestSerializer<
  T extends { url?: unknown; query?: unknown },
>(req: T): T {
  if (typeof req !== 'object' || req === null) return req;
  if (typeof req.url === 'string') req.url = redactUrlQuery(req.url);
  if ('query' in req) req.query = redactQueryObject(req.query);
  return req;
}
