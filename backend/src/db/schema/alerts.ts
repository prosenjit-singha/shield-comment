import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { inListSql } from './check-sql.js';
import { id, timestamps, timestamptz } from './columns.js';
import { workspaces } from './workspaces.js';

/**
 * Scam-spike alerts (Module 7, M7-T7; D12/D14/D15 answered 2026-11-20). FKs are `restrict` like
 * the moderation policy: delete these rows before the workspace.
 */

/** D14: alert when the rolling-60-minute scam count reaches this (client sets 1–1,000). */
export const DEFAULT_SPIKE_THRESHOLD = 10;
export const MIN_SPIKE_THRESHOLD = 1;
export const MAX_SPIKE_THRESHOLD = 1000;
/** D15: at most 10 email recipients (members of the workspace). */
export const MAX_ALERT_RECIPIENTS = 10;

/** D12: WhatsApp is "Coming soon" (no channel yet). */
export const ALERT_CHANNELS = ['EMAIL', 'TELEGRAM'] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

export const ALERT_DELIVERY_STATUSES = ['SENT', 'FAILED'] as const;
export type AlertDeliveryStatus = (typeof ALERT_DELIVERY_STATUSES)[number];

/** One row per workspace; no row = alerts off with the default threshold (reading 7). */
export const alertSettings = pgTable(
  'alert_settings',
  {
    workspaceId: uuid()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    spikeThreshold: integer().notNull().default(DEFAULT_SPIKE_THRESHOLD),
    emailEnabled: boolean().notNull().default(false),
    /**
     * `workspace_members.id`s (no FK: a removed member drops out on read). `null` = the default
     * (D15: the current owner).
     */
    emailRecipientMemberIds: uuid().array(),
    /** Saved even when the plan drops `messengerAlerts`; sent only while the plan has it. */
    telegramEnabled: boolean().notNull().default(false),
    ...timestamps,
  },
  () => [
    check(
      'alert_settings_spike_threshold_check',
      sql.raw(
        `spike_threshold between ${MIN_SPIKE_THRESHOLD} and ${MAX_SPIKE_THRESHOLD}`,
      ),
    ),
    check(
      'alert_settings_email_recipient_member_ids_check',
      sql.raw(
        `cardinality(email_recipient_member_ids) <= ${MAX_ALERT_RECIPIENTS}`,
      ),
    ),
  ],
);

/** One row per channel send (cool-down audit + "last alert" on C12). No message text. */
export const alertDeliveries = pgTable(
  'alert_deliveries',
  {
    id: id(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: 'restrict' }),
    channel: text().$type<AlertChannel>().notNull(),
    status: text().$type<AlertDeliveryStatus>().notNull(),
    scamCount: integer().notNull(),
    /** Short error class (e.g. `timeout`, `not_configured`) when `FAILED`, else null. */
    errorKind: text(),
    sentAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    index().on(t.workspaceId, t.sentAt.desc()),
    check(
      'alert_deliveries_channel_check',
      sql.raw(inListSql('channel', ALERT_CHANNELS)),
    ),
    check(
      'alert_deliveries_status_check',
      sql.raw(inListSql('status', ALERT_DELIVERY_STATUSES)),
    ),
    check('alert_deliveries_scam_count_check', sql`scam_count >= 0`),
    check(
      'alert_deliveries_error_kind_check',
      sql`(status = 'FAILED') = (error_kind is not null)`,
    ),
  ],
);
