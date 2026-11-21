import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PAYMENT_REFUND_REASON_MAX,
  type PaymentEventSource,
  type PaymentKind,
  type SubscriptionInterval,
} from '../../db/schema/index.js';
import type { InvoicePromotionLine } from '../../billing/invoices.js';
import { DATE_KEY } from '../dashboard-range.js';

/**
 * Payment status (= `PAYMENT_STATUSES`, `payment_transactions.status`), set from SSLCommerz V4:
 * `PENDING` (session created, no IPN yet), `PAID` (`VALID`/`VALIDATED` after the validation API),
 * `FAILED`, `CANCELLED` (customer cancelled), `REFUNDED` (refunded in the merchant panel, marked on A4, D9).
 */
export const TRANSACTION_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const TRANSACTIONS_PAGE_MAX = 100;
export const TRANSACTIONS_SEARCH_MAX = 100;
export const TRANSACTIONS_GATEWAY_MAX = 40;

const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/** Paging shared by the A4 lists: `skip` int ≥ 0 (default 0), `take` int 1–100 (default 50). */
class AdminBillingPageDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip: number = 0;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TRANSACTIONS_PAGE_MAX)
  take: number = 50;
}

/**
 * `GET /api/admin/billing/transactions` query (M2-T9 paging; M8-T8 filters): `status`, `gateway`
 * (the label `gatewayLabel()` shows: `bKash`, `Visa`, `SSLCommerz`, `PROMOTION`, …; exact),
 * `q` (workspace name, payer name / email or `tran_id`; partial, any case), `from` / `to`
 * (inclusive Asia/Dhaka dates `YYYY-MM-DD` on `created_at`; `from > to` → 400). Any other param → 400.
 */
export class ListTransactionsQueryDto extends AdminBillingPageDto {
  @IsOptional()
  @IsIn(TRANSACTION_STATUSES)
  status?: TransactionStatus;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(TRANSACTIONS_GATEWAY_MAX)
  gateway?: string;

  /** Trimmed; blank = no search. */
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(TRANSACTIONS_SEARCH_MAX)
  q?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'from must be a date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(DATE_KEY, { message: 'to must be a date (YYYY-MM-DD)' })
  @IsISO8601({ strict: true })
  to?: string;
}

/** `failed` = every outcome except PAID / ALREADY_PAID / FAILED / CANCELLED (`NOT_FAILED_OUTCOMES`). */
export const EVENT_OUTCOME_FILTERS = ['failed'] as const;

/** `GET /api/admin/billing/events` query (M8-T8): paging + `outcome=failed` (absent = every event). */
export class ListPaymentEventsQueryDto extends AdminBillingPageDto {
  @IsOptional()
  @IsIn(EVENT_OUTCOME_FILTERS)
  outcome?: (typeof EVENT_OUTCOME_FILTERS)[number];
}

/** `POST /api/admin/billing/transactions/:id/refund` body (D9): reason, trimmed, 1–500 chars. */
export class RefundTransactionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Matches(/\S/, { message: 'reason must not be empty' })
  @MaxLength(PAYMENT_REFUND_REASON_MAX)
  reason!: string;
}

/** One `payment_transactions` row (final shape, user decision 2026-11-18; real rows since M8-T2). */
export interface AdminTransaction {
  id: string;
  workspace: { id: string; name: string };
  /** The plan the payment bought (M2-T11 `plans`). */
  plan: { id: string; name: string };
  /** Whole taka (৳), integer. */
  amountBdt: number;
  /** `gatewayLabel()`: `bKash`, `Nagad`, `Visa`, `Mastercard`, … from `card_type`; `PROMOTION` (৳0); `SSLCommerz` (no card yet). */
  gateway: string;
  status: TransactionStatus;
  /** Our SSLCommerz `tran_id` (unique per payment attempt). */
  tranId: string;
  createdAt: string;
  /** D10 (M8-T8): SSLCommerz `risk_level = 1` (activated anyway, flagged on A4). */
  riskFlagged: boolean;
  /** D8 `SC-YYYY-NNNNN` once settled (PAID / REFUNDED), else `null`. */
  invoiceNumber: string | null;
}

/** One `payment_events` row (an SSLCommerz callback and our outcome code). */
export interface AdminPaymentEvent {
  id: string;
  /** As received; `null` when the callback had none. */
  tranId: string | null;
  source: PaymentEventSource;
  /** `PAYMENT_OUTCOMES` code. */
  outcome: string;
  receivedAt: string;
}

/** `GET /api/admin/billing/transactions/:id` (M8-T8): A4's transaction sheet. */
export interface AdminTransactionDetail extends AdminTransaction {
  kind: PaymentKind;
  interval: SubscriptionInterval;
  /** The payer (`null` once that user is deleted). */
  user: { id: string; name: string; email: string } | null;
  paidAt: string | null;
  /** The term the payment bought (settled rows). */
  term: { start: string; end: string } | null;
  valId: string | null;
  bankTranId: string | null;
  cardType: string | null;
  riskLevel: number | null;
  /** The plan's price for the term before promotions. */
  listPriceBdt: number;
  promotions: InvoicePromotionLine[];
  creditBdt: number;
  /** Callbacks for this `tran_id`, oldest first. */
  events: AdminPaymentEvent[];
  /** D9 audit: who marked it REFUNDED, why and when. */
  refund: {
    admin: { id: string; name: string };
    reason: string;
    createdAt: string;
  } | null;
}

/** `GET /api/admin/billing/events` item: the event + its transaction when the `tran_id` matches one. */
export interface AdminPaymentEventItem extends AdminPaymentEvent {
  transaction: { id: string; workspace: { id: string; name: string } } | null;
}

export interface PaymentEventList {
  items: AdminPaymentEventItem[];
  total: number;
  skip: number;
  take: number;
}

/** `GET /api/admin/billing/transactions` response, newest first. */
export interface TransactionList {
  items: AdminTransaction[];
  total: number;
  skip: number;
  take: number;
}
