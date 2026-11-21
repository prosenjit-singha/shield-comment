/**
 * Settings for the read-only `smoke` project (M9-T11, D6 a): base URLs + fixed accounts from env only.
 * Nothing here talks to Docker, Postgres or Redis, so it runs against any deployed stack (staging).
 *
 *   SMOKE_CLIENT_URL, SMOKE_ADMIN_URL, SMOKE_API_URL         origins, e.g. https://shield-comment-app-staging.fly.dev
 *   SMOKE_STAGING_HOSTS                                      comma-separated exact hostnames that count as staging
 *                                                            (Fly staging hosts have no `staging` label), e.g.
 *                                                            shield-comment-app-staging.fly.dev,shield-comment-admin-staging.fly.dev,shield-comment-api-staging.fly.dev
 *   SMOKE_OWNER_EMAIL / SMOKE_OWNER_PASSWORD                 client test owner (verified email)
 *   SMOKE_ADMIN_EMAIL / SMOKE_ADMIN_PASSWORD                 super admin
 *   SMOKE_ALLOW_PRODUCTION=1                                 production URLs: public checks only, no sign-in
 */
export type SmokeMode = 'full' | 'public';
export type Credentials = { readonly email: string; readonly password: string };

/** `SMOKE_STAGING_HOSTS` → lower-case exact hostnames (trimmed, empty entries ignored). */
export function stagingHosts(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Hosts the suite may sign in on: one `staging` label (app.staging.<domain>), `localhost`, `*.localhost`,
 * or an exact entry of `SMOKE_STAGING_HOSTS` (no suffix match).
 */
export function isNonProductionHost(hostname: string, allowList: ReadonlySet<string> = new Set()): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || host.split('.').includes('staging') || allowList.has(host)
  );
}

/** `full` = every check; `public` = production with the override (no sign-in); else refuses to run. */
export function smokeMode(
  urls: readonly URL[],
  allowProduction: boolean,
  allowList: ReadonlySet<string> = new Set(),
): SmokeMode {
  const production = urls.filter((url) => !isNonProductionHost(url.hostname, allowList)).map((url) => url.host);
  if (production.length === 0) return 'full';
  if (allowProduction) return 'public';
  throw new Error(
    `Refusing to run the smoke suite against production (${production.join(', ')}). ` +
      'Set SMOKE_ALLOW_PRODUCTION=1 to run the public read-only checks only.',
  );
}

function origin(source: NodeJS.ProcessEnv, name: string): URL {
  const raw = source[name]?.trim();
  if (!raw) throw new Error(`${name} is not set (an origin such as https://shield-comment-app-staging.fly.dev)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${name} must be http(s)`);
  return new URL(url.origin);
}

/** Never echoes the value: credentials stay out of logs, titles and reports. */
function credentials(source: NodeJS.ProcessEnv, prefix: string): Credentials {
  const email = source[`${prefix}_EMAIL`]?.trim();
  const password = source[`${prefix}_PASSWORD`];
  if (!email || !password) throw new Error(`${prefix}_EMAIL and ${prefix}_PASSWORD must be set`);
  return { email, password };
}

export function smokeSettings(source: NodeJS.ProcessEnv = process.env) {
  const client = origin(source, 'SMOKE_CLIENT_URL');
  const admin = origin(source, 'SMOKE_ADMIN_URL');
  const api = origin(source, 'SMOKE_API_URL');
  const mode = smokeMode(
    [client, admin, api],
    source.SMOKE_ALLOW_PRODUCTION === '1',
    stagingHosts(source.SMOKE_STAGING_HOSTS),
  );
  return {
    mode,
    /** Origins without a trailing slash. */
    clientUrl: client.origin,
    adminUrl: admin.origin,
    apiUrl: api.origin,
    owner: mode === 'full' ? credentials(source, 'SMOKE_OWNER') : null,
    superAdmin: mode === 'full' ? credentials(source, 'SMOKE_ADMIN') : null,
  } as const;
}
export type SmokeSettings = ReturnType<typeof smokeSettings>;
