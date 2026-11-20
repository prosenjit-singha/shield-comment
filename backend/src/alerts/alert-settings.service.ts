import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import {
  alertDeliveries,
  alertSettings,
  telegramChats,
  users,
  workspaceMembers,
} from '../db/schema/index.js';
import {
  findLiveSubscription,
  type LiveSubscriptionExecutor,
} from '../wallet/live-subscription.queries.js';
import {
  type AlertSettingsValues,
  applyAlertPatch,
  DEFAULT_ALERT_SETTINGS,
  isEmptyAlertPatch,
  resolveRecipients,
} from './alert-settings.rules.js';
import type {
  AlertDeliveryView,
  AlertRecipient,
  AlertSettingsResponse,
  UpdateAlertSettingsDto,
} from './dto/alert-settings.dto.js';
import { TELEGRAM_CONFIG, type TelegramConfig } from './telegram.client.js';

type AlertSettingsRow = typeof alertSettings.$inferSelect;
type Reader = Pick<Database, 'select' | 'selectDistinctOn'>;

/** Members of the workspace, owner first then by join date (D15 recipient candidates). */
export function workspaceRecipients(
  db: LiveSubscriptionExecutor,
  workspaceId: string,
): Promise<AlertRecipient[]> {
  return db
    .select({
      memberId: workspaceMembers.id,
      userId: workspaceMembers.userId,
      name: users.name,
      email: users.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(
      sql`${workspaceMembers.role} <> 'owner'`,
      asc(workspaceMembers.createdAt),
      asc(workspaceMembers.id),
    );
}

/** D12: Telegram needs `messengerAlerts` on the live plan (no plan = off). */
export async function messengerAlertsAvailable(
  db: LiveSubscriptionExecutor,
  workspaceId: string,
): Promise<boolean> {
  const live = await findLiveSubscription(db, workspaceId);
  return live?.plan.featureConfig.features.messengerAlerts ?? false;
}

function toValues(row: AlertSettingsRow | undefined): AlertSettingsValues {
  if (!row) return { ...DEFAULT_ALERT_SETTINGS };
  return {
    spikeThreshold: row.spikeThreshold,
    emailEnabled: row.emailEnabled,
    emailRecipientMemberIds: row.emailRecipientMemberIds,
    telegramEnabled: row.telegramEnabled,
  };
}

/**
 * Workspace alert settings (C12, M7-T7). The controller has passed `WorkspaceAccessGuard`
 * (+ `@Roles('owner','admin')` for PATCH). Every query is scoped by `workspace_id`.
 */
@Injectable()
export class AlertSettingsService {
  constructor(
    @InjectDrizzle() private readonly db: Database,
    @Inject(TELEGRAM_CONFIG)
    private readonly telegramConfig: TelegramConfig | null,
  ) {}

  async get(workspaceId: string): Promise<AlertSettingsResponse> {
    const [row] = await this.db
      .select()
      .from(alertSettings)
      .where(eq(alertSettings.workspaceId, workspaceId));
    return this.view(this.db, workspaceId, row);
  }

  /**
   * One transaction: ensure the row, `FOR UPDATE` it (PATCHes of a workspace run one at a time),
   * merge + check (`applyAlertPatch`), write. An empty body → 400 before any query.
   */
  async update(
    workspaceId: string,
    patch: UpdateAlertSettingsDto,
  ): Promise<AlertSettingsResponse> {
    if (isEmptyAlertPatch(patch))
      throw new BadRequestException('Nothing to update');
    return this.db.transaction(async (tx) => {
      await tx
        .insert(alertSettings)
        .values({ workspaceId })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(alertSettings)
        .where(eq(alertSettings.workspaceId, workspaceId))
        .for('update');
      const members = await workspaceRecipients(tx, workspaceId);
      const messenger = await messengerAlertsAvailable(tx, workspaceId);
      const next = applyAlertPatch(toValues(row), patch, members, messenger);
      const [saved] = await tx
        .update(alertSettings)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(alertSettings.workspaceId, workspaceId))
        .returning();
      return this.view(tx, workspaceId, saved, members, messenger);
    });
  }

  private async view(
    db: Reader,
    workspaceId: string,
    row: AlertSettingsRow | undefined,
    members?: AlertRecipient[],
    messenger?: boolean,
  ): Promise<AlertSettingsResponse> {
    const values = toValues(row);
    members ??= await workspaceRecipients(db, workspaceId);
    messenger ??= await messengerAlertsAvailable(db, workspaceId);
    const lastAlerts: AlertDeliveryView[] = await db
      .selectDistinctOn([alertDeliveries.channel], {
        channel: alertDeliveries.channel,
        status: alertDeliveries.status,
        scamCount: alertDeliveries.scamCount,
        errorKind: alertDeliveries.errorKind,
        sentAt: alertDeliveries.sentAt,
      })
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.workspaceId, workspaceId),
          eq(alertDeliveries.isTest, false),
        ),
      )
      .orderBy(alertDeliveries.channel, desc(alertDeliveries.sentAt));
    lastAlerts.sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime());
    const chats = await db
      .select({
        id: telegramChats.id,
        title: telegramChats.title,
        type: telegramChats.type,
        linkedAt: telegramChats.linkedAt,
      })
      .from(telegramChats)
      .where(eq(telegramChats.workspaceId, workspaceId))
      .orderBy(asc(telegramChats.linkedAt), asc(telegramChats.id));
    return {
      workspaceId,
      spikeThreshold: values.spikeThreshold,
      email: {
        enabled: values.emailEnabled,
        available: true,
        recipients: resolveRecipients(values.emailRecipientMemberIds, members),
      },
      telegram: {
        enabled: values.telegramEnabled,
        available: messenger,
        configured: this.telegramConfig !== null,
        chats,
      },
      whatsapp: { enabled: false, available: false, comingSoon: true },
      lastAlerts,
      updatedAt: row?.updatedAt ?? null,
    };
  }
}
