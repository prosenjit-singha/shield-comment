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

/** What `statusAfterReply()` needs to know about the new thread message. */
export interface TicketReply {
  senderRole: TicketSenderRole;
  isInternalNote: boolean;
  /**
   * Whether the ticket already had a public (non-internal) ADMIN message before this one. Only
   * read for public admin replies; derived from `ticket_messages` under the ticket's row lock.
   */
  hadPublicAdminReply: boolean;
}

/**
 * The ticket status after a new thread message (M2-T14, user decision 2026-11-18):
 * - internal notes never change the status;
 * - only the **first** public admin reply a ticket ever gets moves it OPEN → IN_PROGRESS; after
 *   that no admin reply changes the status (even after an admin reopens it: later moves are
 *   manual only). A first reply that finds the ticket in any other status changes nothing;
 * - a client reply reopens a RESOLVED ticket (→ OPEN); client replies change nothing else.
 */
export function statusAfterReply(
  current: TicketStatus,
  reply: TicketReply,
): TicketStatus {
  if (reply.isInternalNote) return current;
  if (reply.senderRole === 'ADMIN')
    return current === 'OPEN' && !reply.hadPublicAdminReply
      ? 'IN_PROGRESS'
      : current;
  return REOPENED_BY_CLIENT_REPLY.includes(current) ? 'OPEN' : current;
}
