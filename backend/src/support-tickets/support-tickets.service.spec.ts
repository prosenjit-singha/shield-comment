import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import {
  ticketMessages,
  tickets,
  type TicketStatus,
} from '../db/schema/index.js';
import {
  SupportTicketsService,
  type TicketListItem,
  type TicketMessageItem,
} from './support-tickets.service.js';
import { TicketEvents, type TicketRepliedEvent } from './ticket-events.js';

const TICKET = '019a0000-0000-7000-8000-000000000001';
const WS = '019a0000-0000-7000-8000-000000000002';
const ADMIN = '019a0000-0000-7000-8000-0000000000aa';
const CLIENT = '019a0000-0000-7000-8000-0000000000cc';
const MESSAGE = '019a0000-0000-7000-8000-0000000000ee';

/** Just enough of a Drizzle transaction for `addMessage` / `updateStatus`. */
function fakeDb(
  current: { status: TicketStatus } | undefined,
  opts: { failInsert?: boolean; hadPublicAdminReply?: boolean } = {},
) {
  const updates: unknown[] = [];
  const inserts: unknown[] = [];
  /** Order of the transaction's statements (lock → prior-reply lookup → insert → update). */
  const steps: string[] = [];
  let committed = false;
  const tx = {
    select: () => ({
      from: (table: unknown) => {
        if (table === ticketMessages)
          return {
            where: () => ({
              limit: async (n: number) => {
                expect(n).toBe(1);
                steps.push('prior-admin-reply');
                return opts.hadPublicAdminReply ? [{ id: 'earlier' }] : [];
              },
            }),
          };
        expect(table).toBe(tickets);
        return {
          where: () => ({
            for: async (mode: string) => {
              expect(mode).toBe('update');
              steps.push('lock');
              return current
                ? [{ id: TICKET, workspaceId: WS, status: current.status }]
                : [];
            },
          }),
        };
      },
    }),
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        returning: async () => {
          if (opts.failInsert) throw new Error('insert failed');
          steps.push('insert');
          inserts.push({ table, values });
          return [{ id: MESSAGE }];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: unknown) => ({
        where: async () => {
          steps.push('update');
          updates.push({ table, patch });
        },
      }),
    }),
  };
  const db = {
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      const result = await fn(tx);
      committed = true;
      return result;
    },
  };
  return {
    db: db as unknown as Database,
    updates,
    inserts,
    steps,
    committed: () => committed,
  };
}

function service(fake: ReturnType<typeof fakeDb>) {
  const events = new TicketEvents();
  const svc = new SupportTicketsService(fake.db, events);
  const ticket = { id: TICKET } as TicketListItem;
  const message = { id: MESSAGE } as TicketMessageItem;
  vi.spyOn(svc, 'findItem').mockResolvedValue(ticket);
  vi.spyOn(
    svc as unknown as {
      selectMessages: () => Promise<TicketMessageItem[]>;
    },
    'selectMessages',
  ).mockResolvedValue([message]);
  const fired: { event: TicketRepliedEvent; committed: boolean }[] = [];
  events.onReplied((event) => {
    fired.push({ event, committed: fake.committed() });
  });
  return { svc, ticket, message, fired };
}

const reply = (overrides: Partial<{ isInternalNote: boolean }> = {}) => ({
  senderId: ADMIN,
  senderRole: 'ADMIN' as const,
  body: 'We are on it',
  isInternalNote: false,
  ...overrides,
});

describe('SupportTicketsService.addMessage', () => {
  it('first public admin reply on an OPEN ticket: inserts the message and moves it to IN_PROGRESS in the same transaction', async () => {
    const fake = fakeDb({ status: 'OPEN' });
    const { svc, ticket, message } = service(fake);
    await expect(svc.addMessage(TICKET, reply())).resolves.toEqual({
      message,
      ticket,
    });
    expect(fake.inserts).toEqual([
      {
        table: ticketMessages,
        values: {
          ticketId: TICKET,
          senderId: ADMIN,
          senderRole: 'ADMIN',
          body: 'We are on it',
          isInternalNote: false,
        },
      },
    ]);
    expect(fake.updates).toEqual([
      { table: tickets, patch: { status: 'IN_PROGRESS' } },
    ]);
    // The earlier-reply lookup runs under the row lock, before the new message is inserted.
    expect(fake.steps).toEqual([
      'lock',
      'prior-admin-reply',
      'insert',
      'update',
    ]);
  });

  it.each<TicketStatus>(['IN_PROGRESS', 'RESOLVED'])(
    'first public admin reply on %s: no status change',
    async (status) => {
      const fake = fakeDb({ status });
      const { svc } = service(fake);
      await svc.addMessage(TICKET, reply());
      expect(fake.inserts).toHaveLength(1);
      expect(fake.updates).toEqual([]);
    },
  );

  it.each<TicketStatus>(['OPEN', 'IN_PROGRESS', 'RESOLVED'])(
    'later public admin reply on %s (the ticket already had one): no status change',
    async (status) => {
      const fake = fakeDb({ status }, { hadPublicAdminReply: true });
      const { svc } = service(fake);
      await svc.addMessage(TICKET, reply());
      expect(fake.steps).toEqual(['lock', 'prior-admin-reply', 'insert']);
      expect(fake.updates).toEqual([]);
    },
  );

  it('internal note on an OPEN ticket: no status change, no earlier-reply lookup', async () => {
    const fake = fakeDb({ status: 'OPEN' });
    const { svc } = service(fake);
    await svc.addMessage(TICKET, reply({ isInternalNote: true }));
    expect(fake.inserts).toHaveLength(1);
    expect(fake.updates).toEqual([]);
    expect(fake.steps).toEqual(['lock', 'insert']);
  });

  it('client reply reopens a RESOLVED ticket (reusable for the client endpoint)', async () => {
    const fake = fakeDb({ status: 'RESOLVED' });
    const { svc, fired } = service(fake);
    await svc.addMessage(TICKET, {
      senderId: CLIENT,
      senderRole: 'CLIENT',
      body: 'Still broken',
      isInternalNote: false,
    });
    expect(fake.updates).toEqual([
      { table: tickets, patch: { status: 'OPEN' } },
    ]);
    expect(fake.steps).toEqual(['lock', 'insert', 'update']);
    expect(fired[0]?.event.senderRole).toBe('CLIENT');
  });

  it('refuses client internal notes before touching the database', async () => {
    const fake = fakeDb({ status: 'OPEN' });
    const { svc, fired } = service(fake);
    await expect(
      svc.addMessage(TICKET, {
        senderId: CLIENT,
        senderRole: 'CLIENT',
        body: 'x',
        isInternalNote: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(fake.inserts).toEqual([]);
    expect(fired).toEqual([]);
  });

  it('emits ticket.replied once, after the commit, with the payload', async () => {
    const fake = fakeDb({ status: 'OPEN' });
    const { svc, fired } = service(fake);
    await svc.addMessage(TICKET, reply({ isInternalNote: true }));
    expect(fired).toEqual([
      {
        committed: true,
        event: {
          ticketId: TICKET,
          workspaceId: WS,
          messageId: MESSAGE,
          senderRole: 'ADMIN',
          isInternalNote: true,
        },
      },
    ]);
  });

  it('404 for an unknown ticket: nothing written, no event', async () => {
    const fake = fakeDb(undefined);
    const { svc, fired } = service(fake);
    await expect(svc.addMessage(TICKET, reply())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fake.inserts).toEqual([]);
    expect(fired).toEqual([]);
  });

  it('404 for a malformed id', async () => {
    const fake = fakeDb({ status: 'OPEN' });
    const { svc, fired } = service(fake);
    await expect(svc.addMessage('nope', reply())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(fired).toEqual([]);
  });

  it('no event when the transaction fails', async () => {
    const fake = fakeDb({ status: 'OPEN' }, { failInsert: true });
    const { svc, fired } = service(fake);
    await expect(svc.addMessage(TICKET, reply())).rejects.toThrow(
      'insert failed',
    );
    expect(fake.committed()).toBe(false);
    expect(fired).toEqual([]);
  });
});

describe('SupportTicketsService.updateStatus', () => {
  it('changes the status (reopen RESOLVED → OPEN)', async () => {
    const fake = fakeDb({ status: 'RESOLVED' });
    const { svc, ticket } = service(fake);
    await expect(svc.updateStatus(TICKET, 'OPEN')).resolves.toEqual({
      ticket,
      changed: true,
    });
    expect(fake.updates).toEqual([
      { table: tickets, patch: { status: 'OPEN' } },
    ]);
  });

  it('same status = no-op', async () => {
    const fake = fakeDb({ status: 'IN_PROGRESS' });
    const { svc, ticket } = service(fake);
    await expect(svc.updateStatus(TICKET, 'IN_PROGRESS')).resolves.toEqual({
      ticket,
      changed: false,
    });
    expect(fake.updates).toEqual([]);
  });

  it('404 for unknown and malformed ids', async () => {
    const { svc } = service(fakeDb(undefined));
    await expect(svc.updateStatus(TICKET, 'OPEN')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(svc.updateStatus('1 or 1=1', 'OPEN')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('TicketEvents', () => {
  const event: TicketRepliedEvent = {
    ticketId: TICKET,
    workspaceId: WS,
    messageId: MESSAGE,
    senderRole: 'ADMIN',
    isInternalNote: false,
  };

  it('a failing listener is logged and does not stop the others', async () => {
    const events = new TicketEvents();
    const seen: string[] = [];
    events.onReplied(() => {
      throw new Error('sync boom');
    });
    events.onReplied(async () => {
      await Promise.resolve();
      throw new Error('async boom');
    });
    events.onReplied(() => {
      seen.push('ok');
    });
    const log = vi
      .spyOn(
        (events as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    expect(() => events.emitReplied(event)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toEqual(['ok']);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops delivery', () => {
    const events = new TicketEvents();
    const listener = vi.fn();
    const off = events.onReplied(listener);
    off();
    events.emitReplied(event);
    expect(listener).not.toHaveBeenCalled();
  });
});
