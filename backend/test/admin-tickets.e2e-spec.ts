import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { count, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import type { DashboardStatsResponse } from '../src/admin/dto/dashboard-stats.dto.js';
import {
  ticketMessages,
  tickets,
  UNRESOLVED_TICKET_STATUSES,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '../src/db/schema/index.js';
import {
  TicketEvents,
  type TicketRepliedEvent,
} from '../src/support-tickets/ticket-events.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const TICKETS = '/api/admin/tickets';
const STATS = '/api/admin/dashboard/stats';
const UNKNOWN_ID = '019a0000-0000-7000-8000-00000000dead';

interface Item {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  workspace: { id: string; name: string };
  requester: { id: string; name: string; email: string };
  lastMessageAt: string | null;
  messageCount: number;
}
interface Message {
  id: string;
  senderRole: 'ADMIN' | 'CLIENT';
  sender: { id: string; name: string; email: string };
  body: string;
  isInternalNote: boolean;
  createdAt: string;
}

/**
 * M2-T7: admin ticket inbox. Client-side ticket creation comes later, so tickets and client
 * messages are seeded directly in the DB.
 */
describe('Admin support tickets (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();
  const db = () => actors.db;

  // Random tag in every subject, so `q` scopes list queries to this spec's rows.
  const T = `m2t7${randomBytes(4).toString('hex')}`;

  let superAdmin: Actor;
  let a: Actor;
  let b: Actor;
  /** Seeded tickets by key (created 1–5 Jan 2026, t5 newest). */
  const t: Record<'t1' | 't2' | 't3' | 't4' | 't5', string> = {
    t1: '',
    t2: '',
    t3: '',
    t4: '',
    t5: '',
  };
  const events: TicketRepliedEvent[] = [];

  const at = (iso: string) => new Date(iso);
  async function seedTicket(
    owner: Actor,
    subject: string,
    category: TicketCategory,
    priority: TicketPriority,
    status: TicketStatus,
    createdAt: string,
  ) {
    const [row] = await db()
      .insert(tickets)
      .values({
        workspaceId: owner.workspaceId,
        userId: owner.id,
        subject: `${T} ${subject}`,
        category,
        priority,
        status,
        createdAt: at(createdAt),
        updatedAt: at(createdAt),
      })
      .returning({ id: tickets.id });
    return row!.id;
  }
  const list = async (query: string, cookie = superAdmin.cookie) => {
    const res = await http()
      .get(`${TICKETS}?${query}`)
      .set('Cookie', cookie)
      .expect(200);
    return res.body as {
      items: Item[];
      total: number;
      skip: number;
      take: number;
    };
  };
  const ids = (items: Item[]) => items.map((i) => i.id);
  const statusOf = async (id: string) => {
    const [row] = await db()
      .select({ status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, id));
    return row!.status;
  };
  const messageCount = async (id: string) => {
    const [row] = await db()
      .select({ n: count() })
      .from(ticketMessages)
      .where(eq(ticketMessages.ticketId, id));
    return row!.n;
  };
  const reply = (id: string, body: unknown) =>
    http()
      .post(`${TICKETS}/${id}/reply`)
      .set('Cookie', superAdmin.cookie)
      .send(body as object);
  const setStatus = (id: string, body: unknown) =>
    http()
      .patch(`${TICKETS}/${id}/status`)
      .set('Cookie', superAdmin.cookie)
      .send(body as object);
  const openTicketsKpi = async () => {
    const res = await http()
      .get(`${STATS}?range=7d`)
      .set('Cookie', superAdmin.cookie)
      .expect(200);
    return (res.body as DashboardStatsResponse).kpis.openTickets;
  };
  const unresolvedInDb = async () => {
    const [row] = await db()
      .select({ n: count() })
      .from(tickets)
      .where(inArray(tickets.status, [...UNRESOLVED_TICKET_STATUSES]));
    return row!.n;
  };

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    app.get(TicketEvents).onReplied((e) => {
      events.push(e);
    });
    superAdmin = await actors.signUpSuperAdmin('m2t7-super');
    a = await actors.signUp('m2t7-a');
    b = await actors.signUp('m2t7-b');

    t.t1 = await seedTicket(
      a,
      'bKash refund missing',
      'BILLING',
      'HIGH',
      'OPEN',
      '2026-01-01T00:00:00Z',
    );
    t.t2 = await seedTicket(
      a,
      'Meta page disconnected',
      'TECHNICAL',
      'MEDIUM',
      'IN_PROGRESS',
      '2026-01-02T00:00:00Z',
    );
    t.t3 = await seedTicket(
      b,
      'Cannot log in',
      'ACCOUNT',
      'LOW',
      'RESOLVED',
      '2026-01-03T00:00:00Z',
    );
    t.t4 = await seedTicket(
      b,
      'Other question, 100% sure',
      'OTHER',
      'MEDIUM',
      'OPEN',
      '2026-01-04T00:00:00Z',
    );
    t.t5 = await seedTicket(
      a,
      'BKASH scam comments not hidden',
      'TECHNICAL',
      'HIGH',
      'OPEN',
      '2026-01-05T00:00:00Z',
    );

    // t1 thread, inserted out of order: client 01:00, admin note 02:00, client 03:00.
    await db()
      .insert(ticketMessages)
      .values([
        {
          ticketId: t.t1,
          senderId: a.id,
          senderRole: 'CLIENT',
          body: 'Third',
          createdAt: at('2026-01-01T03:00:00Z'),
        },
        {
          ticketId: t.t1,
          senderId: a.id,
          senderRole: 'CLIENT',
          body: 'First',
          createdAt: at('2026-01-01T01:00:00Z'),
        },
        {
          ticketId: t.t1,
          senderId: superAdmin.id,
          senderRole: 'ADMIN',
          body: 'Second (note)',
          isInternalNote: true,
          createdAt: at('2026-01-01T02:00:00Z'),
        },
      ]);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  describe('access', () => {
    const routes = () =>
      [
        ['get', TICKETS],
        ['get', `${TICKETS}/${t.t1}`],
        ['post', `${TICKETS}/${t.t1}/reply`],
        ['patch', `${TICKETS}/${t.t1}/status`],
      ] as const;

    it('401 without a session', async () => {
      for (const [method, path] of routes()) {
        const res = await http()
          [method](path)
          .send({ body: 'x', status: 'OPEN' });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    });

    it('403 for a workspace owner', async () => {
      for (const [method, path] of routes()) {
        const res = await http()
          [method](path)
          .set('Cookie', a.cookie)
          .send({ body: 'x', status: 'RESOLVED' });
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(res.body).toMatchObject({ message: 'Super admin only' });
      }
    });

    it('403 for impersonated sessions (super admin or client)', async () => {
      const adminCookie = await actors.signIn(superAdmin.email);
      await actors.patchStoredSession(adminCookie, {
        impersonatedBy: superAdmin.id,
      });
      const ownerCookie = await actors.signIn(a.email);
      await actors.patchStoredSession(ownerCookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: a.workspaceId,
      });
      for (const cookie of [adminCookie, ownerCookie]) {
        for (const [method, path] of routes()) {
          const res = await http()
            [method](path)
            .set('Cookie', cookie)
            .send({ body: 'x', status: 'RESOLVED' });
          expect(res.status, `${method} ${path}`).toBe(403);
        }
      }
      // Nothing was written by the refused requests.
      expect(await statusOf(t.t1)).toBe('OPEN');
      expect(await messageCount(t.t1)).toBe(3);
    });
  });

  describe('GET /api/admin/tickets', () => {
    it('newest first with workspace, requester, last message time and message count', async () => {
      const page = await list(`q=${T}`);
      expect(page).toMatchObject({ total: 5, skip: 0, take: 50 });
      expect(ids(page.items)).toEqual([t.t5, t.t4, t.t3, t.t2, t.t1]);
      const t1 = page.items.find((i) => i.id === t.t1)!;
      expect(t1).toEqual({
        id: t.t1,
        subject: `${T} bKash refund missing`,
        category: 'BILLING',
        priority: 'HIGH',
        status: 'OPEN',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspace: { id: a.workspaceId, name: expect.any(String) as string },
        requester: { id: a.id, name: 'm2t7-a', email: a.email },
        lastMessageAt: '2026-01-01T03:00:00.000Z',
        messageCount: 3,
      });
      const t2 = page.items.find((i) => i.id === t.t2)!;
      expect(t2).toMatchObject({ lastMessageAt: null, messageCount: 0 });
    });

    it.each([
      ['status=OPEN', ['t5', 't4', 't1']],
      ['status=IN_PROGRESS', ['t2']],
      ['status=RESOLVED', ['t3']],
      ['category=TECHNICAL', ['t5', 't2']],
      ['category=BILLING', ['t1']],
      ['priority=HIGH', ['t5', 't1']],
      ['priority=LOW', ['t3']],
      ['status=OPEN&priority=HIGH&category=BILLING', ['t1']],
    ] as const)('filter %s', async (query, expected) => {
      const page = await list(`q=${T}&${query}`);
      expect(ids(page.items)).toEqual(expected.map((k) => t[k]));
      expect(page.total).toBe(expected.length);
    });

    it('workspace filter', async () => {
      expect(ids((await list(`workspaceId=${b.workspaceId}`)).items)).toEqual([
        t.t4,
        t.t3,
      ]);
      expect(
        ids((await list(`workspaceId=${a.workspaceId}&status=OPEN`)).items),
      ).toEqual([t.t5, t.t1]);
      expect((await list(`workspaceId=${UNKNOWN_ID}`)).items).toEqual([]);
    });

    it('q is a case-insensitive partial subject match; % and _ are literal', async () => {
      expect(
        ids((await list(`q=${encodeURIComponent(`${T} bkash refund`)}`)).items),
      ).toEqual([t.t1]);
      expect(
        ids((await list(`q=${encodeURIComponent('BKASH SCAM')}`)).items),
      ).toEqual([t.t5]);
      const all = await list(`q=${encodeURIComponent(' bKaSh ')}`);
      expect(ids(all.items)).toEqual([t.t5, t.t1]);
      expect(
        ids((await list(`q=${encodeURIComponent('100%')}`)).items),
      ).toEqual([t.t4]);
      expect((await list(`q=${encodeURIComponent('1_0')}`)).items).toEqual([]);
    });

    it('pagination keeps the order and the filtered total', async () => {
      const p1 = await list(`q=${T}&take=2`);
      const p2 = await list(`q=${T}&take=2&skip=2`);
      const p3 = await list(`q=${T}&take=2&skip=4`);
      expect([p1.total, p2.total, p3.total]).toEqual([5, 5, 5]);
      expect(ids(p1.items)).toEqual([t.t5, t.t4]);
      expect(ids(p2.items)).toEqual([t.t3, t.t2]);
      expect(ids(p3.items)).toEqual([t.t1]);
      expect(p3).toMatchObject({ skip: 4, take: 2 });
      expect((await list(`q=${T}&take=100`)).items).toHaveLength(5);
    });

    it.each([
      'take=0',
      'take=101',
      'skip=-1',
      'take=abc',
      'status=CLOSED',
      'status=open',
      'category=META',
      'priority=URGENT',
      'workspaceId=not-a-uuid',
      `q=${'x'.repeat(101)}`,
      'sort=oldest',
    ])('400 for %s', async (query) => {
      const res = await http()
        .get(`${TICKETS}?${query}`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
      expect(res.body).toMatchObject({
        statusCode: 400,
        path: `${TICKETS}?${query}`,
      });
    });
  });

  describe('GET /api/admin/tickets/:id', () => {
    it('ticket + thread oldest first, internal notes included', async () => {
      const res = await http()
        .get(`${TICKETS}/${t.t1}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const body = res.body as Item & { messages: Message[] };
      expect(body).toMatchObject({
        id: t.t1,
        status: 'OPEN',
        messageCount: 3,
        requester: { id: a.id },
      });
      expect(body.messages.map((m) => m.body)).toEqual([
        'First',
        'Second (note)',
        'Third',
      ]);
      expect(body.messages[1]).toEqual({
        id: expect.any(String) as string,
        senderRole: 'ADMIN',
        sender: {
          id: superAdmin.id,
          name: 'm2t7-super',
          email: superAdmin.email,
        },
        body: 'Second (note)',
        isInternalNote: true,
        createdAt: '2026-01-01T02:00:00.000Z',
      });
      expect(body.messages[0]).toMatchObject({
        senderRole: 'CLIENT',
        isInternalNote: false,
        sender: { id: a.id },
      });
    });

    it('empty thread', async () => {
      const res = await http()
        .get(`${TICKETS}/${t.t2}`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(res.body).toMatchObject({ id: t.t2, messages: [] });
    });

    it.each([UNKNOWN_ID, 'not-a-uuid', "1' or '1'='1"])(
      '404 for %s',
      async (id) => {
        const res = await http()
          .get(`${TICKETS}/${encodeURIComponent(id)}`)
          .set('Cookie', superAdmin.cookie)
          .expect(404);
        expect(res.body).toMatchObject({
          statusCode: 404,
          message: 'Ticket not found',
        });
      },
    );
  });

  describe('POST /api/admin/tickets/:id/reply', () => {
    it('admin reply on an OPEN ticket moves it to IN_PROGRESS and emits ticket.replied', async () => {
      events.length = 0;
      const res = await reply(t.t5, { body: '  We are checking it  ' }).expect(
        201,
      );
      const { message, ticket } = res.body as {
        message: Message;
        ticket: Item;
      };
      expect(message).toMatchObject({
        senderRole: 'ADMIN',
        sender: { id: superAdmin.id, email: superAdmin.email },
        body: 'We are checking it',
        isInternalNote: false,
      });
      expect(ticket).toMatchObject({
        id: t.t5,
        status: 'IN_PROGRESS',
        messageCount: 1,
        lastMessageAt: message.createdAt,
      });
      expect(await statusOf(t.t5)).toBe('IN_PROGRESS');
      expect(events).toEqual([
        {
          ticketId: t.t5,
          workspaceId: a.workspaceId,
          messageId: message.id,
          senderRole: 'ADMIN',
          isInternalNote: false,
        },
      ]);
      // The next reply leaves IN_PROGRESS alone.
      await reply(t.t5, { body: 'Fixed?' }).expect(201);
      expect(await statusOf(t.t5)).toBe('IN_PROGRESS');
      expect(await messageCount(t.t5)).toBe(2);
    });

    it('internal note does not change the status', async () => {
      events.length = 0;
      const res = await reply(t.t4, {
        body: 'Asked billing',
        isInternalNote: true,
      }).expect(201);
      expect(res.body).toMatchObject({
        message: { isInternalNote: true, body: 'Asked billing' },
        ticket: { id: t.t4, status: 'OPEN', messageCount: 1 },
      });
      expect(await statusOf(t.t4)).toBe('OPEN');
      expect(events).toEqual([
        expect.objectContaining({ ticketId: t.t4, isInternalNote: true }),
      ]);
    });

    it('reply on a RESOLVED ticket keeps it RESOLVED', async () => {
      await reply(t.t3, {
        body: 'Glad it works',
        isInternalNote: false,
      }).expect(201);
      expect(await statusOf(t.t3)).toBe('RESOLVED');
    });

    it.each([
      {},
      { body: '' },
      { body: '    ' },
      { body: 42 },
      { body: 'x'.repeat(5001) },
      { body: 'ok', isInternalNote: 'yes' },
      { body: 'ok', senderRole: 'CLIENT' },
    ])('400 for %j (nothing written, no event)', async (body) => {
      events.length = 0;
      const before = await messageCount(t.t1);
      const res = await reply(t.t1, body).expect(400);
      expect(res.body).toMatchObject({ statusCode: 400 });
      expect(await messageCount(t.t1)).toBe(before);
      expect(await statusOf(t.t1)).toBe('OPEN');
      expect(events).toEqual([]);
    });

    it('accepts a 5000-character body', async () => {
      await reply(t.t2, {
        body: 'y'.repeat(5000),
        isInternalNote: true,
      }).expect(201);
    });

    it.each([UNKNOWN_ID, 'not-a-uuid'])('404 for %s', async (id) => {
      events.length = 0;
      await reply(id, { body: 'hello' }).expect(404);
      expect(events).toEqual([]);
    });
  });

  describe('PATCH /api/admin/tickets/:id/status', () => {
    it('reopens a RESOLVED ticket; same status again is a no-op', async () => {
      const res = await setStatus(t.t3, { status: 'OPEN' }).expect(200);
      expect(res.body).toMatchObject({
        changed: true,
        ticket: { id: t.t3, status: 'OPEN' },
      });
      expect(await statusOf(t.t3)).toBe('OPEN');
      const [{ updatedAt }] = await db()
        .select({ updatedAt: tickets.updatedAt })
        .from(tickets)
        .where(eq(tickets.id, t.t3));
      const again = await setStatus(t.t3, { status: 'OPEN' }).expect(200);
      expect(again.body).toMatchObject({
        changed: false,
        ticket: { status: 'OPEN', updatedAt: updatedAt.toISOString() },
      });
    });

    it('free moves: OPEN → RESOLVED → IN_PROGRESS → OPEN', async () => {
      for (const status of ['RESOLVED', 'IN_PROGRESS', 'OPEN'] as const) {
        const res = await setStatus(t.t1, { status }).expect(200);
        expect(res.body).toMatchObject({ changed: true, ticket: { status } });
        expect(await statusOf(t.t1)).toBe(status);
      }
    });

    it.each([
      {},
      { status: 'CLOSED' },
      { status: 'resolved' },
      { status: 'OPEN', reason: 'x' },
    ])('400 for %j', async (body) => {
      await setStatus(t.t2, body).expect(400);
      expect(await statusOf(t.t2)).toBe('IN_PROGRESS');
    });

    it.each([UNKNOWN_ID, 'not-a-uuid'])('404 for %s', async (id) => {
      await setStatus(id, { status: 'OPEN' }).expect(404);
    });
  });

  describe('dashboard openTickets', () => {
    it('counts OPEN + IN_PROGRESS tickets', async () => {
      // Now: t1 OPEN, t2 IN_PROGRESS, t3 OPEN, t4 OPEN, t5 IN_PROGRESS.
      expect(await unresolvedInDb()).toBe(5);
      expect(await openTicketsKpi()).toBe(5);
      await setStatus(t.t3, { status: 'RESOLVED' }).expect(200);
      await setStatus(t.t5, { status: 'RESOLVED' }).expect(200);
      expect(await openTicketsKpi()).toBe(3);
      await setStatus(t.t5, { status: 'IN_PROGRESS' }).expect(200);
      expect(await openTicketsKpi()).toBe(4);
    });
  });
});
