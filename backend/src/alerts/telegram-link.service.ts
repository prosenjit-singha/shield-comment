import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, count, eq } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  MAX_TELEGRAM_CHATS,
  telegramChats,
  workspaces,
} from '../db/schema/index.js';
import { messengerAlertsAvailable } from './alert-settings.service.js';
import {
  TELEGRAM_CONFIG,
  TelegramClient,
  type TelegramConfig,
} from './telegram.client.js';
import {
  generateTelegramLinkCode,
  parseTelegramStart,
  TELEGRAM_BOT_REPLIES,
  TELEGRAM_LINK_TTL_SECONDS,
  TelegramLinkStore,
} from './telegram-link.js';

/** Error codes of the Telegram routes (M7-T8). */
export const TELEGRAM_ERROR_CODES = {
  /** 503: the TELEGRAM_* env vars are unset. */
  notConfigured: 'TELEGRAM_NOT_CONFIGURED',
  /** 409: no `messengerAlerts` on the live plan; `details { feature: 'messengerAlerts' }`. */
  planFeatureUnavailable: 'PLAN_FEATURE_UNAVAILABLE',
  /** 409: 3 chats already linked; `details { max }`. */
  chatLimit: 'TELEGRAM_CHAT_LIMIT',
} as const;

export interface TelegramLinkResponse {
  /** Private chat: `https://t.me/<bot>?start=<code>`. */
  url: string;
  /** Group: `https://t.me/<bot>?startgroup=<code>` (Telegram asks which group to add the bot to). */
  groupUrl: string;
  expiresAt: Date;
}

type LinkOutcome =
  | { kind: 'linked'; workspaceName: string }
  | { kind: 'limit' }
  | { kind: 'gone' };

/**
 * Telegram chat linking (D13). Workspace routes have passed `WorkspaceAccessGuard` + owner/admin;
 * every chat query is scoped by `workspace_id` (the webhook's comes from the one-time code).
 */
@Injectable()
export class TelegramLinkService {
  private readonly logger = new Logger(TelegramLinkService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(TELEGRAM_CONFIG) private readonly config: TelegramConfig | null,
    private readonly client: TelegramClient,
    private readonly store: TelegramLinkStore,
  ) {}

  async createLink(
    workspaceId: string,
    userId: string,
  ): Promise<TelegramLinkResponse> {
    const config = this.config;
    if (!config)
      throw new ServiceUnavailableException({
        message: 'Telegram alerts are not available right now.',
        code: TELEGRAM_ERROR_CODES.notConfigured,
      });
    if (!(await messengerAlertsAvailable(this.db, workspaceId)))
      throw new ConflictException({
        message:
          'Telegram alerts are not included in your plan. Upgrade to Growth or Pro to link a chat.',
        error: 'Conflict',
        code: TELEGRAM_ERROR_CODES.planFeatureUnavailable,
        details: { feature: 'messengerAlerts' },
      });
    if ((await this.chatCount(this.db, workspaceId)) >= MAX_TELEGRAM_CHATS)
      throw this.limitError();
    const code = generateTelegramLinkCode();
    await this.store.save(
      code,
      { workspaceId, userId },
      TELEGRAM_LINK_TTL_SECONDS,
    );
    const bot = `https://t.me/${config.botUsername}`;
    return {
      url: `${bot}?start=${code}`,
      groupUrl: `${bot}?startgroup=${code}`,
      expiresAt: new Date(Date.now() + TELEGRAM_LINK_TTL_SECONDS * 1000),
    };
  }

  async removeChat(workspaceId: string, chatId: string): Promise<void> {
    const removed = await this.db
      .delete(telegramChats)
      .where(
        and(
          eq(telegramChats.workspaceId, workspaceId),
          eq(telegramChats.id, chatId),
        ),
      )
      .returning({ id: telegramChats.id });
    if (removed.length === 0)
      throw new NotFoundException('Telegram chat not found');
  }

  /**
   * One webhook update (the controller has checked the secret). Only `/start` is handled; the
   * code is consumed before the transaction, so a failed link needs a new code. Reply failures
   * are logged, never thrown (Telegram would retry the update).
   */
  async handleUpdate(update: unknown): Promise<void> {
    const config = this.config;
    if (!config) return;
    const start = parseTelegramStart(update, config.botUsername);
    if (!start) return;
    const data = start.code ? await this.store.take(start.code) : null;
    if (!data)
      return this.reply(start.chatId, TELEGRAM_BOT_REPLIES.invalidCode);
    const outcome = await this.db.transaction(
      async (tx): Promise<LinkOutcome> => {
        // Lock the workspace so parallel links of one workspace count one at a time.
        const [workspace] = await tx
          .select({ name: workspaces.name })
          .from(workspaces)
          .where(eq(workspaces.id, data.workspaceId))
          .for('no key update');
        if (!workspace) return { kind: 'gone' };
        const values = { title: start.title, type: start.chatType };
        const [existing] = await tx
          .update(telegramChats)
          .set(values)
          .where(
            and(
              eq(telegramChats.workspaceId, data.workspaceId),
              eq(telegramChats.telegramChatId, start.chatId),
            ),
          )
          .returning({ id: telegramChats.id });
        if (!existing) {
          if (
            (await this.chatCount(tx, data.workspaceId)) >= MAX_TELEGRAM_CHATS
          )
            return { kind: 'limit' };
          await tx.insert(telegramChats).values({
            ...values,
            workspaceId: data.workspaceId,
            telegramChatId: start.chatId,
            linkedByUserId: data.userId,
          });
        }
        return { kind: 'linked', workspaceName: workspace.name };
      },
    );
    this.logger.log(
      `telegram link: workspace=${data.workspaceId} type=${start.chatType} outcome=${outcome.kind}`,
    );
    await this.reply(
      start.chatId,
      outcome.kind === 'linked'
        ? TELEGRAM_BOT_REPLIES.linked(outcome.workspaceName)
        : outcome.kind === 'limit'
          ? TELEGRAM_BOT_REPLIES.limitReached
          : TELEGRAM_BOT_REPLIES.invalidCode,
    );
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.client.sendMessage(chatId, text);
    } catch {
      // TelegramClient already logged the kind.
    }
  }

  private async chatCount(
    db: Pick<Database, 'select'>,
    workspaceId: string,
  ): Promise<number> {
    const [row] = await db
      .select({ n: count() })
      .from(telegramChats)
      .where(eq(telegramChats.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  private limitError(): ConflictException {
    return new ConflictException({
      message: `This workspace already has ${MAX_TELEGRAM_CHATS} linked Telegram chats. Remove one first.`,
      error: 'Conflict',
      code: TELEGRAM_ERROR_CODES.chatLimit,
      details: { max: MAX_TELEGRAM_CHATS },
    });
  }
}
