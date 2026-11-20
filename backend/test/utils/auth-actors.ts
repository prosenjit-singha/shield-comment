import type { INestApplication } from '@nestjs/common';
import { getDrizzleToken } from '@nestjs/drizzle';
import { AuthService } from '@thallesp/nestjs-better-auth';
import { and, eq, inArray, or } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import type { BetterAuth } from '../../src/auth/better-auth.js';
import { ensureSuperAdmin } from '../../src/auth/super-admin.js';
import type { Database } from '../../src/db/database.js';
import {
  aiCreditTopupAuditLogs,
  aiCreditTopups,
  aiSettingsAuditLogs,
  billingAccounts,
  comments,
  dailyCommentStats,
  impersonationAuditLogs,
  metaConnections,
  metaDataDeletionRequests,
  moderationActions,
  moderationPolicies,
  planAuditLogs,
  plans,
  postContexts,
  promotionPlans,
  promotionRedemptions,
  promotions,
  socialPages,
  subscriptionAuditLogs,
  subscriptions,
  ticketMessages,
  tickets,
  users,
  walletBalances,
  walletEntries,
  wallets,
  workspaceMembers,
  workspaces,
  workspaceStatusAuditLogs,
  webhookEvents,
  type WorkspaceRole,
} from '../../src/db/schema/index.js';
import { AUTH_SECONDARY_STORAGE } from '../../src/redis/redis-secondary-storage.js';
import { uniqueEmail } from './create-test-app.js';
import type { createMemorySecondaryStorage } from './memory-secondary-storage.js';

/** Password for every e2e user. */
export const PASSWORD = 'correct-horse-battery';
/** Trusted (see vitest.config.e2e.ts) Origin for Better Auth POSTs that carry a session cookie. */
export const TRUSTED_ORIGIN = 'http://localhost:5173';

export interface Actor {
  id: string;
  email: string;
  /** Only the `better-auth.session_token` cookie, so the cookie cache is skipped. */
  cookie: string;
  /** Workspace created at sign-up (owner). */
  workspaceId: string;
}

/**
 * Deletes the manual-activation audit rows (PW-T9) → wallet ledger → balances → wallets →
 * subscriptions → promotion redemptions (PR-T1) of these billing accounts (FKs restrict), not the
 * accounts themselves (workspaces may still point at them). Redemptions and subscriptions point
 * at each other: the redemption's `subscription_id` is cleared first.
 */
export async function deleteBillingChildren(
  db: Pick<Database, 'select' | 'delete' | 'update'>,
  accountIds: readonly string[],
): Promise<void> {
  if (accountIds.length === 0) return;
  const ids = [...accountIds];
  await db
    .delete(subscriptionAuditLogs)
    .where(inArray(subscriptionAuditLogs.billingAccountId, ids));
  const walletIds = db
    .select({ id: wallets.id })
    .from(wallets)
    .where(inArray(wallets.billingAccountId, ids));
  await db
    .delete(walletEntries)
    .where(inArray(walletEntries.walletId, walletIds));
  await db
    .delete(walletBalances)
    .where(inArray(walletBalances.walletId, walletIds));
  await db.delete(wallets).where(inArray(wallets.billingAccountId, ids));
  await db
    .update(promotionRedemptions)
    .set({ subscriptionId: null })
    .where(inArray(promotionRedemptions.billingAccountId, ids));
  await db
    .delete(subscriptions)
    .where(inArray(subscriptions.billingAccountId, ids));
  await db
    .delete(promotionRedemptions)
    .where(inArray(promotionRedemptions.billingAccountId, ids));
}

export function sessionCookie(res: request.Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = raw?.find((c) => c.startsWith('better-auth.session_token='));
  expect(cookie, 'session cookie').toBeDefined();
  return cookie!.split(';')[0]!;
}

/** The session token inside the signed cookie = the secondary-storage key. */
export function tokenOf(cookie: string): string {
  return decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
}

/**
 * Sign-up/sign-in/membership helpers for e2e specs on the real test DB. Every user and workspace
 * created through them is tracked; call `cleanup()` in `afterAll` (before `app.close()`).
 */
export function createAuthActors(app: INestApplication<App>) {
  const db = app.get<Database>(getDrizzleToken());
  const storage = app.get<ReturnType<typeof createMemorySecondaryStorage>>(
    AUTH_SECONDARY_STORAGE,
  );
  const userIds: string[] = [];
  const workspaceIds: string[] = [];
  /** Facebook user ids whose `meta_data_deletion_requests` rows `cleanup()` deletes (M4-T6). */
  const facebookUserIds: string[] = [];
  const http = () => request(app.getHttpServer());

  /**
   * Signs up a user: their first workspace (owner) linked to a new billing account, **no plan**
   * (PR-T3). `{ trial: true }` then starts the seeded Starter trial through the endpoint
   * (`startTrial`), i.e. what sign-up gave before PR-T3.
   */
  async function signUp(
    prefix: string,
    options: { trial?: boolean } = {},
  ): Promise<Actor> {
    const email = uniqueEmail(prefix);
    const res = await http()
      .post('/api/auth/sign-up/email')
      .send({ name: prefix, email, password: PASSWORD })
      .expect(200);
    const id = res.body.user.id as string;
    userIds.push(id);
    const [member] = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, id));
    workspaceIds.push(member!.workspaceId);
    const actor = {
      id,
      email,
      cookie: sessionCookie(res),
      workspaceId: member!.workspaceId,
    };
    if (options.trial) await startTrial(actor);
    return actor;
  }

  /**
   * Starts the owner's trial on plan `slug` (default Starter, the seeded "Starter 7-day trial")
   * through `POST …/billing/trial` (PR-T3): TRIALING subscription + redemption + wallet period.
   * Returns the subscription id.
   */
  async function startTrial(owner: Actor, slug = 'starter'): Promise<string> {
    const [plan] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, slug));
    expect(plan, `plan ${slug}`).toBeDefined();
    const res = await http()
      .post(`/api/workspaces/${owner.workspaceId}/billing/trial`)
      .set('Cookie', owner.cookie)
      .send({ planId: plan!.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const [row] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.billingAccountId, await accountIdOf(owner)),
          eq(subscriptions.status, 'TRIALING'),
        ),
      );
    return row!.id;
  }

  /** A fresh session (cookie) for an existing user. */
  async function signIn(email: string): Promise<string> {
    const res = await http()
      .post('/api/auth/sign-in/email')
      .send({ email, password: PASSWORD });
    expect(res.status).toBe(200);
    return sessionCookie(res);
  }

  async function addMember(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ) {
    await db.insert(workspaceMembers).values({ workspaceId, userId, role });
  }

  /** Signs up a user, promotes them like `npm run create-super-admin`, and signs in again. */
  async function signUpSuperAdmin(prefix: string): Promise<Actor> {
    const actor = await signUp(prefix);
    const auth = app.get(AuthService).instance as BetterAuth;
    expect(
      await ensureSuperAdmin(db, auth, { email: actor.email, name: prefix }),
    ).toBe('promoted');
    // The cached session still says role=user.
    actor.cookie = await signIn(actor.email);
    return actor;
  }

  /** Edits the cached session the way M1-T3's impersonation exchange will create it. */
  async function patchStoredSession(
    cookie: string,
    patch: Record<string, unknown>,
  ) {
    const token = tokenOf(cookie);
    const raw = await storage.get(token);
    expect(raw, 'cached session').toBeTruthy();
    const cached = JSON.parse(raw as string) as {
      session: Record<string, unknown>;
    };
    Object.assign(cached.session, patch);
    await storage.set(token, JSON.stringify(cached));
  }

  /**
   * Undoes the billing setup sign-up (and `startTrial`) made for these actors (PW-T3): their
   * accounts' wallet rows + subscriptions + redemptions, the workspace links and the accounts. For specs that build billing rows
   * themselves (schema, wallet). Returns nothing; the actors stay usable.
   */
  async function removeBilling(...owners: Actor[]): Promise<void> {
    const ids = owners.map((o) => o.id);
    if (ids.length === 0) return;
    const accountIds = (
      await db
        .select({ id: billingAccounts.id })
        .from(billingAccounts)
        .where(inArray(billingAccounts.ownerUserId, ids))
    ).map((row) => row.id);
    if (accountIds.length === 0) return;
    await deleteBillingChildren(db, accountIds);
    await db
      .update(workspaces)
      .set({ billingAccountId: null })
      .where(inArray(workspaces.billingAccountId, accountIds));
    await db
      .delete(billingAccounts)
      .where(inArray(billingAccounts.id, accountIds));
  }

  /** The owner's billing account id (created at sign-up, PW-T3). */
  async function accountIdOf(owner: Actor): Promise<string> {
    const [row] = await db
      .select({ id: billingAccounts.id })
      .from(billingAccounts)
      .where(eq(billingAccounts.ownerUserId, owner.id));
    expect(row, 'billing account').toBeDefined();
    return row!.id;
  }

  /**
   * Ends the owner's live subscription (`EXPIRED`, e.g. the trial ran out; PW-D9). The term end is
   * left as is: readers stop at the status. No-op without one.
   */
  async function expirePlan(owner: Actor): Promise<void> {
    await db
      .update(subscriptions)
      .set({ status: 'EXPIRED' })
      .where(
        and(
          eq(subscriptions.billingAccountId, await accountIdOf(owner)),
          inArray(subscriptions.status, ['TRIALING', 'ACTIVE']),
        ),
      );
  }

  /**
   * Replaces the owner's live subscription (if any) with a paid `ACTIVE` monthly one on the plan `slug`
   * (started a minute ago, 30 days long, price snapshot 999): e.g. Growth for its higher limits
   * and flags (PW-T5). Returns the new subscription id.
   */
  async function activatePlan(owner: Actor, slug: string): Promise<string> {
    const accountId = await accountIdOf(owner);
    await expirePlan(owner);
    const [plan] = await db
      .select({ id: plans.id })
      .from(plans)
      .where(eq(plans.slug, slug));
    expect(plan, `plan ${slug}`).toBeDefined();
    const start = new Date(Date.now() - 60_000);
    const [row] = await db
      .insert(subscriptions)
      .values({
        billingAccountId: accountId,
        planId: plan!.id,
        interval: 'month',
        status: 'ACTIVE',
        startedAt: start,
        currentTermStart: start,
        currentTermEnd: new Date(start.getTime() + 30 * 24 * 3_600_000),
        pricePerMonthBdt: 999,
        chargedBdt: 999,
      })
      .returning({ id: subscriptions.id });
    return row!.id;
  }

  /**
   * Deletes every tracked workspace and user (members, sessions and accounts cascade). Their
   * billing children (wallet entries, balances, wallets, subscriptions), impersonation, status and
   * plan audit rows, ticket messages and tickets go first: those FKs are `restrict`. Billing
   * accounts go after the workspaces and before the users.
   */
  async function cleanup() {
    // Billing (PW-T1): the accounts owned by the tracked users or used by the tracked workspaces.
    // Their wallet ledger → balances → wallets → subscriptions go first (FKs restrict); the
    // accounts themselves after the workspaces (which point at them) and before the users.
    const accountRefs = [
      ...(userIds.length
        ? [inArray(billingAccounts.ownerUserId, userIds)]
        : []),
      ...(workspaceIds.length
        ? [
            inArray(
              billingAccounts.id,
              db
                .select({ id: workspaces.billingAccountId })
                .from(workspaces)
                .where(inArray(workspaces.id, workspaceIds)),
            ),
          ]
        : []),
    ];
    const accountIds = accountRefs.length
      ? (
          await db
            .select({ id: billingAccounts.id })
            .from(billingAccounts)
            .where(or(...accountRefs))
        ).map((row) => row.id)
      : [];
    // Manual activation audit (PW-T9): admin, workspace and account FKs restrict.
    const subscriptionAuditRefs = [
      ...(userIds.length
        ? [inArray(subscriptionAuditLogs.adminId, userIds)]
        : []),
      ...(workspaceIds.length
        ? [inArray(subscriptionAuditLogs.workspaceId, workspaceIds)]
        : []),
    ];
    if (subscriptionAuditRefs.length)
      await db
        .delete(subscriptionAuditLogs)
        .where(or(...subscriptionAuditRefs));
    await deleteBillingChildren(db, accountIds);
    // Promotions (PR-T1): the ones tracked users created go (claims + targets first; the claims'
    // subscriptions are gone above); the seeded ones (`created_by` null, 0027) stay, and a Stop by
    // a tracked user is undone.
    if (userIds.length) {
      const created = db
        .select({ id: promotions.id })
        .from(promotions)
        .where(inArray(promotions.createdBy, userIds));
      await db
        .delete(promotionRedemptions)
        .where(inArray(promotionRedemptions.promotionId, created));
      await db
        .delete(promotionPlans)
        .where(inArray(promotionPlans.promotionId, created));
      await db.delete(promotions).where(inArray(promotions.createdBy, userIds));
      await db
        .update(promotions)
        .set({ stoppedAt: null, stoppedBy: null })
        .where(inArray(promotions.stoppedBy, userIds));
    }
    const ticketRefs = [
      ...(userIds.length ? [inArray(tickets.userId, userIds)] : []),
      ...(workspaceIds.length
        ? [inArray(tickets.workspaceId, workspaceIds)]
        : []),
    ];
    if (ticketRefs.length) {
      const ticketIds = db
        .select({ id: tickets.id })
        .from(tickets)
        .where(or(...ticketRefs));
      await db
        .delete(ticketMessages)
        .where(
          or(
            inArray(ticketMessages.ticketId, ticketIds),
            ...(userIds.length
              ? [inArray(ticketMessages.senderId, userIds)]
              : []),
          ),
        );
      await db.delete(tickets).where(or(...ticketRefs));
    }
    const impersonationRefs = [
      ...(userIds.length
        ? [inArray(impersonationAuditLogs.adminId, userIds)]
        : []),
      ...(workspaceIds.length
        ? [inArray(impersonationAuditLogs.targetWorkspaceId, workspaceIds)]
        : []),
    ];
    if (impersonationRefs.length)
      await db.delete(impersonationAuditLogs).where(or(...impersonationRefs));
    const statusRefs = [
      ...(userIds.length
        ? [inArray(workspaceStatusAuditLogs.adminId, userIds)]
        : []),
      ...(workspaceIds.length
        ? [inArray(workspaceStatusAuditLogs.workspaceId, workspaceIds)]
        : []),
    ];
    if (statusRefs.length)
      await db.delete(workspaceStatusAuditLogs).where(or(...statusRefs));
    if (userIds.length) {
      await db
        .delete(planAuditLogs)
        .where(inArray(planAuditLogs.adminId, userIds));
      // AI settings audit (M5-T3): actor FK restrict. Settings/key rows use `set null`.
      await db
        .delete(aiSettingsAuditLogs)
        .where(inArray(aiSettingsAuditLogs.adminId, userIds));
      // AI credit top-ups + their audit (M5-T15d): creator / actor FK restrict.
      await db
        .delete(aiCreditTopupAuditLogs)
        .where(inArray(aiCreditTopupAuditLogs.adminId, userIds));
      await db
        .delete(aiCreditTopups)
        .where(inArray(aiCreditTopups.createdById, userIds));
    }
    if (workspaceIds.length) {
      // Moderation (M5-T7): actions reference comments + workspaces (restrict) → first;
      // the policy references the workspace.
      await db
        .delete(moderationActions)
        .where(inArray(moderationActions.workspaceId, workspaceIds));
      await db
        .delete(moderationPolicies)
        .where(inArray(moderationPolicies.workspaceId, workspaceIds));
      // Webhook rows (M4-T2) reference workspaces (restrict) and Pages (comments: set null).
      await db
        .delete(webhookEvents)
        .where(inArray(webhookEvents.workspaceId, workspaceIds));
      await db
        .delete(comments)
        .where(inArray(comments.workspaceId, workspaceIds));
      await db
        .delete(dailyCommentStats)
        .where(inArray(dailyCommentStats.workspaceId, workspaceIds));
      // Data Deletion requests (M4-T6) have no FK: matched by the Facebook user ids of the
      // workspaces' connections + the ids a spec tracked (the deletion job removes connections).
      const connectionUsers = await db
        .select({ id: metaConnections.facebookUserId })
        .from(metaConnections)
        .where(inArray(metaConnections.workspaceId, workspaceIds));
      facebookUserIds.push(...connectionUsers.map((row) => row.id));
      // Post caption cache (M5-T10): workspace FK restrict, Page FK cascade.
      await db
        .delete(postContexts)
        .where(inArray(postContexts.workspaceId, workspaceIds));
      // Meta rows (M3-T2) reference workspaces with FK restrict.
      await db
        .delete(socialPages)
        .where(inArray(socialPages.workspaceId, workspaceIds));
      await db
        .delete(metaConnections)
        .where(inArray(metaConnections.workspaceId, workspaceIds));
      await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
    }
    if (accountIds.length)
      await db
        .delete(billingAccounts)
        .where(inArray(billingAccounts.id, accountIds));
    if (facebookUserIds.length)
      await db
        .delete(metaDataDeletionRequests)
        .where(
          inArray(metaDataDeletionRequests.facebookUserId, facebookUserIds),
        );
    if (userIds.length)
      await db.delete(users).where(inArray(users.id, userIds));
  }

  return {
    db,
    storage,
    http,
    signUp,
    startTrial,
    signIn,
    signUpSuperAdmin,
    addMember,
    patchStoredSession,
    removeBilling,
    accountIdOf,
    expirePlan,
    activatePlan,
    /** Track a workspace created outside `signUp` (e.g. `/organization/create`) for `cleanup()`. */
    trackWorkspace: (id: string) => workspaceIds.push(id),
    /** Track a user created outside `signUp` so `cleanup()` deletes it. */
    trackUser: (id: string) => userIds.push(id),
    /** Track a Facebook user id so `cleanup()` deletes its Data Deletion requests (M4-T6). */
    trackFacebookUser: (id: string) => facebookUserIds.push(id),
    cleanup,
  };
}
