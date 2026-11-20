import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { uuidv7 } from 'uuidv7';
import type { Database } from '../db/database.js';
import {
  ticketAttachments,
  ticketMessages,
  tickets,
  UNRESOLVED_TICKET_STATUSES,
  users,
  workspaces,
  type TicketCategory,
  type TicketPriority,
  type TicketSenderRole,
  type TicketStatus,
  type WorkspaceRole,
} from '../db/schema/index.js';
import { findLiveSubscription } from '../wallet/live-subscription.queries.js';
import { UUID } from './dto/tickets.dto.js';
import { SupportTicketsService } from './support-tickets.service.js';
import {
  type AttachmentView,
  TicketAttachmentsService,
  validateAttachments,
  type UploadedImage,
} from './ticket-attachments.js';

/** Reading 4 (M7-PLAN): unresolved (`OPEN` + `IN_PROGRESS`) tickets one workspace may have. */
export const MAX_UNRESOLVED_TICKETS = 20;

export const CLIENT_TICKET_ERROR_CODES = {
  /** 409: the workspace already has `MAX_UNRESOLVED_TICKETS` unresolved tickets; `details { limit }`. */
  limitReached: 'TICKET_LIMIT_REACHED',
  /** 403 (D2): impersonated sessions may read tickets but not create tickets or replies. */
  impersonationReadOnly: 'IMPERSONATION_READ_ONLY',
} as const;

/** What admin messages show as their sender on the client side (no admin ids or emails). */
export const SUPPORT_SENDER_NAME = 'Support';

/** A ticket as the client sees it: no priority, no internal-note activity, no emails. */
export interface ClientTicketItem {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  /** The member who opened it (owner/admin see every member's tickets, D1). */
  requester: { id: string; name: string };
  /** Newest public message (internal notes never count), `null` for an empty thread. */
  lastMessageAt: Date | null;
  /** Reading 3: the newest public message is from support. */
  hasNewReply: boolean;
}

export interface ClientTicketMessage {
  id: string;
  senderRole: TicketSenderRole;
  /** `{ id: null, name: 'Support' }` for admin messages. */
  sender: { id: string | null; name: string };
  body: string;
  createdAt: Date;
  /** D4 screenshots (M7-T3); notes (and so their images) never reach the client. */
  attachments: AttachmentView[];
}

export type ClientTicketDetail = ClientTicketItem & {
  messages: ClientTicketMessage[];
};

/** The caller as `WorkspaceAccessGuard` resolved it. */
export interface TicketViewer {
  workspaceId: string;
  role: WorkspaceRole;
  userId: string;
}

export interface NewClientTicket {
  category: TicketCategory;
  subject: string;
  body: string;
}

/** D1: a moderator sees only the tickets they opened; owner/admin see the whole workspace. */
export function requesterFilter(viewer: TicketViewer): string | undefined {
  return viewer.role === 'moderator' ? viewer.userId : undefined;
}

/** D3: support sets the priority; a live plan with `prioritySupportApi` (Pro) starts at HIGH. */
export function initialTicketPriority(
  prioritySupportApi: boolean,
): TicketPriority {
  return prioritySupportApi ? 'HIGH' : 'MEDIUM';
}

/** Reading 4: 409 `TICKET_LIMIT_REACHED` once the workspace has 20 unresolved tickets. */
export function assertUnderTicketCap(unresolved: number): void {
  if (unresolved >= MAX_UNRESOLVED_TICKETS)
    throw new ConflictException({
      message: `You already have ${MAX_UNRESOLVED_TICKETS} open tickets. Reply on one of them or wait until support resolves one.`,
      error: 'Conflict',
      code: CLIENT_TICKET_ERROR_CODES.limitReached,
      details: { limit: MAX_UNRESOLVED_TICKETS },
    });
}

interface MessageRow {
  id: string;
  senderRole: TicketSenderRole;
  senderId: string;
  senderName: string;
  body: string;
  isInternalNote: boolean;
  createdAt: Date;
  attachments: AttachmentView[];
}

/** Drops internal notes and hides who in support wrote a message. */
export function toClientMessages(rows: MessageRow[]): ClientTicketMessage[] {
  return rows
    .filter((m) => !m.isInternalNote)
    .map((m) => ({
      id: m.id,
      senderRole: m.senderRole,
      sender:
        m.senderRole === 'ADMIN'
          ? { id: null, name: SUPPORT_SENDER_NAME }
          : { id: m.senderId, name: m.senderName },
      body: m.body,
      createdAt: m.createdAt,
      attachments: m.attachments,
    }));
}

export interface TicketRow {
  id: string;
  subject: string;
  category: TicketCategory;
  status: TicketStatus;
  createdAt: Date;
  updatedAt: Date;
  requesterId: string;
  requesterName: string;
  lastMessageAt: Date | null;
}

/** `lastPublicSender` = sender of the newest non-note message (`undefined` = empty thread). */
export function toClientItem(
  row: TicketRow,
  lastPublicSender: TicketSenderRole | undefined,
): ClientTicketItem {
  return {
    id: row.id,
    subject: row.subject,
    category: row.category,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    requester: { id: row.requesterId, name: row.requesterName },
    lastMessageAt: row.lastMessageAt,
    hasNewReply: lastPublicSender === 'ADMIN',
  };
}

/** Newest public message time (internal notes excluded), the list's "activity" order key. */
const lastPublicMessageAt = sql<Date | null>`(
  select max(${ticketMessages.createdAt}) from ${ticketMessages}
  where ${ticketMessages.ticketId} = ${tickets.id} and not ${ticketMessages.isInternalNote}
)`.mapWith(ticketMessages.createdAt);

const notFound = () => new NotFoundException('Ticket not found');

/**
 * Client side of the support tickets (M7-T2; D1–D3). Every query is scoped by `workspace_id`
 * (+ the requester for moderators, D1); replies go through `SupportTicketsService.addMessage()`
 * so status rules and `ticket.replied` stay in one place.
 */
@Injectable()
export class ClientTicketsService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly tickets: SupportTicketsService,
    private readonly attachments: TicketAttachmentsService,
  ) {}

  /** `{ items, total, skip, take }`, newest activity (public message or creation) first. */
  async list(
    viewer: TicketViewer,
    query: { skip: number; take: number; status?: TicketStatus },
  ) {
    const where = and(
      this.scope(viewer),
      query.status ? eq(tickets.status, query.status) : undefined,
    );
    const [items, [totals]] = await Promise.all([
      this.selectItems(where, query.skip, query.take),
      this.db.select({ total: count() }).from(tickets).where(where),
    ]);
    return {
      items,
      total: totals?.total ?? 0,
      skip: query.skip,
      take: query.take,
    };
  }

  /** The ticket + its public thread, oldest first. 404 unknown, malformed or not visible. */
  async detail(
    viewer: TicketViewer,
    ticketId: string,
  ): Promise<ClientTicketDetail> {
    const ticket = await this.findVisible(viewer, ticketId);
    const rows = await this.db
      .select({
        id: ticketMessages.id,
        senderRole: ticketMessages.senderRole,
        senderId: ticketMessages.senderId,
        senderName: users.name,
        body: ticketMessages.body,
        isInternalNote: ticketMessages.isInternalNote,
        createdAt: ticketMessages.createdAt,
      })
      .from(ticketMessages)
      .innerJoin(users, eq(users.id, ticketMessages.senderId))
      .where(
        and(
          eq(ticketMessages.ticketId, ticket.id),
          eq(ticketMessages.isInternalNote, false),
        ),
      )
      .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
    const attachments = await this.attachments.viewsFor(rows.map((r) => r.id));
    return {
      ...ticket,
      messages: toClientMessages(
        rows.map((r) => ({ ...r, attachments: attachments.get(r.id) ?? [] })),
      ),
    };
  }

  /**
   * One transaction: lock the workspace row (concurrent creates serialise on the cap), count the
   * unresolved tickets (409 at 20), priority from the live plan (D3), insert the ticket + its first
   * CLIENT message (+ its D4 images, stored first; the cap is also checked before any upload). No
   * `ticket.replied` event (that is for replies).
   */
  async create(
    viewer: TicketViewer,
    input: NewClientTicket,
    files?: readonly UploadedImage[],
  ): Promise<ClientTicketDetail> {
    const images = validateAttachments(files);
    const ticketId = uuidv7();
    const messageId = uuidv7();
    if (images.length)
      assertUnderTicketCap(await this.unresolved(this.db, viewer));
    await this.attachments.withUploads(ticketId, messageId, images, (staged) =>
      this.db.transaction(async (tx) => {
        await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(eq(workspaces.id, viewer.workspaceId))
          .for('no key update');
        assertUnderTicketCap(await this.unresolved(tx, viewer));
        const live = await findLiveSubscription(tx, viewer.workspaceId);
        await tx.insert(tickets).values({
          id: ticketId,
          workspaceId: viewer.workspaceId,
          userId: viewer.userId,
          subject: input.subject,
          category: input.category,
          priority: initialTicketPriority(
            live?.plan.featureConfig.features.prioritySupportApi ?? false,
          ),
        });
        await tx.insert(ticketMessages).values({
          id: messageId,
          ticketId,
          senderId: viewer.userId,
          senderRole: 'CLIENT',
          body: input.body,
          isInternalNote: false,
        });
        if (staged.length) await tx.insert(ticketAttachments).values(staged);
      }),
    );
    return this.detail(viewer, ticketId);
  }

  /** Client reply (404 when not visible); a reply on a RESOLVED ticket reopens it (M2 rule). */
  async reply(
    viewer: TicketViewer,
    ticketId: string,
    body: string,
    files?: readonly UploadedImage[],
  ): Promise<{ message: ClientTicketMessage; ticket: ClientTicketItem }> {
    const images = validateAttachments(files);
    await this.findVisible(viewer, ticketId);
    const { message } = await this.tickets.addMessage(ticketId, {
      senderId: viewer.userId,
      senderRole: 'CLIENT',
      body,
      isInternalNote: false,
      images,
    });
    const ticket = await this.findVisible(viewer, ticketId);
    const [clientMessage] = toClientMessages([
      {
        id: message.id,
        senderRole: message.senderRole,
        senderId: message.sender.id,
        senderName: message.sender.name,
        body: message.body,
        isInternalNote: message.isInternalNote,
        createdAt: message.createdAt,
        attachments: message.attachments,
      },
    ]);
    return { message: clientMessage!, ticket };
  }

  /** OPEN + IN_PROGRESS tickets of the workspace (reading 4 cap). */
  private async unresolved(
    db: Pick<Database, 'select'>,
    viewer: TicketViewer,
  ): Promise<number> {
    const [open] = await db
      .select({ n: count() })
      .from(tickets)
      .where(
        and(
          eq(tickets.workspaceId, viewer.workspaceId),
          inArray(tickets.status, [...UNRESOLVED_TICKET_STATUSES]),
        ),
      );
    return open?.n ?? 0;
  }

  private scope(viewer: TicketViewer, ticketId?: string): SQL | undefined {
    const requester = requesterFilter(viewer);
    return and(
      eq(tickets.workspaceId, viewer.workspaceId),
      requester ? eq(tickets.userId, requester) : undefined,
      ticketId ? eq(tickets.id, ticketId) : undefined,
    );
  }

  private async findVisible(
    viewer: TicketViewer,
    ticketId: string,
  ): Promise<ClientTicketItem> {
    if (!UUID.test(ticketId)) throw notFound();
    const [item] = await this.selectItems(this.scope(viewer, ticketId), 0, 1);
    if (!item) throw notFound();
    return item;
  }

  private async selectItems(
    where: SQL | undefined,
    skip: number,
    take: number,
  ): Promise<ClientTicketItem[]> {
    const rows = await this.db
      .select({
        id: tickets.id,
        subject: tickets.subject,
        category: tickets.category,
        status: tickets.status,
        createdAt: tickets.createdAt,
        updatedAt: tickets.updatedAt,
        requesterId: users.id,
        requesterName: users.name,
        lastMessageAt: lastPublicMessageAt,
      })
      .from(tickets)
      .innerJoin(users, eq(users.id, tickets.userId))
      .where(where)
      .orderBy(
        desc(sql`coalesce(${lastPublicMessageAt}, ${tickets.createdAt})`),
        desc(tickets.id),
      )
      .offset(skip)
      .limit(take);
    if (!rows.length) return [];
    const last = await this.db
      .selectDistinctOn([ticketMessages.ticketId], {
        ticketId: ticketMessages.ticketId,
        senderRole: ticketMessages.senderRole,
      })
      .from(ticketMessages)
      .where(
        and(
          inArray(
            ticketMessages.ticketId,
            rows.map((r) => r.id),
          ),
          eq(ticketMessages.isInternalNote, false),
        ),
      )
      .orderBy(
        ticketMessages.ticketId,
        desc(ticketMessages.createdAt),
        desc(ticketMessages.id),
      );
    const lastSender = new Map(last.map((m) => [m.ticketId, m.senderRole]));
    return rows.map((r) => toClientItem(r, lastSender.get(r.id)));
  }
}
