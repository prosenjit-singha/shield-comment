import type { INestApplication } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { LimitService } from '../src/billing/limit.service.js';
import { billingAccounts, workspaces } from '../src/db/schema/index.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/**
 * PW-T5: plan limits pooled per billing account (user decisions 2026-11-19 PW-D10 workspaces
 * 1 / 3 / 10, PW-D11 one pool per client account, PW-D7/D9 no Free plan / no live plan). The
 * `/organization/create` before-hook and `LimitService.seatsLeft`. Pages are in
 * `workspace-pages.e2e-spec.ts`, plan flags in `moderation-policy.e2e-spec.ts`. Real Postgres.
 */
describe('Pooled plan limits (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let limits: LimitService;
  let seq = 0;

  const db = () => actors.db;

  const create = (actor: Actor) =>
    actors
      .http()
      .post('/api/auth/organization/create')
      .set('Cookie', actor.cookie)
      .set('Origin', TRUSTED_ORIGIN)
      .send({
        name: `Pooled shop ${++seq}`,
        slug: `pwt5-${Date.now()}-${seq}`,
      });

  const accountWorkspaces = async (actor: Actor) =>
    db()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.billingAccountId, await actors.accountIdOf(actor)));

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    limits = app.get(LimitService);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('POST /api/auth/organization/create (before-hook)', () => {
    it('Starter trial (1 workspace, the sign-up one) → 403 workspace_limit_reached + details; nothing created', async () => {
      const owner = await actors.signUp('pwt5-trial', { trial: true });
      const res = await create(owner).expect(403);
      expect(res.body).toMatchObject({
        code: 'workspace_limit_reached',
        details: { limit: 1, count: 1 },
      });
      expect(res.body.message).toMatch(/1 workspace and you have 1/);
      expect(await accountWorkspaces(owner)).toEqual([
        { id: owner.workspaceId },
      ]);
    });

    it('Growth (3): two more workspaces pass and are linked, the 4th → 403 with { limit 3, count 3 }', async () => {
      const owner = await actors.signUp('pwt5-growth');
      await actors.activatePlan(owner, 'growth');
      const created: string[] = [];
      for (let i = 0; i < 2; i++) {
        const res = await create(owner).expect(200);
        actors.trackWorkspace(res.body.id as string);
        created.push(res.body.id as string);
      }
      const linked = (await accountWorkspaces(owner)).map((w) => w.id);
      expect(linked.sort()).toEqual([owner.workspaceId, ...created].sort());

      const res = await create(owner).expect(403);
      expect(res.body).toMatchObject({
        code: 'workspace_limit_reached',
        details: { limit: 3, count: 3 },
      });
      expect(await accountWorkspaces(owner)).toHaveLength(3);
    });

    it('expired trial → 403 no_active_plan (no details), nothing created', async () => {
      const owner = await actors.signUp('pwt5-expired');
      await actors.activatePlan(owner, 'growth');
      await actors.expirePlan(owner);
      const res = await create(owner).expect(403);
      expect(res.body).toMatchObject({ code: 'no_active_plan' });
      expect(res.body).not.toHaveProperty('details');
      expect(res.body.message).toMatch(/plan/i);
      expect(await accountWorkspaces(owner)).toHaveLength(1);
    });

    it('no billing account → 403 no_active_plan, and the hook creates no account', async () => {
      const owner = await actors.signUp('pwt5-noaccount');
      await actors.removeBilling(owner);
      const res = await create(owner).expect(403);
      expect(res.body.code).toBe('no_active_plan');
      expect(
        await db()
          .select({ id: billingAccounts.id })
          .from(billingAccounts)
          .where(eq(billingAccounts.ownerUserId, owner.id)),
      ).toEqual([]);
    });

    it('a member counts against their own account, not the workspace they joined', async () => {
      const owner = await actors.signUp('pwt5-host');
      await actors.activatePlan(owner, 'growth');
      const guest = await actors.signUp('pwt5-guest', { trial: true });
      await actors.addMember(owner.workspaceId, guest.id, 'admin');
      // The guest's own Starter trial already has its sign-up workspace.
      const res = await create(guest).expect(403);
      expect(res.body.code).toBe('workspace_limit_reached');
    });

    it('sign-up still creates the first workspace (not through the hook) but no plan: a second → 403 no_active_plan (PR-T3)', async () => {
      const owner = await actors.signUp('pwt5-signup');
      expect(await accountWorkspaces(owner)).toEqual([
        { id: owner.workspaceId },
      ]);
      const res = await create(owner).expect(403);
      expect(res.body.code).toBe('no_active_plan');
    });
  });

  describe('LimitService.seatsLeft (not enforced until Module 7)', () => {
    it('Starter trial: 1 seat − the owner = 0', async () => {
      const owner = await actors.signUp('pwt5-seat-trial', { trial: true });
      expect(await limits.seatsLeft(await actors.accountIdOf(owner))).toBe(0);
    });

    it('Growth (3): distinct members across the account’s workspaces; other accounts never count', async () => {
      const owner = await actors.signUp('pwt5-seat-growth');
      await actors.activatePlan(owner, 'growth');
      const account = await actors.accountIdOf(owner);
      expect(await limits.seatsLeft(account)).toBe(2);

      const res = await create(owner).expect(200);
      const second = res.body.id as string;
      actors.trackWorkspace(second);
      // The owner is a member of both: still one seat.
      expect(await limits.seatsLeft(account)).toBe(2);

      const helper = await actors.signUp('pwt5-seat-helper');
      await actors.addMember(owner.workspaceId, helper.id, 'moderator');
      await actors.addMember(second, helper.id, 'moderator');
      expect(await limits.seatsLeft(account)).toBe(1);

      // Members of another account's workspace don't count here.
      const stranger = await actors.signUp('pwt5-seat-stranger');
      await actors.addMember(helper.workspaceId, stranger.id, 'moderator');
      expect(await limits.seatsLeft(account)).toBe(1);

      const extra = await actors.signUp('pwt5-seat-extra');
      const extra2 = await actors.signUp('pwt5-seat-extra2');
      await actors.addMember(second, extra.id, 'moderator');
      await actors.addMember(second, extra2.id, 'moderator');
      // 4 members on 3 seats: floor 0.
      expect(await limits.seatsLeft(account)).toBe(0);
    });

    it('no live plan → 0; unknown account → 0', async () => {
      const owner = await actors.signUp('pwt5-seat-ended');
      await actors.activatePlan(owner, 'growth');
      await actors.expirePlan(owner);
      expect(await limits.seatsLeft(await actors.accountIdOf(owner))).toBe(0);
      expect(
        await limits.seatsLeft('019a0000-0000-7000-8000-00000000ffff'),
      ).toBe(0);
    });
  });

  it('nothing outside the tracked rows: every workspace of these accounts is tracked', async () => {
    // Guard for cleanup(): the refused creates left no workspace rows behind.
    const names = await db()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        inArray(
          workspaces.name,
          Array.from({ length: seq }, (_, i) => `Pooled shop ${i + 1}`),
        ),
      );
    // 2 (Growth) + 1 (seats) creates succeeded.
    expect(names).toHaveLength(3);
  });
});
