import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  max,
  type SQL,
} from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import { escapeLike } from '../admin/client-list-query.js';
import type { Database } from '../db/database.js';
import {
  ticketAttachments,
  ticketMessages,
  tickets,
  users,
  workspaces,
  type TicketCategory,
  type TicketPriority,
  type TicketSenderRole,
  type TicketStatus,
} from '../db/schema/index.js';
import { UUID } from './dto/tickets.dto.js';
import {
  type AttachmentView,
  TicketAttachmentsService,
  type ValidImage,
} from './ticket-attachments.js';
import { TicketEvents, type TicketRepliedEvent } from './ticket-events.js';
import { adminStatusChange, statusAfterReply } from './ticket-status.js';

export interface TicketPerson {
  id: string;
  name: string;
  email: string;
}

export interface TicketListItem {
  id: string;
  subject: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  workspace: { id: string; name: string };
  /** The client user who opened the ticket. */
  requester: TicketPerson;
  /** Newest thread message (internal notes included), `null` for an empty thread. */
  lastMessageAt: Date | null;
  /** Every thread message, internal notes included. */
  messageCount: number;
}

export interface TicketMessageItem {
  id: string;
  senderRole: TicketSenderRole;
  sender: TicketPerson;
  body: string;
  isInternalNote: boolean;
  createdAt: Date;
  /** D4 screenshots (M7-T3), presigned URLs. */
  attachments: AttachmentView[];
}

export type TicketDetail = TicketListItem & { messages: TicketMessageItem[] };

export interface TicketListQuery {
  skip: number;
  take: number;
  status?: TicketStatus;
  category?: TicketCategory;
  priority?: TicketPriority;
  workspaceId?: string;
  q?: string;
}

export interface NewTicketMessage {
  senderId: string;
  senderRole: TicketSenderRole;
  body: string;
  isInternalNote: boolean;
  /** Already validated (`validateAttachments()`); stored before the transaction (M7-T3). */
  images?: readonly ValidImage[];
}

const ticketRow = {
  id: tickets.id,
  subject: tickets.subject,
  category: tickets.category,
  priority: tickets.priority,
  status: tickets.status,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
  workspaceId: tickets.workspaceId,
  workspaceName: workspaces.name,
  requesterId: users.id,
  requesterName: users.name,
  requesterEmail: users.email,
};

const notFound = () => new NotFoundException('Ticket not found');

/**
 * Support tickets (M2-T7). The admin methods are cross-tenant by design (only reachable through
 * `SuperAdminGuard`); thread lookups are scoped to one ticket or the page's ticket ids. Client
 * endpoints (later module) must scope by `workspace_id` and reuse `addMessage()`.
 */
@Injectable()
export class SupportTicketsService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly events: TicketEvents,
    private readonly attachments: TicketAttachmentsService,
  ) {}

  /** `{ items, total, skip, take }`, newest first; `total` counts every match of the filters. */
  async list(query: TicketListQuery) {
    const { skip, take } = query;
    const conditions: SQL[] = [];
    if (query.status) conditions.push(eq(tickets.status, query.status));
    if (query.category) conditions.push(eq(tickets.category, query.category));
    if (query.priority) conditions.push(eq(tickets.priority, query.priority));
    if (query.workspaceId)
      conditions.push(eq(tickets.workspaceId, query.workspaceId));
    if (query.q)
      conditions.push(ilike(tickets.subject, `%${escapeLike(query.q)}%`));
    const where = conditions.length ? and(...conditions) : undefined;

    const [page, [totals]] = await Promise.all([
      this.selectItems(where, skip, take),
      this.db.select({ total: count() }).from(tickets).where(where),
    ]);
    return { items: page, total: totals?.total ?? 0, skip, take };
  }

  /** One ticket + its whole thread (oldest first, internal notes included). 404 unknown/malformed. */
  async detail(ticketId: string): Promise<TicketDetail> {
    if (!UUID.test(ticketId)) throw notFound();
    const ticket = await this.findItem(ticketId);
    if (!ticket) throw notFound();
    const messages = await this.selectMessages(
      eq(ticketMessages.ticketId, ticketId),
    );
    return { ...ticket, messages };
  }

  /**
   * Adds a thread message and applies `statusAfterReply()` in one transaction (the ticket row is
   * locked first; "first public admin reply" is derived from the existing `ticket_messages`, no
   * extra column). After the commit, emits `ticket.replied`. Used by the admin reply endpoint now
   * and by the client reply endpoint later (a client reply reopens a RESOLVED ticket).
   */
  async addMessage(
    ticketId: string,
    input: NewTicketMessage,
  ): Promise<{ message: TicketMessageItem; ticket: TicketListItem }> {
    if (!UUID.test(ticketId)) throw notFound();
    if (input.isInternalNote && input.senderRole !== 'ADMIN')
      throw new BadRequestException('Only admins can add internal notes');
    const images = input.images ?? [];
    // With images, 404 before anything is uploaded; the id is needed for the object keys.
    const messageId = images.length ? uuidv7() : undefined;
    if (images.length) {
      const [exists] = await this.db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.id, ticketId));
      if (!exists) throw notFound();
    }

    const event = await this.attachments.withUploads(
      ticketId,
      messageId ?? '',
      images,
      (staged) =>
        this.db.transaction(async (tx): Promise<TicketRepliedEvent> => {
          const [current] = await tx
            .select({
              id: tickets.id,
              workspaceId: tickets.workspaceId,
              status: tickets.status,
            })
            .from(tickets)
            .where(eq(tickets.id, ticketId))
            .for('update');
          if (!current) throw notFound();
          // Read before the insert and under the row lock, so concurrent first replies serialise:
          // the second one sees the first one's committed message.
          const hadPublicAdminReply =
            input.senderRole === 'ADMIN' && !input.isInternalNote
              ? (
                  await tx
                    .select({ id: ticketMessages.id })
                    .from(ticketMessages)
                    .where(
                      and(
                        eq(ticketMessages.ticketId, current.id),
                        eq(ticketMessages.senderRole, 'ADMIN'),
                        eq(ticketMessages.isInternalNote, false),
                      ),
                    )
                    .limit(1)
                ).length > 0
              : false;
          const [message] = await tx
            .insert(ticketMessages)
            .values({
              ...(messageId ? { id: messageId } : {}),
              ticketId: current.id,
              senderId: input.senderId,
              senderRole: input.senderRole,
              body: input.body,
              isInternalNote: input.isInternalNote,
            })
            .returning({ id: ticketMessages.id });
          if (staged.length) await tx.insert(ticketAttachments).values(staged);
          const next = statusAfterReply(current.status, {
            senderRole: input.senderRole,
            isInternalNote: input.isInternalNote,
            hadPublicAdminReply,
          });
          if (next !== current.status)
            await tx
              .update(tickets)
              .set({ status: next })
              .where(eq(tickets.id, current.id));
          return {
            ticketId: current.id,
            workspaceId: current.workspaceId,
            messageId: message!.id,
            senderRole: input.senderRole,
            isInternalNote: input.isInternalNote,
          };
        }),
    );
    this.events.emitReplied(event);

    const [ticket, [message]] = await Promise.all([
      this.findItem(event.ticketId),
      this.selectMessages(eq(ticketMessages.id, event.messageId)),
    ]);
    if (!ticket || !message) throw notFound();
    return { message, ticket };
  }

  /**
   * Admin status change (free moves, reopen = `→ OPEN`). The same status again is a no-op
   * (`changed: false`, nothing written).
   */
  async updateStatus(
    ticketId: string,
    status: TicketStatus,
  ): Promise<{ ticket: TicketListItem; changed: boolean }> {
    if (!UUID.test(ticketId)) throw notFound();
    const changed = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: tickets.id, status: tickets.status })
        .from(tickets)
        .where(eq(tickets.id, ticketId))
        .for('update');
      if (!current) throw notFound();
      const change = adminStatusChange(current.status, status);
      if (!change.changed) return false;
      await tx
        .update(tickets)
        .set({ status: change.status })
        .where(eq(tickets.id, current.id));
      return true;
    });
    const ticket = await this.findItem(ticketId);
    if (!ticket) throw notFound();
    return { ticket, changed };
  }

  /** One ticket in the list's item shape. */
  async findItem(ticketId: string): Promise<TicketListItem | undefined> {
    const [item] = await this.selectItems(eq(tickets.id, ticketId), 0, 1);
    return item;
  }

  private async selectItems(
    where: SQL | undefined,
    skip: number,
    take: number,
  ): Promise<TicketListItem[]> {
    const rows = await this.db
      .select(ticketRow)
      .from(tickets)
      .innerJoin(workspaces, eq(workspaces.id, tickets.workspaceId))
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(where)
      .orderBy(desc(tickets.createdAt), desc(tickets.id))
      .offset(skip)
      .limit(take);
    if (!rows.length) return [];
    const stats = await this.db
      .select({
        ticketId: ticketMessages.ticketId,
        messageCount: count(),
        lastMessageAt: max(ticketMessages.createdAt),
      })
      .from(ticketMessages)
      .where(
        inArray(
          ticketMessages.ticketId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(ticketMessages.ticketId);
    const statsOf = new Map(stats.map((s) => [s.ticketId, s]));
    return rows.map((r) => ({
      id: r.id,
      subject: r.subject,
      category: r.category,
      priority: r.priority,
      status: r.status,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      workspace: { id: r.workspaceId, name: r.workspaceName },
      requester: {
        id: r.requesterId,
        name: r.requesterName,
        email: r.requesterEmail,
      },
      lastMessageAt: statsOf.get(r.id)?.lastMessageAt ?? null,
      messageCount: statsOf.get(r.id)?.messageCount ?? 0,
    }));
  }

  private async selectMessages(where: SQL): Promise<TicketMessageItem[]> {
    const rows = await this.db
      .select({
        id: ticketMessages.id,
        senderRole: ticketMessages.senderRole,
        body: ticketMessages.body,
        isInternalNote: ticketMessages.isInternalNote,
        createdAt: ticketMessages.createdAt,
        senderId: users.id,
        senderName: users.name,
        senderEmail: users.email,
      })
      .from(ticketMessages)
      .innerJoin(users, eq(users.id, ticketMessages.senderId))
      .where(where)
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
    const attachments = await this.attachments.viewsFor(rows.map((r) => r.id));
    return rows.map(({ senderId, senderName, senderEmail, ...m }) => ({
      ...m,
      sender: { id: senderId, name: senderName, email: senderEmail },
      attachments: attachments.get(m.id) ?? [],
    }));
  }
}
