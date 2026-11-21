import type { FullConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
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
  'E2E_BACKEND_HOST_PORT',
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

/** Module 6 gate backend (compose `backend-e2e`, Graph stub as Meta host): `compose-up` = global setup
 *  starts it with `docker compose up` and teardown removes it (host runs); `external` = already up. */
export type StubBackendStart = 'compose-up' | 'external';

function stubBackendStart(): StubBackendStart {
  const value = optional('E2E_STUB_BACKEND') ?? 'compose-up';
  if (value !== 'compose-up' && value !== 'external') {
    throw new Error(`E2E_STUB_BACKEND must be compose-up or external, got "${value}"`);
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
  stubBackend: stubBackendStart(),
  /** `backend-e2e` origin: the override call goes there (it reaches the Graph stub). */
  stubBackendUrl:
    optional('E2E_STUB_BACKEND_URL') ?? `http://localhost:${compose.E2E_BACKEND_HOST_PORT ?? '3001'}`,
  /** Graph stub port; `backend-e2e` reaches it at `META_GRAPH_BASE_URL` (docker-compose.yml). */
  graphStubPort: 4010,
  /** SSLCommerz stub port (Module 8 gate); `backend-e2e` reaches it at `SSLCOMMERZ_BASE_URL`. */
  sslcommerzStubPort: 4011,
  /** Same placeholder store as `backend-e2e` in docker-compose.yml (signs the IPN / return forms). */
  sslcommerzStore: { id: 'e2e_store', password: 'e2e-dev-only-store-pass' },
  /** Same dev-only key + id as `backend-e2e` in docker-compose.yml (encrypts the seeded Page token). */
  tokenKey: Buffer.from('e2e-dev-only-token-key-32-bytes!', 'utf8'),
  tokenKeyId: 'e2e',
  /** Dev-only defaults: the stack under test is a local compose stack, never a shared one. */
  superAdminPassword: optional('E2E_SUPER_ADMIN_PASSWORD') ?? 'e2e-dev-only-Admin-123',
  ownerPassword: optional('E2E_OWNER_PASSWORD') ?? 'e2e-dev-only-Owner-123',
  /** Repo root, for `docker compose exec`. */
  repoRoot: resolve(dirname(rootEnvFile)),
} as const;

/**
 * Per-run client IP the seed sends as `X-Forwarded-For` (backend M4-T10), so its sign-up gets its own
 * Better Auth rate-limit bucket (`auth:<ip>|<path>`) instead of sharing one with other direct callers.
 * Taken from 198.18.0.0/15 (RFC 2544 benchmarking, never routed); same run id → same IP.
 */
function seedClientIp(id: string): string {
  const [a = 0, b = 0, c = 0] = createHash('sha256').update(id).digest();
  return `198.${18 + (a & 1)}.${b}.${c}`;
}

/** Emails + names for one run. The same `E2E_RUN_ID` gives the same emails (compose seed + suite). */
export function runIdentity(id: string = runId()) {
  return {
    runId: id,
    seedIp: seedClientIp(id),
    superAdmin: { email: `e2e-${id}-admin@shield.test`, name: 'E2E Super Admin' },
    owner: {
      email: `e2e-${id}-owner@shield.test`,
      name: 'E2E Owner',
      workspaceName: `E2E Shop ${id}`,
    },
  } as const;
}
export type RunIdentity = ReturnType<typeof runIdentity>;

/**
 * Global setup/teardown seed and clean only for the compose suite (`chromium`) or `npm run smoke:local`
 * (`SMOKE_LOCAL_SEED=1`: throwaway owner + super admin handed to the `smoke` project as SMOKE_* env).
 * A plain `npm run smoke` touches neither Docker nor the database.
 */
export function seedsThisRun(config: FullConfig): boolean {
  return smokeLocalSeed() || config.filteredProjects.some((project) => project.name === 'chromium');
}

export function smokeLocalSeed(): boolean {
  return process.env.SMOKE_LOCAL_SEED === '1';
}
