import { spawnSync } from 'node:child_process';
import { createCipheriv, randomBytes, randomInt } from 'node:crypto';
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

/** Module 6 gate: `backend-e2e` from the already built backend image (host runs; see docker-compose.yml). */
export function startStubBackend(): void {
  compose(['--profile', 'e2e', 'up', '-d', '--no-deps', '--wait', 'backend-e2e'], 180_000);
}

/** Stops + removes `backend-e2e` (a second API process must not outlive the run). */
export function removeStubBackend(): void {
  compose(['--profile', 'e2e', 'rm', '-sf', 'backend-e2e'], 60_000);
}

function compose(args: string[], timeout: number): void {
  const result = spawnSync('docker', ['compose', ...args], { cwd: env.repoRoot, encoding: 'utf8', timeout });
  if (result.status !== 0) {
    const reason = result.error?.message ?? `${result.stdout}${result.stderr}`.trim();
    throw new Error(`docker compose ${args.join(' ')} failed: ${reason}`);
  }
}

/** The backend's token format (`TokenCipherService`): `v1:<keyId>:<iv>:<tag>:<ciphertext>`, AAD `v1:<keyId>:<context>`. */
function encryptToken(plaintext: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', env.tokenKey, iv);
  cipher.setAAD(Buffer.from(`v1:${env.tokenKeyId}:${context}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const parts = [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64url'));
  return ['v1', env.tokenKeyId, ...parts].join(':');
}

export interface ModerationFixture {
  workspaceId: string;
  /** `comments.id` (UUID) and the Graph comment id of the seeded HIDDEN comment. */
  commentId: string;
  graphCommentId: string;
  message: string;
  pageToken: string;
}

/** Seeded `daily_comment_stats` (two Dhaka days in the last 30) → dashboard KPIs (M6-T5 formulas). */
export const SEEDED_STATS = [
  { daysAgo: 1, classified: 40, ruleMatched: 2, safe: 30, competitor: 2, scam: 5, spam: 3, abusive: 0, hidden: 6, deleted: 1 },
  { daysAgo: 3, classified: 20, ruleMatched: 0, safe: 15, competitor: 0, scam: 3, spam: 1, abusive: 1, hidden: 3, deleted: 0 },
] as const;

/**
 * The owner's workspace gets an active Meta connection + Facebook Page (tokens encrypted with the
 * `backend-e2e` key), the stats above and one HIDDEN comment. `cleanupRun` deletes all of it
 * (workspace-scoped rows).
 */
export async function seedModerationFixture(identity: RunIdentity): Promise<ModerationFixture> {
  // Page ids are globally unique: 15 random digits.
  const pageId = `9${randomInt(10 ** 13, 10 ** 14)}`;
  const graphCommentId = `${pageId}_${randomInt(10 ** 9, 10 ** 10)}`;
  const message = `E2E gate comment ${identity.runId}`;
  const pageToken = `e2e-page-token-${randomBytes(8).toString('hex')}`;
  return withDb(async (db) => {
    await db.query('begin');
    try {
      const ws = await db.query<{ id: string }>(
        `select m.workspace_id as id from workspace_members m join users u on u.id = m.user_id
          where u.email = $1 and m.role = 'owner'`,
        [identity.owner.email],
      );
      const workspaceId = ws.rows[0]?.id;
      if (!workspaceId || ws.rows.length !== 1) throw new Error('Expected exactly one owner workspace');
      const fbUserId = String(randomInt(10 ** 9, 10 ** 10));
      await db.query(
        `insert into meta_connections (id, workspace_id, facebook_user_id, encrypted_user_access_token, status)
         values (gen_random_uuid(), $1, $2, $3, 'ACTIVE')`,
        [workspaceId, fbUserId, encryptToken('e2e-user-token', `meta_user_token:${workspaceId}:${fbUserId}`)],
      );
      const page = await db.query<{ id: string }>(
        `insert into social_pages (id, workspace_id, page_id, page_name, encrypted_page_access_token, is_active)
         values (gen_random_uuid(), $1, $2, 'E2E Gate Page', $3, true) returning id`,
        [workspaceId, pageId, encryptToken(pageToken, `meta_page_token:${workspaceId}:${pageId}`)],
      );
      for (const s of SEEDED_STATS) {
        await db.query(
          `insert into daily_comment_stats (id, workspace_id, page_id, platform, day, received_count,
             classified_count, rule_matched_count, safe_inquiry_count, competitor_poach_count,
             scam_phishing_count, spam_irrelevant_count, abusive_toxic_count, hidden_count, deleted_count)
           values (gen_random_uuid(), $1, $2, 'FACEBOOK', (now() at time zone 'Asia/Dhaka')::date - $3::int,
             $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [workspaceId, pageId, s.daysAgo, s.classified + s.ruleMatched, s.classified, s.ruleMatched,
            s.safe, s.competitor, s.scam, s.spam, s.abusive, s.hidden, s.deleted],
        );
      }
      const comment = await db.query<{ id: string }>(
        `insert into comments (id, comment_id, workspace_id, social_page_id, platform, post_id, author_name,
           message, status, status_reason)
         values (gen_random_uuid(), $1, $2, $3, 'FACEBOOK', $4, 'E2E Buyer', $5, 'HIDDEN', 'rule_keyword')
         returning id`,
        [graphCommentId, workspaceId, page.rows[0]?.id, `${pageId}_1`, message],
      );
      await db.query('commit');
      const commentId = comment.rows[0]?.id;
      if (!commentId) throw new Error('Comment insert returned no row');
      return { workspaceId, commentId, graphCommentId, message, pageToken };
    } catch (error) {
      await db.query('rollback');
      throw error;
    }
  });
}

/** The comment's status + its USER actions (newest first). */
export async function commentState(workspaceId: string, commentId: string) {
  return withDb(async (db) => {
    const comment = await db.query<{ status: string; overridden: boolean }>(
      'select status, overridden_at is not null as overridden from comments where workspace_id = $1 and id = $2',
      [workspaceId, commentId],
    );
    const actions = await db.query<{ action: string; source: string; state: string; user_email: string }>(
      `select a.action, a.source, a.state, u.email as user_email from moderation_actions a
         left join users u on u.id = a.user_id
        where a.workspace_id = $1 and a.comment_id = $2 order by a.created_at desc`,
      [workspaceId, commentId],
    );
    return { ...comment.rows[0], actions: actions.rows };
  });
}

/** The run's ticket with this subject: status + its messages (oldest first). */
export async function ticketState(subject: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{ status: string; sender_role: string; is_internal_note: boolean; body: string }>(
      `select t.status, m.sender_role, m.is_internal_note, m.body from tickets t
         join ticket_messages m on m.ticket_id = t.id
        where t.subject = $1 order by m.created_at`,
      [subject],
    );
    return {
      status: rows[0]?.status,
      messages: rows.map((r) => ({ senderRole: r.sender_role, internal: r.is_internal_note, body: r.body })),
    };
  });
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
      // Billing (PW-T3; since PR-T3 sign-up makes an account only, no trial): the run users' accounts
      // and the run workspaces' accounts; children first (FKs restrict), accounts after workspaces.
      const accounts = await db.query<{ id: string }>(
        `select id from billing_accounts where owner_user_id = any($1::uuid[])
         union select billing_account_id from workspaces where id = any($2::uuid[]) and billing_account_id is not null`,
        [ids, wsIds],
      );
      const accountIds = accounts.rows.map((r) => r.id);
      // Payments (M8-T2): events by the accounts' tran_ids, then the transactions (they reference
      // subscriptions, workspaces and accounts, all restrict).
      const runTranIds = 'select tran_id from payment_transactions where billing_account_id = any($1::uuid[])';
      await db.query(`delete from payment_events where tran_id in (${runTranIds})`, [accountIds]);
      await db.query(
        'delete from payment_refunds where payment_transaction_id in (select id from payment_transactions where billing_account_id = any($1::uuid[]))',
        [accountIds],
      );
      await db.query('delete from payment_transactions where billing_account_id = any($1::uuid[])', [accountIds]);
      // Manual activation audit (PW-T9) references admins, accounts, workspaces, plans and
      // subscriptions (all restrict) → before the subscriptions.
      await db.query(
        'delete from subscription_audit_logs where admin_id = any($1::uuid[]) or billing_account_id = any($2::uuid[]) or workspace_id = any($3::uuid[])',
        [ids, accountIds, wsIds],
      );
      const walletIds = 'select id from wallets where billing_account_id = any($1::uuid[])';
      await db.query(`delete from wallet_entries where wallet_id in (${walletIds})`, [accountIds]);
      await db.query(`delete from wallet_balances where wallet_id in (${walletIds})`, [accountIds]);
      await db.query('delete from wallets where billing_account_id = any($1::uuid[])', [accountIds]);
      await db.query('delete from subscriptions where billing_account_id = any($1::uuid[])', [accountIds]);
      // Moderation (M5-T7): actions reference comments (restrict) → first; policies reference workspaces.
      await db.query('delete from moderation_actions where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from moderation_policies where workspace_id = any($1::uuid[])', [wsIds]);
      // Support tickets (M7-GATE): attachments → messages (sender may be the run's admin) → tickets.
      const runTickets = 'select id from tickets where workspace_id = any($1::uuid[])';
      await db.query(`delete from ticket_attachments where ticket_id in (${runTickets})`, [wsIds]);
      await db.query(`delete from ticket_messages where ticket_id in (${runTickets})`, [wsIds]);
      await db.query('delete from tickets where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from alert_deliveries where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from alert_settings where workspace_id = any($1::uuid[])', [wsIds]);
      await db.query('delete from telegram_chats where workspace_id = any($1::uuid[])', [wsIds]);
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
      await db.query('delete from billing_accounts where id = any($1::uuid[])', [accountIds]);
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
