import { spawnSync } from 'node:child_process';
import { Redis } from 'ioredis';
import pg from 'pg';
import { env, type RunIdentity } from './env.js';

/**
 * Seeding + cleanup against the running stack. Everything a run creates is found again from the run's
 * emails, so cleanup also works after a crashed run (same `E2E_RUN_ID`).
 */

async function withDb<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: env.databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function withRedis<T>(fn: (redis: Redis) => Promise<T>): Promise<T> {
  const redis = new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  await redis.connect();
  try {
    return await fn(redis);
  } finally {
    redis.disconnect();
  }
}

/** Super admin through the backend's own `create-super-admin` script (argon2id, no workspace). */
export function seedSuperAdminViaCompose(identity: RunIdentity): void {
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      // Names only: the values come from this process's env, so the password never shows up in `ps`.
      '-e',
      'SUPER_ADMIN_EMAIL',
      '-e',
      'SUPER_ADMIN_PASSWORD',
      '-e',
      'SUPER_ADMIN_NAME',
      'backend',
      'node',
      'dist/scripts/create-super-admin.js',
    ],
    {
      cwd: env.repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        SUPER_ADMIN_EMAIL: identity.superAdmin.email,
        SUPER_ADMIN_PASSWORD: env.superAdminPassword,
        SUPER_ADMIN_NAME: identity.superAdmin.name,
      },
    },
  );
  if (result.status !== 0) {
    const reason = result.error?.message ?? `${result.stdout}${result.stderr}`.trim();
    throw new Error(`create-super-admin via docker compose exec failed: ${reason}`);
  }
}

/** The workspace owner signs up like the client's /register (sign-up also creates the workspace). */
export async function signUpOwner(identity: RunIdentity): Promise<void> {
  const response = await fetch(`${env.apiUrl}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Better Auth answers 403 to an untrusted (or missing) Origin.
      origin: env.clientUrl,
      // Own rate-limit bucket per run (cleanupRun deletes it); without it the backend uses the socket address.
      'x-forwarded-for': identity.seedIp,
    },
    body: JSON.stringify({
      email: identity.owner.email,
      password: env.ownerPassword,
      name: identity.owner.name,
      workspaceName: identity.owner.workspaceName,
    }),
  });
  if (!response.ok) {
    throw new Error(`Owner sign-up failed: ${response.status} ${await response.text()}`);
  }
}

export async function userExists(email: string): Promise<boolean> {
  return withDb(async (db) => {
    const { rowCount } = await db.query('select 1 from users where email = $1', [email]);
    return (rowCount ?? 0) > 0;
  });
}

export async function impersonationAuditCount(identity: RunIdentity): Promise<number> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ count: string }>(
      `select count(*) from impersonation_audit_logs l
         join users u on u.id = l.admin_id
        where u.email = $1 and l.used_at is not null`,
      [identity.superAdmin.email],
    );
    return Number(rows[0]?.count ?? 0);
  });
}

export interface CleanupSummary {
  userIds: string[];
  users: number;
  workspaces: number;
  auditRows: number;
  redisKeys: number;
}

/**
 * Deletes the run's users and their workspaces (FK order: audit rows → moderation actions/policies
 * → webhook events/comments/stats → Meta rows → members/invitations → workspaces → sessions/accounts
 * → users), then their Better Auth Redis keys (`auth:<token>` + `auth:active-sessions-<userId>`,
 * plus any other `auth:*` value naming the user) and the seed IP's rate-limit keys
 * (`auth:<seedIp>|<path>`). Idempotent.
 */
export async function cleanupRun(identity: RunIdentity): Promise<CleanupSummary> {
  const emails = [identity.superAdmin.email, identity.owner.email];
  const { userIds, workspaces, auditRows } = await withDb(async (db) => {
    await db.query('begin');
    try {
      const users = await db.query<{ id: string }>('select id from users where email = any($1)', [emails]);
      const ids = users.rows.map((r) => r.id);
      const ws = await db.query<{ id: string }>(
        `select distinct workspace_id as id from workspace_members where user_id = any($1::uuid[])
         union select id from workspaces where name = $2`,
        [ids, identity.owner.workspaceName],
      );
      const wsIds = ws.rows.map((r) => r.id);
      const audit = await db.query(
        'delete from impersonation_audit_logs where admin_id = any($1::uuid[]) or target_workspace_id = any($2::uuid[])',
        [ids, wsIds],
      );
      const status = await db.query(
        'delete from workspace_status_audit_logs where admin_id = any($1::uuid[]) or workspace_id = any($2::uuid[])',
        [ids, wsIds],
      );
      const plan = await db.query('delete from plan_audit_logs where admin_id = any($1::uuid[])', [ids]);
      // Moderation (M5-T7): actions reference comments (restrict) → first; policies reference workspaces.
      await db.query('delete from moderation_actions where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from moderation_policies where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from webhook_events where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from comments where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from daily_comment_stats where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from social_pages where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from meta_connections where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query(
        'delete from workspace_invitations where workspace_id = any($1::uuid[]) or inviter_id = any($2::uuid[])',
        [wsIds, ids],
      );
      await db.query(
        'delete from workspace_members where workspace_id = any($1::uuid[]) or user_id = any($2::uuid[])',
        [wsIds, ids],
      );
      const deletedWs = await db.query('delete from workspaces where id = any($1::uuid[])', [wsIds]);
      await db.query('delete from sessions where user_id = any($1::uuid[])', [ids]);
      await db.query('delete from accounts where user_id = any($1::uuid[])', [ids]);
      await db.query('delete from verifications where identifier = any($1)', [emails]);
      await db.query('delete from users where id = any($1::uuid[])', [ids]);
      await db.query('commit');
      return {
        userIds: ids,
        workspaces: deletedWs.rowCount ?? 0,
        auditRows: (audit.rowCount ?? 0) + (status.rowCount ?? 0) + (plan.rowCount ?? 0),
      };
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });

  const redisKeys = await withRedis(async (redis) => {
    const userKeys = userIds.length ? await deleteAuthKeys(redis, userIds) : 0;
    return userKeys + (await deleteRateLimitKeys(redis, identity.seedIp));
  });
  return { userIds, users: userIds.length, workspaces, auditRows, redisKeys };
}

async function deleteAuthKeys(redis: Redis, userIds: string[]): Promise<number> {
  const doomed = new Set<string>();
  for (const userId of userIds) {
    const listKey = `auth:active-sessions-${userId}`;
    doomed.add(listKey);
    const raw = await redis.get(listKey);
    for (const token of sessionTokens(raw)) doomed.add(`auth:${token}`);
  }
  // Belt and braces: any other string value under auth:* that names one of the users.
  for (const key of await authKeysMentioning(redis, userIds)) doomed.add(key);
  const keys = [...doomed];
  return keys.length ? redis.del(...keys) : 0;
}

/** Better Auth rate-limit counters of one client IP (`auth:<ip>|<path>`, 60 s TTL). */
async function deleteRateLimitKeys(redis: Redis, ip: string): Promise<number> {
  const keys = await scanKeys(redis, `auth:${ip}|*`);
  return keys.length ? redis.del(...keys) : 0;
}

async function scanKeys(redis: Redis, pattern: string): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    found.push(...keys);
  } while (cursor !== '0');
  return found;
}

function sessionTokens(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry: unknown) =>
      typeof entry === 'object' && entry !== null && 'token' in entry && typeof entry.token === 'string'
        ? [entry.token]
        : [],
    );
  } catch {
    return [];
  }
}

export async function authKeysMentioning(redis: Redis, userIds: string[]): Promise<string[]> {
  const found: string[] = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'auth:*', 'COUNT', 500);
    cursor = next;
    for (const key of keys) {
      if (userIds.some((id) => key.includes(id))) {
        found.push(key);
        continue;
      }
      if ((await redis.type(key)) !== 'string') continue;
      const value = await redis.get(key);
      if (value && userIds.some((id) => value.includes(id))) found.push(key);
    }
  } while (cursor !== '0');
  return found;
}

/** After cleanup: nothing of the run may be left in Postgres or Redis. */
export async function assertRunGone(identity: RunIdentity, userIds: string[]): Promise<void> {
  const emails = [identity.superAdmin.email, identity.owner.email];
  const leftovers = await withDb(async (db) => {
    const { rows } = await db.query<{ users: string; workspaces: string }>(
      `select (select count(*) from users where email = any($1)) as users,
              (select count(*) from workspaces where name = $2) as workspaces`,
      [emails, identity.owner.workspaceName],
    );
    return rows[0];
  });
  const keys = await withRedis(async (redis) => [
    ...(userIds.length ? await authKeysMentioning(redis, userIds) : []),
    ...(await scanKeys(redis, `auth:${identity.seedIp}|*`)),
  ]);
  if (Number(leftovers?.users) || Number(leftovers?.workspaces) || keys.length) {
    throw new Error(
      `E2E cleanup left data behind: users=${leftovers?.users} workspaces=${leftovers?.workspaces} redisKeys=${keys.length}`,
    );
  }
}
