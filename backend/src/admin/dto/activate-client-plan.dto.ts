import { Transform } from 'class-transformer';
import {
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  SUBSCRIPTION_AUDIT_REASON_MAX,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
  type SubscriptionStatus,
} from '../../db/schema/index.js';
import { isRealDateOnly } from '../manual-activation.js';
import type { ClientComments } from '../client-billing.js';

/** A real calendar date `YYYY-MM-DD` (the 31-days-back range is checked by the service). */
function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isDateOnly',
      validator: {
        validate: (value: unknown) => isRealDateOnly(value),
        defaultMessage: () => '$property must be a date (YYYY-MM-DD)',
      },
    },
    options,
  );
}

/**
 * `POST /api/admin/clients/:workspaceId/subscription` body (PW-T9, PW-D16): activate a plan by
 * hand for the workspace's billing account.
 */
export class ActivateClientPlanDto {
  /** An active plan (`GET /api/admin/settings/plans`). */
  @IsUUID()
  planId!: string;

  @IsIn(SUBSCRIPTION_INTERVALS)
  interval!: SubscriptionInterval;

  /** Asia/Dhaka calendar date the term starts (00:00 Dhaka): today − 31 days … today. */
  @IsDateOnly()
  startDate!: string;

  /** Required; trimmed, 1–500 characters (audit log). */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(SUBSCRIPTION_AUDIT_REASON_MAX)
  reason!: string;
}

/** `200` answer: the new subscription + this period's fresh comment balance. */
export interface ActivateClientPlanResponse {
  subscription: {
    status: SubscriptionStatus;
    interval: SubscriptionInterval;
    trialEndsAt: Date | null;
    termEndsAt: Date;
    plan: { id: string; slug: string; name: string };
  };
  comments: ClientComments;
}
