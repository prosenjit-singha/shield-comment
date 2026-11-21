import type { INestApplication } from '@nestjs/common';
import { eq, type SQL, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  aiCreditTopupAuditLogs,
  aiSettingsAuditLogs,
  impersonationAuditLogs,
  paymentRefunds,
  paymentTransactions,
  planAuditLogs,
  plans,
  subscriptionAuditLogs,
  workspaceStatusAuditLogs,
} from '../src/db/schema/index.js';
import { hashImpersonationToken } from '../src/impersonation/impersonation-token.js';
import { burnImpersonationTokenQuery } from '../src/impersonation/impersonation-queries.js';
import {
  type Actor,
  createAuthActors,
  withAuditMaintenance,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const CLIENT_ORIGIN = 'http://localhost:5174'; // trusted (vitest.config.e2e.ts)
const EXCHANGE = '/api/auth/impersonate-exchange';

const AUDIT_TABLES = [
  'impersonation_audit_logs',
  'workspace_status_audit_logs',
  'plan_audit_logs',
  'ai_settings_audit_logs',
  'ai_credit_topup_audit_logs',
  'subscription_audit_logs',
  'payment_refunds',
] as const;
type AuditTable = (typeof AUDIT_TABLES)[number];

/** The Postgres error behind a failed query (Drizzle wraps it in `cause`), or `undefined`. */
async function pgError(
  query: PromiseLike<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await query;
  } catch (error) {
    return ((error as { cause?: unknown }).cause ?? error) as {
      code?: string;
      message?: string;
    };
  }
  return undefined;
}

const IMMUTABLE = { code: 'P0001', message: 'audit_log_immutable' };

/**
 * M9-T4 (D4 a, migration 0046): the 7 audit tables refuse UPDATE, DELETE and TRUNCATE
 * (`audit_log_immutable`) except the one-time impersonation burn and test cleanups that set
 * `shield.audit_maintenance` inside their transaction.
 */
describe('Immutable audit logs (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let superAdmin: Actor;
  const ids = {} as Record<AuditTable, string>;

  const db = () => actors.db;
  const table = (name: AuditTable) => sql.raw(`"${name}"`);
  const run = (query: SQL) => db().execute(query);

  async function issueToken(): Promise<string> {
    const res = await actors
      .http()
      .post(`/api/admin/clients/${owner.workspaceId}/impersonate`)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    return res.body.token as string;
  }

  const exchange = (token: string) =>
    actors.http().post(EXCHANGE).set('Origin', CLIENT_ORIGIN).send({ token });

  const auditRow = async (tokenHash: string) =>
    (
      await db()
        .select()
        .from(impersonationAuditLogs)
        .where(eq(impersonationAuditLogs.tokenHash, tokenHash))
    )[0]!;

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m9t4-owner');
    superAdmin = await actors.signUpSuperAdmin('m9t4-super');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('INSERT works on every audit table', async () => {
    const adminId = superAdmin.id;
    const [plan] = await db()
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, 'starter'));
    const accountId = await actors.accountIdOf(owner);
    const subscriptionId = await actors.activatePlan(owner, 'starter');
    const [tran] = await db()
      .insert(paymentTransactions)
      .values({
        billingAccountId: accountId,
        workspaceId: owner.workspaceId,
        userId: owner.id,
        planId: plan!.id,
        interval: 'month',
        kind: 'NEW',
        tranId: `M9T4${Date.now().toString(36)}`,
        amountBdt: 499,
        gateway: 'SSLCOMMERZ',
        price: {
          listChargedBdt: 499,
          chargedBdt: 499,
          perMonthBdt: 499,
          discount: null,
          coupon: null,
          creditBdt: 0,
        },
      })
      .returning({ id: paymentTransactions.id });

    const one = async (q: PromiseLike<{ id: string }[]>) => (await q)[0]!.id;
    ids.impersonation_audit_logs = await one(
      db()
        .insert(impersonationAuditLogs)
        .values({
          adminId,
          targetWorkspaceId: owner.workspaceId,
          tokenHash: hashImpersonationToken(`m9t4-${Date.now()}`),
          expiresAt: new Date(Date.now() + 60_000),
        })
        .returning({ id: impersonationAuditLogs.id }),
    );
    ids.workspace_status_audit_logs = await one(
      db()
        .insert(workspaceStatusAuditLogs)
        .values({
          workspaceId: owner.workspaceId,
          adminId,
          oldStatus: 'ACTIVE',
          newStatus: 'SUSPENDED',
          reason: 'm9t4',
        })
        .returning({ id: workspaceStatusAuditLogs.id }),
    );
    ids.plan_audit_logs = await one(
      db()
        .insert(planAuditLogs)
        .values({
          planId: plan!.id,
          adminId,
          action: 'UPDATE',
          changes: [{ field: 'monthlyPriceBdt', before: 1, after: 2 }],
        })
        .returning({ id: planAuditLogs.id }),
    );
    ids.ai_settings_audit_logs = await one(
      db()
        .insert(aiSettingsAuditLogs)
        .values({ adminId, field: 'model', before: null, after: 'm9t4' })
        .returning({ id: aiSettingsAuditLogs.id }),
    );
    ids.ai_credit_topup_audit_logs = await one(
      db()
        .insert(aiCreditTopupAuditLogs)
        .values({
          adminId,
          action: 'add',
          topupId: '00000000-0000-7000-8000-000000000946',
          amountUsd: 5,
          toppedUpOn: '2026-11-21',
        })
        .returning({ id: aiCreditTopupAuditLogs.id }),
    );
    ids.subscription_audit_logs = await one(
      db()
        .insert(subscriptionAuditLogs)
        .values({
          adminId,
          billingAccountId: accountId,
          workspaceId: owner.workspaceId,
          afterSubscriptionId: subscriptionId,
          afterPlanId: plan!.id,
          afterInterval: 'month',
          afterStatus: 'ACTIVE',
          reason: 'm9t4',
        })
        .returning({ id: subscriptionAuditLogs.id }),
    );
    ids.payment_refunds = await one(
      db()
        .insert(paymentRefunds)
        .values({ paymentTransactionId: tran!.id, adminId, reason: 'm9t4' })
        .returning({ id: paymentRefunds.id }),
    );
    expect(Object.keys(ids).sort()).toEqual([...AUDIT_TABLES].sort());
  });

  describe.each(AUDIT_TABLES)('%s', (name) => {
    it('UPDATE fails with audit_log_immutable', async () => {
      expect(
        await pgError(
          run(
            sql`update ${table(name)} set created_at = created_at - interval '1 day' where id = ${ids[name]}`,
          ),
        ),
      ).toMatchObject(IMMUTABLE);
    });

    it('DELETE fails with audit_log_immutable and the row stays', async () => {
      expect(
        await pgError(
          run(sql`delete from ${table(name)} where id = ${ids[name]}`),
        ),
      ).toMatchObject(IMMUTABLE);
      const { rows } = await run(
        sql`select 1 from ${table(name)} where id = ${ids[name]}`,
      );
      expect(rows).toHaveLength(1);
    });

    it('TRUNCATE fails with audit_log_immutable', async () => {
      // Inside a rolled-back transaction, so a missing trigger can't wipe the table.
      const error = await pgError(
        db().transaction(async (tx) => {
          await tx.execute(sql`truncate ${table(name)} cascade`);
          tx.rollback();
        }),
      );
      expect(error).toMatchObject(IMMUTABLE);
    });
  });

  describe('impersonation burn', () => {
    it('the exchange still burns a token once; a second exchange is 401', async () => {
      const token = await issueToken();
      await exchange(token).expect(200);
      const row = await auditRow(hashImpersonationToken(token));
      expect(row.usedAt).toBeInstanceOf(Date);
      await exchange(token).expect(401);
      expect((await auditRow(row.tokenHash)).usedAt).toEqual(row.usedAt);
    });

    it('a second burn, a used_at rewrite or reset fails', async () => {
      const token = await issueToken();
      await exchange(token).expect(200);
      const where = eq(
        impersonationAuditLogs.tokenHash,
        hashImpersonationToken(token),
      );
      for (const usedAt of [new Date(Date.now() + 1_000), null]) {
        expect(
          await pgError(
            db().update(impersonationAuditLogs).set({ usedAt }).where(where),
          ),
        ).toMatchObject(IMMUTABLE);
      }
    });

    it('a burn that changes any other column fails; only-other-column updates fail', async () => {
      const token = await issueToken();
      const where = eq(
        impersonationAuditLogs.tokenHash,
        hashImpersonationToken(token),
      );
      const now = new Date();
      for (const patch of [
        { usedAt: now, ipAddress: '203.0.113.9' },
        { usedAt: now, expiresAt: new Date(Date.now() + 3_600_000) },
        { usedAt: now, adminId: owner.id },
        { ipAddress: '203.0.113.9' },
        { expiresAt: new Date(Date.now() + 3_600_000) },
      ]) {
        expect(
          await pgError(
            db().update(impersonationAuditLogs).set(patch).where(where),
          ),
          JSON.stringify(Object.keys(patch)),
        ).toMatchObject(IMMUTABLE);
      }
      // The plain burn (used_at + Drizzle's updated_at) still goes through, once.
      const hash = hashImpersonationToken(token);
      expect(await burnImpersonationTokenQuery(db(), hash, now)).toHaveLength(
        1,
      );
      expect((await auditRow(hash)).usedAt).toEqual(now);
    });
  });

  describe('test cleanups (shield.audit_maintenance)', () => {
    it('with the setting a change goes through; the setting ends with its transaction', async () => {
      const id = ids.ai_settings_audit_logs;
      await withAuditMaintenance(db(), (tx) =>
        tx
          .update(aiSettingsAuditLogs)
          .set({ after: 'm9t4-maintained' })
          .where(eq(aiSettingsAuditLogs.id, id)),
      );
      const [row] = await db()
        .select({ after: aiSettingsAuditLogs.after })
        .from(aiSettingsAuditLogs)
        .where(eq(aiSettingsAuditLogs.id, id));
      expect(row!.after).toBe('m9t4-maintained');
      // Every pooled connection is back to the trigger's default.
      for (let i = 0; i < 12; i++) {
        expect(
          await pgError(
            db()
              .delete(aiSettingsAuditLogs)
              .where(eq(aiSettingsAuditLogs.id, id)),
          ),
        ).toMatchObject(IMMUTABLE);
      }
    });

    it('cleanup() deletes the audit rows of tracked users', async () => {
      await actors.cleanup();
      for (const name of AUDIT_TABLES) {
        const { rows } = await run(
          sql`select 1 from ${table(name)} where id = ${ids[name]}`,
        );
        expect(rows, name).toHaveLength(0);
      }
    });
  });
});
