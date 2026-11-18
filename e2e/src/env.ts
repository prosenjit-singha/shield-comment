import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

/**
 * Suite settings. Defaults target `docker compose up --build` from the host: the browser opens the
 * compose apps at `admin.localhost` / `app.localhost` (the trusted Better Auth origins), seeding and
 * cleanup talk to the backend, Postgres and Redis on their published host ports. Host ports come
 * from the root `.env` (same keys compose reads), then from `E2E_*` overrides. Only those keys are
 * read from `.env`: secrets in it never reach the test process.
 * The compose `e2e` service (profile `e2e`) sets the `E2E_*` vars to container hostnames.
 */
const COMPOSE_KEYS = [
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST_PORT',
  'REDIS_HOST_PORT',
  'BACKEND_HOST_PORT',
  'ADMIN_HOST_PORT',
  'CLIENT_HOST_PORT',
] as const;
type ComposeKey = (typeof COMPOSE_KEYS)[number];

const rootEnvFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../.env');

function composeSettings(): Partial<Record<ComposeKey, string>> {
  const fromFile = existsSync(rootEnvFile) ? parseEnv(readFileSync(rootEnvFile, 'utf8')) : {};
  const out: Partial<Record<ComposeKey, string>> = {};
  for (const key of COMPOSE_KEYS) {
    const value = process.env[key] ?? fromFile[key];
    if (value) out[key] = value;
  }
  return out;
}

function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const compose = composeSettings();
const pgUser = compose.POSTGRES_USER ?? 'shield';
const pgPassword = compose.POSTGRES_PASSWORD ?? 'shield';
const pgDb = compose.POSTGRES_DB ?? 'shield_comment';

/** `compose-exec` = `docker compose exec backend node dist/scripts/create-super-admin.js` (host runs);
 *  `external` = already created before the run (the compose `e2e-seed` service). */
export type SuperAdminSeed = 'compose-exec' | 'external';

function superAdminSeed(): SuperAdminSeed {
  const value = optional('E2E_SUPER_ADMIN_SEED') ?? 'compose-exec';
  if (value !== 'compose-exec' && value !== 'external') {
    throw new Error(`E2E_SUPER_ADMIN_SEED must be compose-exec or external, got "${value}"`);
  }
  return value;
}

/** Lower-case letters, digits and dashes: it ends up in emails and workspace names. */
function runId(): string {
  const raw = optional('E2E_RUN_ID') ?? `${Date.now().toString(36)}${process.pid.toString(36)}`;
  const id = raw.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!id) throw new Error('E2E_RUN_ID must contain letters or digits');
  return id;
}

export const env = {
  adminUrl: optional('E2E_ADMIN_URL') ?? `http://admin.localhost:${compose.ADMIN_HOST_PORT ?? '5173'}`,
  clientUrl: optional('E2E_CLIENT_URL') ?? `http://app.localhost:${compose.CLIENT_HOST_PORT ?? '5174'}`,
  /** Backend origin for API seeding (sign-up). */
  apiUrl: optional('E2E_API_URL') ?? `http://localhost:${compose.BACKEND_HOST_PORT ?? '3000'}`,
  databaseUrl:
    optional('E2E_DATABASE_URL') ??
    `postgresql://${pgUser}:${pgPassword}@localhost:${compose.POSTGRES_HOST_PORT ?? '5432'}/${pgDb}`,
  redisUrl: optional('E2E_REDIS_URL') ?? `redis://localhost:${compose.REDIS_HOST_PORT ?? '6379'}`,
  /** Chromium `--host-resolver-rules`, e.g. `MAP admin.localhost admin, MAP app.localhost client` in Docker. */
  hostResolverRules: optional('E2E_HOST_RESOLVER_RULES'),
  /** Use an already installed Chromium instead of Playwright's download (see docs/progress/MEMORY.md). */
  chromiumPath: optional('E2E_CHROMIUM_PATH'),
  superAdminSeed: superAdminSeed(),
  /** Dev-only defaults: the stack under test is a local compose stack, never a shared one. */
  superAdminPassword: optional('E2E_SUPER_ADMIN_PASSWORD') ?? 'e2e-dev-only-Admin-123',
  ownerPassword: optional('E2E_OWNER_PASSWORD') ?? 'e2e-dev-only-Owner-123',
  /** Repo root, for `docker compose exec`. */
  repoRoot: resolve(dirname(rootEnvFile)),
} as const;

/** Emails + names for one run. The same `E2E_RUN_ID` gives the same emails (compose seed + suite). */
export function runIdentity(id: string = runId()) {
  return {
    runId: id,
    superAdmin: { email: `e2e-${id}-admin@shield.test`, name: 'E2E Super Admin' },
    owner: {
      email: `e2e-${id}-owner@shield.test`,
      name: 'E2E Owner',
      workspaceName: `E2E Shop ${id}`,
    },
  } as const;
}
export type RunIdentity = ReturnType<typeof runIdentity>;
