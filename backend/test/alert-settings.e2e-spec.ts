import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import {
  alertDeliveries,
  alertSettings,
  workspaceMembers,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/**
 * M7-T7: workspace alert settings API (D2/D12/D14/D15 answered 2026-11-20). Real Postgres; no
 * email or Telegram is sent by these routes.
 */
describe('Alert settings API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let wsAdmin: Actor;
  let moderator: Actor;
  let growth: Actor;
  let outsider: Actor;
  let superAdmin: Actor;

  const http = () => request(app.getHttpServer());
  const path = (ws: string) => `/api/workspaces/${ws}/alerts/settings`;
  const get = (cookie: string, ws: string) =>
    http().get(path(ws)).set('Cookie', cookie);
  const patch = (cookie: string, ws: string, body: object) =>
    http().patch(path(ws)).set('Cookie', cookie).send(body);
  const memberIdOf = async (userId: string, ws: string) => {
    const [row] = await actors.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws),
          eq(workspaceMembers.userId, userId),
        ),
      );
    return row!.id;
  };
  const storedRow = async (ws: string) => {
    const [row] = await actors.db
      .select()
      .from(alertSettings)
      .where(eq(alertSettings.workspaceId, ws));
    return row;
  };
  const recipientsOf = (body: {
    email: { recipients: { userId: string }[] };
  }) => body.email.recipients.map((r) => r.userId);

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m7t7-owner');
    wsAdmin = await actors.signUp('m7t7-admin');
    moderator = await actors.signUp('m7t7-mod');
    growth = await actors.signUp('m7t7-growth');
    outsider = await actors.signUp('m7t7-outsider');
    superAdmin = await actors.signUpSuperAdmin('m7t7-super');
    await actors.addMember(owner.workspaceId, wsAdmin.id, 'admin');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.activatePlan(growth, 'growth');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('GET with no row: defaults (alerts off, threshold 10, owner as recipient), no row created', async () => {
    const res = await get(moderator.cookie, owner.workspaceId).expect(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toEqual({
      workspaceId: owner.workspaceId,
      spikeThreshold: 10,
      email: {
        enabled: false,
        available: true,
        recipients: [
          {
            memberId: await memberIdOf(owner.id, owner.workspaceId),
            userId: owner.id,
            name: expect.any(String),
            email: owner.email,
            role: 'owner',
          },
        ],
      },
      telegram: { enabled: false, available: false },
      whatsapp: { enabled: false, available: false, comingSoon: true },
      lastAlerts: [],
      updatedAt: null,
    });
    expect(await storedRow(owner.workspaceId)).toBeUndefined();
  });

  it('owner and admin save; moderator 403; non-member 404', async () => {
    const ws = owner.workspaceId;
    const modMember = await memberIdOf(moderator.id, ws);
    const res = await patch(owner.cookie, ws, {
      spikeThreshold: 25,
      emailEnabled: true,
      emailRecipientMemberIds: [modMember, await memberIdOf(owner.id, ws)],
    }).expect(200);
    expect(res.body).toMatchObject({
      spikeThreshold: 25,
      email: { enabled: true },
      telegram: { enabled: false, available: false },
    });
    expect(recipientsOf(res.body)).toEqual([owner.id, moderator.id]);
    expect(await storedRow(ws)).toMatchObject({
      spikeThreshold: 25,
      emailEnabled: true,
      telegramEnabled: false,
    });

    const byAdmin = await patch(wsAdmin.cookie, ws, {
      spikeThreshold: 40,
    }).expect(200);
    expect(byAdmin.body.spikeThreshold).toBe(40);
    expect(recipientsOf(byAdmin.body)).toEqual([owner.id, moderator.id]);

    const denied = await patch(moderator.cookie, ws, { spikeThreshold: 5 });
    expect(denied.status).toBe(403);
    await get(outsider.cookie, ws).expect(404);
    await patch(outsider.cookie, ws, { spikeThreshold: 5 }).expect(404);
    expect((await storedRow(ws))?.spikeThreshold).toBe(40);
  });

  it('impersonated owner session may edit (D2)', async () => {
    const cookie = await actors.signIn(owner.email);
    await actors.patchStoredSession(cookie, {
      impersonatedBy: superAdmin.id,
      activeOrganizationId: owner.workspaceId,
    });
    await get(cookie, owner.workspaceId).expect(200);
    const res = await patch(cookie, owner.workspaceId, {
      spikeThreshold: 7,
    }).expect(200);
    expect(res.body.spikeThreshold).toBe(7);
  });

  it('validation: 400 codes for threshold, recipients and empty body', async () => {
    const ws = owner.workspaceId;
    const foreign = await memberIdOf(outsider.id, outsider.workspaceId);
    const cases: [object, string | undefined][] = [
      [{ spikeThreshold: 0 }, 'ALERT_THRESHOLD_INVALID'],
      [{ spikeThreshold: 1001 }, 'ALERT_THRESHOLD_INVALID'],
      [{ emailRecipientMemberIds: [foreign] }, 'ALERT_RECIPIENT_NOT_MEMBER'],
      [{ emailRecipientMemberIds: [] }, 'ALERT_RECIPIENTS_REQUIRED'],
      [{}, undefined],
      [{ spikeThreshold: 'many' }, undefined],
      [{ emailRecipientMemberIds: ['nope'] }, undefined],
      [{ whatsappEnabled: true }, undefined],
    ];
    for (const [body, code] of cases) {
      const res = await patch(owner.cookie, ws, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code, JSON.stringify(body)).toBe(code);
    }
    expect((await storedRow(ws))?.spikeThreshold).toBe(7);
  });

  it('Starter: Telegram on → 409 PLAN_FEATURE_UNAVAILABLE; off is fine', async () => {
    const res = await patch(owner.cookie, owner.workspaceId, {
      telegramEnabled: true,
    }).expect(409);
    expect(res.body).toMatchObject({
      code: 'PLAN_FEATURE_UNAVAILABLE',
      details: { feature: 'messengerAlerts' },
    });
    await patch(owner.cookie, owner.workspaceId, {
      telegramEnabled: false,
    }).expect(200);
  });

  it('Growth: Telegram on saved; after the plan expires it stays saved but unavailable (reading 11)', async () => {
    const ws = growth.workspaceId;
    const res = await patch(growth.cookie, ws, {
      telegramEnabled: true,
    }).expect(200);
    expect(res.body.telegram).toEqual({ enabled: true, available: true });

    await actors.expirePlan(growth);
    const after = await get(growth.cookie, ws).expect(200);
    expect(after.body.telegram).toEqual({ enabled: true, available: false });
    // Other edits keep it; switching it on again is refused.
    await patch(growth.cookie, ws, { spikeThreshold: 3 }).expect(200);
    expect((await storedRow(ws))?.telegramEnabled).toBe(true);
    await patch(growth.cookie, ws, { telegramEnabled: true }).expect(409);
  });

  it('a removed member drops out of the recipients; last alert per channel', async () => {
    const ws = owner.workspaceId;
    await actors.db
      .delete(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, ws),
          eq(workspaceMembers.userId, moderator.id),
        ),
      );
    const now = Date.now();
    const t = (min: number) => new Date(now - min * 60_000);
    await actors.db.insert(alertDeliveries).values([
      {
        workspaceId: ws,
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 10,
        sentAt: t(120),
      },
      {
        workspaceId: ws,
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 12,
        sentAt: t(5),
      },
      {
        workspaceId: ws,
        channel: 'TELEGRAM',
        status: 'FAILED',
        scamCount: 12,
        errorKind: 'timeout',
        sentAt: t(6),
      },
      {
        workspaceId: growth.workspaceId,
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 99,
        sentAt: t(1),
      },
    ]);
    const res = await get(wsAdmin.cookie, ws).expect(200);
    expect(recipientsOf(res.body)).toEqual([owner.id]);
    expect(res.body.lastAlerts).toEqual([
      {
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 12,
        errorKind: null,
        sentAt: t(5).toISOString(),
      },
      {
        channel: 'TELEGRAM',
        status: 'FAILED',
        scamCount: 12,
        errorKind: 'timeout',
        sentAt: t(6).toISOString(),
      },
    ]);
  });
});
