import { TICKET_STATUSES, type TicketStatus } from '../db/schema/index.js';
import { adminStatusChange, statusAfterReply } from './ticket-status.js';

describe('adminStatusChange (free moves)', () => {
  const pairs = TICKET_STATUSES.flatMap((from) =>
    TICKET_STATUSES.map((to) => [from, to] as const),
  );

  it.each(pairs)('%s → %s is allowed', (from, to) => {
    expect(adminStatusChange(from, to)).toEqual({
      status: to,
      changed: from !== to,
    });
  });

  it('reopens a RESOLVED ticket', () => {
    expect(adminStatusChange('RESOLVED', 'OPEN')).toEqual({
      status: 'OPEN',
      changed: true,
    });
  });
});

describe('statusAfterReply (M2-T14: only the first public admin reply moves OPEN)', () => {
  const admin = (isInternalNote: boolean, hadPublicAdminReply: boolean) => ({
    senderRole: 'ADMIN' as const,
    isInternalNote,
    hadPublicAdminReply,
  });
  const client = { senderRole: 'CLIENT' as const, isInternalNote: false };

  it.each(
    TICKET_STATUSES.flatMap((status) =>
      [false, true].map((had) => [status, had] as const),
    ),
  )(
    'internal notes never change the status (%s, earlier admin reply: %s)',
    (status, had) => {
      expect(statusAfterReply(status, admin(true, had))).toBe(status);
    },
  );

  it.each<[TicketStatus, TicketStatus]>([
    ['OPEN', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
    ['RESOLVED', 'RESOLVED'],
  ])('first public admin reply: %s → %s', (from, to) => {
    expect(statusAfterReply(from, admin(false, false))).toBe(to);
  });

  it.each(TICKET_STATUSES)(
    'later public admin replies never change the status (%s, incl. OPEN after a reopen)',
    (status) => {
      expect(statusAfterReply(status, admin(false, true))).toBe(status);
    },
  );

  it.each<[TicketStatus, TicketStatus]>([
    ['RESOLVED', 'OPEN'],
    ['OPEN', 'OPEN'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
  ])('client reply: %s → %s (reopens resolved tickets)', (from, to) => {
    for (const hadPublicAdminReply of [false, true])
      expect(statusAfterReply(from, { ...client, hadPublicAdminReply })).toBe(
        to,
      );
  });
});
