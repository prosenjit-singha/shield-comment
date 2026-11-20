import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, eq } from 'drizzle-orm';
import { DEFAULT_CLIENT_APP_URL } from '../admin/admin-impersonation.service.js';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import { tickets, users, workspaceMembers } from '../db/schema/index.js';
import { bilingualEmail, type EmailContent } from '../email/bilingual-email.js';
import { EmailService } from '../email/email.service.js';
import { TicketEvents, type TicketRepliedEvent } from './ticket-events.js';

export type ReplyNotifyOutcome =
  | 'sent'
  | 'not_configured'
  | 'ignored'
  | 'skipped_ticket_missing'
  | 'skipped_not_member'
  | 'skipped_banned'
  | 'failed';

/**
 * D5 (Module 7): subject names the ticket only; the reply text, attachments and the admin's
 * name stay in the app. The CTA opens the thread on `/support`.
 */
export function ticketReplyEmail(
  ticket: { id: string; subject: string },
  clientAppUrl: string,
): EmailContent {
  const url = `${clientAppUrl.replace(/\/+$/, '')}/support?ticket=${encodeURIComponent(ticket.id)}`;
  return bilingualEmail(
    {
      en: {
        subject: `New reply to your support ticket: ${ticket.subject}`,
        lines: [
          `Our support team replied to your ticket "${ticket.subject}".`,
          'Open the ticket to read the reply and answer it.',
        ],
        cta: { label: 'View reply', url },
      },
      bn: {
        subject: `আপনার সাপোর্ট টিকেটে নতুন উত্তর: ${ticket.subject}`,
        lines: [
          `আমাদের সাপোর্ট টিম আপনার টিকেট "${ticket.subject}"-এ উত্তর দিয়েছে।`,
          'উত্তরটি পড়তে ও জবাব দিতে টিকেটটি খুলুন।',
        ],
        cta: { label: 'উত্তর দেখুন', url },
      },
    },
    clientAppUrl,
  );
}

/**
 * M7-T4: emails the ticket's requester once per public admin reply (`ticket.replied`, after
 * commit). Client replies and internal notes send nothing. A requester who left the workspace or
 * is banned is skipped. Every failure is logged and swallowed: the reply already succeeded.
 * ponytail: no retry queue; a failed send is lost (Resend idempotency key makes a future retry safe).
 */
@Injectable()
export class TicketReplyNotifier implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TicketReplyNotifier.name);
  private readonly clientAppUrl: string;
  private unsubscribe?: () => void;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly events: TicketEvents,
    private readonly email: EmailService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientAppUrl =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  onModuleInit(): void {
    this.unsubscribe = this.events.onReplied(async (event) => {
      await this.notify(event);
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  async notify(event: TicketRepliedEvent): Promise<ReplyNotifyOutcome> {
    if (event.senderRole !== 'ADMIN' || event.isInternalNote) return 'ignored';
    const ref = { ticketId: event.ticketId, messageId: event.messageId };
    try {
      const [row] = await this.db
        .select({
          subject: tickets.subject,
          email: users.email,
          banned: users.banned,
          banExpires: users.banExpires,
          memberId: workspaceMembers.id,
        })
        .from(tickets)
        .innerJoin(users, eq(users.id, tickets.userId))
        .leftJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, tickets.workspaceId),
            eq(workspaceMembers.userId, tickets.userId),
          ),
        )
        .where(
          and(
            eq(tickets.id, event.ticketId),
            eq(tickets.workspaceId, event.workspaceId),
          ),
        )
        .limit(1);
      if (!row) return this.skip('skipped_ticket_missing', ref);
      if (!row.memberId) return this.skip('skipped_not_member', ref);
      if (row.banned && (!row.banExpires || row.banExpires > new Date()))
        return this.skip('skipped_banned', ref);
      const content = ticketReplyEmail(
        { id: event.ticketId, subject: row.subject },
        this.clientAppUrl,
      );
      const result = await this.email.send({
        to: row.email,
        ...content,
        idempotencyKey: `ticket-reply:${event.messageId}`,
      });
      return result.delivered ? 'sent' : 'not_configured';
    } catch (err) {
      const reason =
        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.logger.warn(ref, `ticket reply email failed: ${reason}`);
      return 'failed';
    }
  }

  private skip(
    outcome: ReplyNotifyOutcome,
    ref: { ticketId: string; messageId: string },
  ): ReplyNotifyOutcome {
    this.logger.log(ref, `ticket reply email ${outcome}`);
    return outcome;
  }
}
