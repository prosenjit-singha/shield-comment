/**
 * Neon endpoint per branch of project `calm-thunder-04124611` (MEMORY "Neon"). The only place these
 * ids live: the staging/production npm scripts set `NEON_BRANCH` and preload
 * `dist/scripts/neon-branch-guard.js`, which refuses a database URL of another branch.
 */
export const NEON_ENDPOINTS = {
  staging: 'ep-morning-meadow-a17o9g0x',
  production: 'ep-bold-dawn-a1xh3drl',
} as const;

export type NeonBranch = keyof typeof NEON_ENDPOINTS;

/** `ep-…` id of a Neon URL (`-pooler` dropped), or undefined for any other URL. */
export function neonEndpointId(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  if (!host.endsWith('.neon.tech')) return undefined;
  return /^(ep-[a-z0-9-]+?)(?:-pooler)?$/.exec(host.split('.')[0])?.[1];
}

/**
 * Null when `DATABASE_URL` (required) and `DIRECT_URL` (if set) point at the endpoint of
 * `NEON_BRANCH`, else the reason to refuse. Never echoes a URL (it holds the password).
 */
export function checkNeonBranch(
  env: Record<string, string | undefined>,
): string | null {
  const branch = env.NEON_BRANCH;
  if (branch !== 'staging' && branch !== 'production') {
    return `NEON_BRANCH must be staging or production (got ${branch ? `"${branch}"` : 'nothing'})`;
  }
  const expected = NEON_ENDPOINTS[branch];
  for (const key of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const url = env[key]?.trim();
    if (!url) {
      if (key === 'DATABASE_URL') return 'DATABASE_URL is not set';
      continue;
    }
    const found = neonEndpointId(url);
    if (found !== expected) {
      return `${key} points at ${found ?? 'a non-Neon host'}, not the ${branch} endpoint ${expected} (check .env.${branch} and that .env.local does not override it)`;
    }
  }
  return null;
}
