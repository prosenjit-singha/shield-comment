import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  SUBSCRIPTION_INTERVALS,
  type SubscriptionInterval,
} from '../../db/schema/index.js';

/** `POST /api/workspaces/:workspaceId/billing/checkout` body (M8-T4). */
export class CheckoutDto {
  @IsUUID()
  planId!: string;

  @IsIn(SUBSCRIPTION_INTERVALS)
  interval!: SubscriptionInterval;

  /** Optional coupon (checked like the preview: 400 `COUPON_*`). */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  couponCode?: string;
}

/** `POST /api/workspaces/:workspaceId/billing/coupon` body (M8-T4, reading 7). */
export class CouponPreviewDto {
  @IsUUID()
  planId!: string;

  @IsIn(SUBSCRIPTION_INTERVALS)
  interval!: SubscriptionInterval;

  /** Any text: an unknown or malformed code answers 400 `COUPON_NOT_FOUND`. */
  @IsString()
  @MaxLength(64)
  code!: string;
}
