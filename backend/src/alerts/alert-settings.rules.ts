import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  DEFAULT_SPIKE_THRESHOLD,
  MAX_ALERT_RECIPIENTS,
  MAX_SPIKE_THRESHOLD,
  MIN_SPIKE_THRESHOLD,
} from '../db/schema/index.js';
import {
  ALERT_SETTINGS_ERROR_CODES,
  type AlertRecipient,
  type UpdateAlertSettingsDto,
} from './dto/alert-settings.dto.js';

/** Pure helpers of the alert settings API (M7-T7): defaults, patch merge + checks, recipients. */

export interface AlertSettingsValues {
  spikeThreshold: number;
  emailEnabled: boolean;
  /** `null` = default (the owner, D15). */
  emailRecipientMemberIds: string[] | null;
  telegramEnabled: boolean;
}

/** Reading 7: no row = alerts off with the default threshold. */
export const DEFAULT_ALERT_SETTINGS: Readonly<AlertSettingsValues> = {
  spikeThreshold: DEFAULT_SPIKE_THRESHOLD,
  emailEnabled: false,
  emailRecipientMemberIds: null,
  telegramEnabled: false,
};

const badRequest = (
  message: string,
  code: string,
  details?: Record<string, unknown>,
) =>
  new BadRequestException({
    message,
    error: 'Bad Request',
    code,
    ...(details && { details }),
  });

export function isEmptyAlertPatch(patch: UpdateAlertSettingsDto): boolean {
  return Object.values(patch).every((v) => v === undefined);
}

/**
 * D15: the recipients that still exist, in member order (owner first). `null` = the owner. A
 * removed member simply drops out.
 */
export function resolveRecipients(
  stored: readonly string[] | null,
  members: readonly AlertRecipient[],
): AlertRecipient[] {
  if (stored === null) return members.filter((m) => m.role === 'owner');
  const wanted = new Set(stored);
  return members.filter((m) => wanted.has(m.memberId));
}

/**
 * Merges the patch into `current` and checks it: threshold 1–1,000, recipients ≤ 10 distinct
 * members of this workspace, email on needs a recipient (400 codes), Telegram switched on needs
 * `messengerAlerts` on the live plan (409). Switching off is never gated.
 */
export function applyAlertPatch(
  current: AlertSettingsValues,
  patch: UpdateAlertSettingsDto,
  members: readonly AlertRecipient[],
  messengerAlerts: boolean,
): AlertSettingsValues {
  const t = patch.spikeThreshold;
  if (t !== undefined && (t < MIN_SPIKE_THRESHOLD || t > MAX_SPIKE_THRESHOLD))
    throw badRequest(
      `The alert threshold must be ${MIN_SPIKE_THRESHOLD}–${MAX_SPIKE_THRESHOLD} scam comments.`,
      ALERT_SETTINGS_ERROR_CODES.thresholdInvalid,
      { min: MIN_SPIKE_THRESHOLD, max: MAX_SPIKE_THRESHOLD },
    );

  let recipients = current.emailRecipientMemberIds;
  if (patch.emailRecipientMemberIds) {
    const ids = [
      ...new Set(patch.emailRecipientMemberIds.map((id) => id.toLowerCase())),
    ];
    if (ids.length > MAX_ALERT_RECIPIENTS)
      throw badRequest(
        `At most ${MAX_ALERT_RECIPIENTS} alert email recipients.`,
        ALERT_SETTINGS_ERROR_CODES.recipientsLimit,
        { max: MAX_ALERT_RECIPIENTS },
      );
    const memberIds = new Set(members.map((m) => m.memberId));
    const stranger = ids.find((id) => !memberIds.has(id));
    if (stranger)
      throw badRequest(
        'Alert emails can only go to members of this workspace.',
        ALERT_SETTINGS_ERROR_CODES.recipientNotMember,
        { memberId: stranger },
      );
    recipients = ids;
  }

  const next: AlertSettingsValues = {
    spikeThreshold: t ?? current.spikeThreshold,
    emailEnabled: patch.emailEnabled ?? current.emailEnabled,
    emailRecipientMemberIds: recipients,
    telegramEnabled: patch.telegramEnabled ?? current.telegramEnabled,
  };
  if (
    next.emailEnabled &&
    resolveRecipients(next.emailRecipientMemberIds, members).length === 0
  )
    throw badRequest(
      'Choose at least one member to get alert emails.',
      ALERT_SETTINGS_ERROR_CODES.recipientsRequired,
    );
  if (patch.telegramEnabled === true && !messengerAlerts)
    throw new ConflictException({
      message:
        'Telegram alerts are not included in your plan. Upgrade to Growth or Pro to switch them on.',
      error: 'Conflict',
      code: ALERT_SETTINGS_ERROR_CODES.planFeatureUnavailable,
      details: { feature: 'messengerAlerts' },
    });
  return next;
}
