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

describe('statusAfterReply', () => {
  it.each(TICKET_STATUSES)(
    'internal notes never change the status (%s)',
    (status) => {
      expect(statusAfterReply(status, 'ADMIN', true)).toBe(status);
    },
  );

  it.each<[TicketStatus, TicketStatus]>([
    ['OPEN', 'IN_PROGRESS'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
    ['RESOLVED', 'RESOLVED'],
  ])('admin reply: %s → %s', (from, to) => {
    expect(statusAfterReply(from, 'ADMIN', false)).toBe(to);
  });

  it.each<[TicketStatus, TicketStatus]>([
    ['RESOLVED', 'OPEN'],
    ['OPEN', 'OPEN'],
    ['IN_PROGRESS', 'IN_PROGRESS'],
  ])('client reply: %s → %s (reopens resolved tickets)', (from, to) => {
    expect(statusAfterReply(from, 'CLIENT', false)).toBe(to);
  });
});
