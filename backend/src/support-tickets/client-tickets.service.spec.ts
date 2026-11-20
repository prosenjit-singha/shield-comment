import { ConflictException } from '@nestjs/common';
import {
  assertUnderTicketCap,
  initialTicketPriority,
  MAX_UNRESOLVED_TICKETS,
  requesterFilter,
  SUPPORT_SENDER_NAME,
  toClientItem,
  toClientMessages,
  type TicketRow,
} from './client-tickets.service.js';

const WS = '019a0000-0000-7000-8000-000000000002';
const USER = '019a0000-0000-7000-8000-0000000000cc';
const ADMIN = '019a0000-0000-7000-8000-0000000000aa';
const at = new Date('2026-11-20T00:00:00Z');

describe('requesterFilter (D1)', () => {
  it('limits a moderator to their own tickets', () => {
    expect(
      requesterFilter({ workspaceId: WS, role: 'moderator', userId: USER }),
    ).toBe(USER);
  });

  it('lets owner and admin see every workspace ticket', () => {
    for (const role of ['owner', 'admin'] as const)
      expect(
        requesterFilter({ workspaceId: WS, role, userId: USER }),
      ).toBeUndefined();
  });
});

describe('initialTicketPriority (D3)', () => {
  it('is HIGH with prioritySupportApi (Pro), MEDIUM otherwise', () => {
    expect(initialTicketPriority(true)).toBe('HIGH');
    expect(initialTicketPriority(false)).toBe('MEDIUM');
  });
});

describe('assertUnderTicketCap (reading 4)', () => {
  it('allows up to 19 unresolved tickets', () => {
    expect(() => assertUnderTicketCap(0)).not.toThrow();
    expect(() =>
      assertUnderTicketCap(MAX_UNRESOLVED_TICKETS - 1),
    ).not.toThrow();
  });

  it('409 TICKET_LIMIT_REACHED at 20', () => {
    expect(MAX_UNRESOLVED_TICKETS).toBe(20);
    try {
      assertUnderTicketCap(MAX_UNRESOLVED_TICKETS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        code: 'TICKET_LIMIT_REACHED',
        details: { limit: 20 },
      });
    }
  });
});

describe('toClientMessages', () => {
  const row = (
    id: string,
    senderRole: 'ADMIN' | 'CLIENT',
    isInternalNote = false,
  ) => ({
    id,
    senderRole,
    senderId: senderRole === 'ADMIN' ? ADMIN : USER,
    senderName: senderRole === 'ADMIN' ? 'Rahim (support)' : 'Karim',
    body: `body ${id}`,
    isInternalNote,
    createdAt: at,
  });

  it('drops internal notes', () => {
    const out = toClientMessages([
      row('m1', 'CLIENT'),
      row('m2', 'ADMIN', true),
      row('m3', 'ADMIN'),
    ]);
    expect(out.map((m) => m.id)).toEqual(['m1', 'm3']);
    expect(JSON.stringify(out)).not.toContain('body m2');
  });

  it('shows support as "Support" without the admin id, keeps the client sender', () => {
    const [client, admin] = toClientMessages([
      row('m1', 'CLIENT'),
      row('m2', 'ADMIN'),
    ]);
    expect(client!.sender).toEqual({ id: USER, name: 'Karim' });
    expect(admin!.sender).toEqual({ id: null, name: SUPPORT_SENDER_NAME });
    expect(JSON.stringify(admin)).not.toContain(ADMIN);
    expect(admin).not.toHaveProperty('isInternalNote');
  });
});

describe('toClientItem (reading 3)', () => {
  const ticket: TicketRow = {
    id: 't1',
    subject: 'bKash refund',
    category: 'BILLING',
    status: 'OPEN',
    createdAt: at,
    updatedAt: at,
    requesterId: USER,
    requesterName: 'Karim',
    lastMessageAt: at,
  };

  it('hasNewReply only when the newest public message is from support', () => {
    expect(toClientItem(ticket, 'ADMIN').hasNewReply).toBe(true);
    expect(toClientItem(ticket, 'CLIENT').hasNewReply).toBe(false);
    expect(toClientItem(ticket, undefined).hasNewReply).toBe(false);
  });

  it('has no priority and no requester email', () => {
    const item = toClientItem(ticket, 'CLIENT');
    expect(item).not.toHaveProperty('priority');
    expect(item.requester).toEqual({ id: USER, name: 'Karim' });
  });
});
