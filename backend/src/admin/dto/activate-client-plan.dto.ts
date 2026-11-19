import { Transform } from 'class-transformer';
import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateBy,
  type ValidationOptions,
} from 'class-validator';
import {
  type ActivationPrice,
  SUBSCRIPTION_AUDIT_REASON_MAX,
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
  type SubscriptionStatus,
} from '../../db/schema/index.js';
import { isRealDateOnly } from '../manual-activation.js';
import type { ClientComments } from '../client-billing.js';

/** A real calendar date `YYYY-MM-DD` (the 31-days-back range is checked by the service). */
export function IsDateOnly(options?: ValidationOptions): PropertyDecorator {
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

  /**
   * Optional coupon (PR-T3b, PR-D11): trimmed, any case (empty = none). Checked by
   * `validateCoupon`; an error is a 400 `{ code: COUPON_* }`.
   */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() || undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(64)
  couponCode?: string;
}

/** `201` answer: the new subscription + this period's fresh comment balance + the price. */
export interface ActivateClientPlanResponse {
  subscription: {
    status: SubscriptionStatus;
    interval: SubscriptionInterval;
    trialEndsAt: Date | null;
    termEndsAt: Date;
    plan: { id: string; slug: string; name: string };
  };
  comments: ClientComments;
  /** The term's price and the promotions on it (PR-D12). */
  price: ActivationPrice;
}
