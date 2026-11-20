import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { tickets, type TicketStatus } from '../src/db/schema/index.js';
import type {
  ClientTicketItem,
  ClientTicketMessage,
} from '../src/support-tickets/client-tickets.service.js';
import {
  TicketEvents,
  type TicketRepliedEvent,
} from '../src/support-tickets/ticket-events.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

type Json<T> = {
  [K in keyof T]: T[K] extends Date
    ? string
    : T[K] extends Date | null
      ? string | null
      : T[K];
};
type Item = Json<ClientTicketItem>;
type Detail = Item & { messages: Json<ClientTicketMessage>[] };
interface Page {
  items: Item[];
  total: number;
  skip: number;
  take: number;
}

const UNKNOWN_ID = '019a0000-0000-7000-8000-00000000dead';

/**
 * M7-T2: client ticket API (D1 visibility, D2 impersonation read-only, D3 priority by plan,
 * reading 3 `hasNewReply`, reading 4 cap of 20 unresolved).
 */
describe('Client support tickets (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();
  const db = () => actors.db;
  const T = `m7t2${randomBytes(4).toString('hex')}`;
  const events: TicketRepliedEvent[] = [];

  let superAdmin: Actor;
  /** Owner of workspace A (Pro plan). */
  let a: Actor;
  /** Moderator in workspace A. */
  let mod: Actor;
  /** Owner of workspace B (no plan). */
  let b: Actor;

  const base = (ws: string) => `/api/workspaces/${ws}/support/tickets`;
  const create = (actor: Actor, body: object, ws = actor.workspaceId) =>
    http().post(base(ws)).set('Cookie', actor.cookie).send(body);
  const newTicket = async (actor: Actor, subject: string, ws?: string) => {
    const res = await create(
      actor,
      { category: 'TECHNICAL', subject: `${T} ${subject}`, body: 'Help' },
      ws,
    ).expect(201);
    return res.body as Detail;
  };
  const list = async (actor: Actor, query = '', ws = actor.workspaceId) =>
    (
      await http()
        .get(`${base(ws)}?${query}`)
        .set('Cookie', actor.cookie)
        .expect(200)
    ).body as Page;
  const detail = (actor: Actor, id: string, ws = actor.workspaceId) =>
    http()
      .get(`${base(ws)}/${id}`)
      .set('Cookie', actor.cookie);
  const reply = (
    actor: Actor,
    id: string,
    body: object,
    ws = actor.workspaceId,
  ) =>
    http()
      .post(`${base(ws)}/${id}/reply`)
      .set('Cookie', actor.cookie)
      .send(body);
  const adminReply = (id: string, body: string, isInternalNote = false) =>
    http()
      .post(`/api/admin/tickets/${id}/reply`)
      .set('Cookie', superAdmin.cookie)
      .send({ body, isInternalNote })
      .expect(201);
  const adminStatus = (id: string, status: TicketStatus) =>
    http()
      .patch(`/api/admin/tickets/${id}/status`)
      .set('Cookie', superAdmin.cookie)
      .send({ status })
      .expect(200);

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    app.get(TicketEvents).onReplied((e) => {
      events.push(e);
    });
    superAdmin = await actors.signUpSuperAdmin('m7t2-super');
    a = await actors.signUp('m7t2-a');
    mod = await actors.signUp('m7t2-mod');
    b = await actors.signUp('m7t2-b');
    await actors.addMember(a.workspaceId, mod.id, 'moderator');
    await actors.activatePlan(a, 'pro');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('401 without a session', async () => {
    await http().get(base(a.workspaceId)).expect(401);
    await http()
      .post(base(a.workspaceId))
      .send({ category: 'OTHER', subject: 'x', body: 'y' })
      .expect(401);
  });

  describe('create', () => {
    it('201: requester = session user, first CLIENT message, OPEN; shows up in the admin list (Pro → HIGH)', async () => {
      const t = await newTicket(a, 'Pro ticket');
      expect(t).toMatchObject({
        subject: `${T} Pro ticket`,
        category: 'TECHNICAL',
        status: 'OPEN',
        requester: { id: a.id, name: 'm7t2-a' },
        hasNewReply: false,
        messages: [
          {
            senderRole: 'CLIENT',
            sender: { id: a.id, name: 'm7t2-a' },
            body: 'Help',
          },
        ],
      });
      expect(t).not.toHaveProperty('priority');
      expect(t.lastMessageAt).toBe(t.messages[0]!.createdAt);

      const admin = await http()
        .get(`/api/admin/tickets?q=${encodeURIComponent(`${T} Pro ticket`)}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(admin.body.items).toEqual([
        expect.objectContaining({
          id: t.id,
          priority: 'HIGH',
          status: 'OPEN',
          workspace: expect.objectContaining({ id: a.workspaceId }),
          requester: expect.objectContaining({ id: a.id, email: a.email }),
          messageCount: 1,
        }),
      ]);
    });

    it('MEDIUM without prioritySupportApi', async () => {
      const t = await newTicket(b, 'No plan ticket');
      const [row] = await db()
        .select({ priority: tickets.priority, userId: tickets.userId })
        .from(tickets)
        .where(eq(tickets.id, t.id));
      expect(row).toEqual({ priority: 'MEDIUM', userId: b.id });
    });

    it('400 on bad bodies, priority/status or an internal note', async () => {
      const ok = { category: 'BILLING', subject: 'x', body: 'y' };
      for (const body of [
        {},
        { ...ok, category: 'URGENT' },
        { ...ok, subject: '  ' },
        { ...ok, subject: 'x'.repeat(201) },
        { ...ok, body: 'x'.repeat(5001) },
        { ...ok, priority: 'HIGH' },
        { ...ok, status: 'RESOLVED' },
      ])
        await create(a, body).expect(400);
      const t = await newTicket(a, 'validation');
      await reply(a, t.id, {}).expect(400);
      await reply(a, t.id, { body: 'x', isInternalNote: true }).expect(400);
      await http()
        .get(`${base(a.workspaceId)}?status=CLOSED`)
        .set('Cookie', a.cookie)
        .expect(400);
    });
  });

  describe('visibility (D1) and tenant isolation', () => {
    let ownerTicket: Detail;
    let modTicket: Detail;
    beforeAll(async () => {
      ownerTicket = await newTicket(a, 'owner visibility');
      modTicket = await newTicket(mod, 'mod visibility', a.workspaceId);
    });

    it('owner sees every workspace ticket, the moderator only their own', async () => {
      const ownerIds = (await list(a, 'take=100')).items.map((i) => i.id);
      expect(ownerIds).toEqual(
        expect.arrayContaining([ownerTicket.id, modTicket.id]),
      );
      const modPage = await list(mod, 'take=100', a.workspaceId);
      expect(modPage.items.map((i) => i.id)).toEqual([modTicket.id]);
      expect(modPage.total).toBe(1);
      expect(modPage.items[0]!.requester).toEqual({
        id: mod.id,
        name: 'm7t2-mod',
      });
      await detail(a, modTicket.id).expect(200);
    });

    it("404 for a moderator on someone else's ticket", async () => {
      await detail(mod, ownerTicket.id, a.workspaceId).expect(404);
      await reply(mod, ownerTicket.id, { body: 'x' }, a.workspaceId).expect(
        404,
      );
    });

    it("404 for another workspace's ticket, unknown or malformed ids", async () => {
      await detail(b, ownerTicket.id).expect(404);
      await reply(b, ownerTicket.id, { body: 'x' }).expect(404);
      await detail(a, UNKNOWN_ID).expect(404);
      await detail(a, 'nope').expect(404);
      // Not a member of A at all → the guard's 404.
      await detail(b, ownerTicket.id, a.workspaceId).expect(404);
      await http().get(base(a.workspaceId)).set('Cookie', b.cookie).expect(404);
      expect((await list(b, 'take=100')).items.map((i) => i.id)).not.toContain(
        ownerTicket.id,
      );
    });
  });

  describe('thread, replies and the list', () => {
    it('never returns internal notes; support shows as "Support"; hasNewReply follows the last public message', async () => {
      const t = await newTicket(a, 'thread');
      await adminReply(t.id, 'We are on it');
      await adminReply(t.id, 'SECRET internal note', true);

      const res = await detail(a, t.id).expect(200);
      const body = res.body as Detail;
      expect(JSON.stringify(body)).not.toContain('SECRET');
      expect(JSON.stringify(body)).not.toContain(superAdmin.id);
      expect(JSON.stringify(body)).not.toContain(superAdmin.email);
      expect(body.messages.map((m) => [m.senderRole, m.body])).toEqual([
        ['CLIENT', 'Help'],
        ['ADMIN', 'We are on it'],
      ]);
      expect(body.messages[1]!.sender).toEqual({ id: null, name: 'Support' });
      expect(body.status).toBe('IN_PROGRESS');
      expect(body.hasNewReply).toBe(true);
      // Activity = the public admin reply, not the later note.
      expect(body.lastMessageAt).toBe(body.messages[1]!.createdAt);

      const listed = (await list(a, 'take=100')).items.find(
        (i) => i.id === t.id,
      );
      expect(listed?.hasNewReply).toBe(true);

      const r = await reply(a, t.id, { body: '  Thanks  ' }).expect(201);
      expect(r.body.message).toMatchObject({
        senderRole: 'CLIENT',
        sender: { id: a.id, name: 'm7t2-a' },
        body: 'Thanks',
      });
      expect(r.body.ticket).toMatchObject({
        id: t.id,
        status: 'IN_PROGRESS',
        hasNewReply: false,
      });
      expect(r.body.message).not.toHaveProperty('isInternalNote');
    });

    it('a reply reopens a RESOLVED ticket and fires ticket.replied', async () => {
      const t = await newTicket(a, 'reopen');
      await adminReply(t.id, 'Fixed');
      await adminStatus(t.id, 'RESOLVED');
      events.length = 0;
      const r = await reply(a, t.id, { body: 'Still broken' }).expect(201);
      expect(r.body.ticket.status).toBe('OPEN');
      expect(events).toEqual([
        {
          ticketId: t.id,
          workspaceId: a.workspaceId,
          messageId: r.body.message.id,
          senderRole: 'CLIENT',
          isInternalNote: false,
        },
      ]);
    });

    it('lists newest activity first, pages and filters by status', async () => {
      const older = await newTicket(b, 'order older');
      const newer = await newTicket(b, 'order newer');
      const first = (await list(b, 'take=100')).items.map((i) => i.id);
      expect(first.indexOf(newer.id)).toBeLessThan(first.indexOf(older.id));

      await reply(b, older.id, { body: 'bump' }).expect(201);
      const page = await list(b, 'take=1');
      expect(page).toMatchObject({ skip: 0, take: 1 });
      expect(page.items.map((i) => i.id)).toEqual([older.id]);
      expect(page.total).toBeGreaterThanOrEqual(2);
      expect((await list(b, 'skip=1&take=1')).items[0]!.id).toBe(newer.id);

      await adminStatus(newer.id, 'RESOLVED');
      const resolved = await list(b, 'status=RESOLVED&take=100');
      expect(resolved.items.map((i) => i.id)).toEqual([newer.id]);
    });
  });

  describe('impersonated session (D2)', () => {
    it('reads (200) but may not create or reply (403 IMPERSONATION_READ_ONLY)', async () => {
      const t = await newTicket(a, 'impersonation');
      const cookie = await actors.signIn(a.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: a.workspaceId,
      });
      const as = { ...a, cookie };
      expect((await list(as, 'take=100')).items.map((i) => i.id)).toContain(
        t.id,
      );
      await detail(as, t.id).expect(200);

      const created = await create(as, {
        category: 'OTHER',
        subject: `${T} blocked`,
        body: 'x',
      }).expect(403);
      expect(created.body.code).toBe('IMPERSONATION_READ_ONLY');
      const replied = await reply(as, t.id, { body: 'x' }).expect(403);
      expect(replied.body.code).toBe('IMPERSONATION_READ_ONLY');
      expect((await detail(a, t.id).expect(200)).body.messages).toHaveLength(1);
    });
  });

  describe('cap (reading 4)', () => {
    it('409 TICKET_LIMIT_REACHED at 20 unresolved; resolved tickets do not count', async () => {
      const c = await actors.signUp('m7t2-cap');
      const seed = (status: TicketStatus, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          workspaceId: c.workspaceId,
          userId: c.id,
          subject: `${T} seed ${status} ${i}`,
          category: 'OTHER' as const,
          status,
        }));
      await db()
        .insert(tickets)
        .values([
          ...seed('OPEN', 10),
          ...seed('IN_PROGRESS', 9),
          ...seed('RESOLVED', 3),
        ]);
      await newTicket(c, 'twentieth');
      const res = await create(c, {
        category: 'OTHER',
        subject: `${T} 21st`,
        body: 'x',
      }).expect(409);
      expect(res.body).toMatchObject({
        code: 'TICKET_LIMIT_REACHED',
        details: { limit: 20 },
      });
      // Other workspaces are unaffected.
      await newTicket(b, 'after cap');
    });
  });
});
