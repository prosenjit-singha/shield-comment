import type { TicketSenderRole, TicketStatus } from '../db/schema/index.js';

/**
 * Ticket status rules (M2-T7, user decisions 2026-11-18). Pure functions so the admin endpoints
 * and the later client endpoints share one implementation.
 */

/** Statuses a client reply reopens (add `CLOSED` here if it is ever introduced). */
export const REOPENED_BY_CLIENT_REPLY: readonly TicketStatus[] = ['RESOLVED'];

/**
 * Admin status change: free moves (any status → any status, no reason needed), so reopening a
 * RESOLVED ticket is just `→ OPEN`. The same status again is an idempotent no-op.
 */
export function adminStatusChange(
  current: TicketStatus,
  next: TicketStatus,
): { status: TicketStatus; changed: boolean } {
  return { status: next, changed: current !== next };
}

/**
 * The ticket status after a new thread message:
 * - internal notes never change the status;
 * - an admin reply on an OPEN ticket moves it to IN_PROGRESS (the first reply that finds it OPEN,
 *   including after a reopen); admin replies change nothing else;
 * - a client reply reopens a RESOLVED ticket (→ OPEN); client replies change nothing else.
 */
export function statusAfterReply(
  current: TicketStatus,
  senderRole: TicketSenderRole,
  isInternalNote: boolean,
): TicketStatus {
  if (isInternalNote) return current;
  if (senderRole === 'ADMIN')
    return current === 'OPEN' ? 'IN_PROGRESS' : current;
  return REOPENED_BY_CLIENT_REPLY.includes(current) ? 'OPEN' : current;
}
