import { Injectable, Logger } from '@nestjs/common';
import type { TicketSenderRole } from '../db/schema/index.js';

/** Event name, same spelling `@nestjs/event-emitter` would use if it is adopted later. */
export const TICKET_REPLIED = 'ticket.replied';

/** Emitted after a thread message (reply or internal note) is committed. */
export interface TicketRepliedEvent {
  ticketId: string;
  workspaceId: string;
  messageId: string;
  senderRole: TicketSenderRole;
  isInternalNote: boolean;
}

export type TicketRepliedListener = (
  event: TicketRepliedEvent,
) => void | Promise<void>;

/**
 * Minimal in-process emitter for ticket events (M2-T7: no email yet). Notifications (email, in-app)
 * subscribe with `onReplied()` without touching ticket code. A failing listener is logged and never
 * fails the request that emitted the event.
 */
@Injectable()
export class TicketEvents {
  private readonly logger = new Logger(TicketEvents.name);
  private readonly repliedListeners = new Set<TicketRepliedListener>();

  /** Returns an unsubscribe function. */
  onReplied(listener: TicketRepliedListener): () => void {
    this.repliedListeners.add(listener);
    return () => this.repliedListeners.delete(listener);
  }

  emitReplied(event: TicketRepliedEvent): void {
    for (const listener of this.repliedListeners) {
      try {
        void Promise.resolve(listener(event)).catch((err: unknown) =>
          this.logFailure(event, err),
        );
      } catch (err) {
        this.logFailure(event, err);
      }
    }
  }

  private logFailure(event: TicketRepliedEvent, err: unknown) {
    this.logger.error(
      { err, ticketId: event.ticketId, messageId: event.messageId },
      `${TICKET_REPLIED} listener failed`,
    );
  }
}
