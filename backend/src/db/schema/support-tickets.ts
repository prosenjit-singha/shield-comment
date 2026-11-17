import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth.js';
import { id, timestamps, timestamptz } from './columns.js';
import { workspaces } from './workspaces.js';

/**
 * Support tickets (Module 2 `SupportTicketsModule`, M2-T7; user decisions 2026-11-18).
 * Enums are `text` + check constraints. FKs are `restrict`: tickets and their messages must
 * outlive user/workspace deletes (delete messages, then tickets, then users/workspaces).
 */

/** `TECHNICAL` includes Meta connection and moderation issues. */
export const TICKET_CATEGORIES = [
  'BILLING',
  'TECHNICAL',
  'ACCOUNT',
  'OTHER',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Counted as "open tickets" on the admin dashboard. */
export const UNRESOLVED_TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
] as const satisfies readonly TicketStatus[];

export const TICKET_SENDER_ROLES = ['ADMIN', 'CLIENT'] as const;
export type TicketSenderRole = (typeof TICKET_SENDER_ROLES)[number];

export const TICKET_SUBJECT_MAX = 200;
export const TICKET_MESSAGE_BODY_MAX = 5000;

const inList = (column: string, values: readonly string[]) =>
  sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

export const tickets = pgTable(
  'tickets',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    /** The client user who opened the ticket (the requester). */
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    subject: text().notNull(),
    category: text().$type<TicketCategory>().notNull(),
    priority: text().$type<TicketPriority>().notNull().default('MEDIUM'),
    status: text().$type<TicketStatus>().notNull().default('OPEN'),
    ...timestamps,
  },
  (t) => [
    // The admin list is newest first, optionally filtered by one of these columns.
    index().on(t.createdAt),
    index().on(t.workspaceId, t.createdAt),
    index().on(t.status, t.createdAt),
    index().on(t.priority, t.createdAt),
    index().on(t.category, t.createdAt),
    index().on(t.userId),
    check('tickets_category_check', inList('category', TICKET_CATEGORIES)),
    check('tickets_priority_check', inList('priority', TICKET_PRIORITIES)),
    check('tickets_status_check', inList('status', TICKET_STATUSES)),
    check(
      'tickets_subject_length',
      sql.raw(`char_length(subject) between 1 and ${TICKET_SUBJECT_MAX}`),
    ),
  ],
);

/** Thread entries. Rows are never updated (no `updatedAt`). Internal notes are admin-only. */
export const ticketMessages = pgTable(
  'ticket_messages',
  {
    id: id(),
    ticketId: uuid()
      .notNull()
      .references(() => tickets.id, { onDelete: 'restrict' }),
    senderId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    senderRole: text().$type<TicketSenderRole>().notNull(),
    body: text().notNull(),
    isInternalNote: boolean().notNull().default(false),
    createdAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.ticketId, t.createdAt),
    index().on(t.senderId),
    check(
      'ticket_messages_sender_role_check',
      inList('sender_role', TICKET_SENDER_ROLES),
    ),
    check(
      'ticket_messages_body_length',
      sql.raw(`char_length(body) between 1 and ${TICKET_MESSAGE_BODY_MAX}`),
    ),
    check(
      'ticket_messages_internal_note_admin_only',
      sql.raw(`not is_internal_note or sender_role = 'ADMIN'`),
    ),
  ],
);

export const ticketsRelations = relations(tickets, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [tickets.workspaceId],
    references: [workspaces.id],
  }),
  user: one(users, { fields: [tickets.userId], references: [users.id] }),
  messages: many(ticketMessages),
}));

export const ticketMessagesRelations = relations(ticketMessages, ({ one }) => ({
  ticket: one(tickets, {
    fields: [ticketMessages.ticketId],
    references: [tickets.id],
  }),
  sender: one(users, {
    fields: [ticketMessages.senderId],
    references: [users.id],
  }),
}));
