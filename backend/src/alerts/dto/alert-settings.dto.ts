import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsUUID } from 'class-validator';
import type {
  AlertChannel,
  AlertDeliveryStatus,
} from '../../db/schema/index.js';

/**
 * Alert settings API (M7-T7; D2/D12/D14/D15 answered 2026-11-20):
 * `GET/PATCH /api/workspaces/:workspaceId/alerts/settings`.
 *
 * - `GET` (every member, impersonated too) → `AlertSettingsResponse` (defaults when no row).
 * - `PATCH` (owner/admin; impersonated allowed, D2) partial `UpdateAlertSettingsDto` →
 *   `AlertSettingsResponse`. 400 invalid body / nothing to update / the codes below; 409
 *   `PLAN_FEATURE_UNAVAILABLE` (`details { feature: 'messengerAlerts' }`) when the body sends
 *   `telegramEnabled: true` on a plan without `messengerAlerts` (D12). Saved settings stay when
 *   the plan drops; `available` says what is sent (reading 11).
 */
export const ALERT_SETTINGS_ERROR_CODES = {
  /** 400: threshold outside 1–1,000; `details { min, max }`. */
  thresholdInvalid: 'ALERT_THRESHOLD_INVALID',
  /** 400: more than 10 distinct recipients; `details { max }`. */
  recipientsLimit: 'ALERT_RECIPIENTS_LIMIT',
  /** 400: a recipient is not a member of this workspace; `details { memberId }`. */
  recipientNotMember: 'ALERT_RECIPIENT_NOT_MEMBER',
  /** 400: email would be on with no recipient left. */
  recipientsRequired: 'ALERT_RECIPIENTS_REQUIRED',
  /** 409: Telegram switched on without `messengerAlerts`; `details { feature }`. */
  planFeatureUnavailable: 'PLAN_FEATURE_UNAVAILABLE',
} as const;

export class UpdateAlertSettingsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  spikeThreshold?: number;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  /** `workspace_members.id`s; replaces the whole list. */
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  emailRecipientMemberIds?: string[];

  @IsOptional()
  @IsBoolean()
  telegramEnabled?: boolean;
}

export interface AlertRecipient {
  memberId: string;
  userId: string;
  name: string;
  email: string;
  role: string;
}

export interface AlertDeliveryView {
  channel: AlertChannel;
  status: AlertDeliveryStatus;
  scamCount: number;
  errorKind: string | null;
  sentAt: Date;
}

export interface AlertSettingsResponse {
  workspaceId: string;
  spikeThreshold: number;
  /** Email is on every plan (D12). `recipients` = current members only (default: the owner). */
  email: { enabled: boolean; available: true; recipients: AlertRecipient[] };
  /** `available` = the live plan has `messengerAlerts`. */
  telegram: { enabled: boolean; available: boolean };
  /** D12: "Coming soon" placeholder. */
  whatsapp: { enabled: false; available: false; comingSoon: true };
  /** Latest delivery per channel, newest first (empty = never alerted). */
  lastAlerts: AlertDeliveryView[];
  /** `null` = no row saved yet (defaults). */
  updatedAt: Date | null;
}
