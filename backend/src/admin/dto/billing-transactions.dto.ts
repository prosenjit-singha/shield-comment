import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const TRANSACTIONS_PAGE_MAX = 100;

/**
 * `GET /api/admin/billing/transactions` query (M2-T9). Same paging rules as the other admin lists:
 * `skip` int ≥ 0 (default 0), `take` int 1–100 (default 50); any other param → 400.
 * Filters (status, gateway, workspace, dates) come with A4's Module 8 row (M8-T9).
 */
export class ListTransactionsQueryDto {
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
 * Payment status (= `PAYMENT_STATUSES`, `payment_transactions.status`), set from SSLCommerz V4:
 * `PENDING` (session created, no IPN yet), `PAID` (`VALID`/`VALIDATED` after the validation API),
 * `FAILED`, `CANCELLED` (customer cancelled), `REFUNDED` (refund API).
 */
export const TRANSACTION_STATUSES = [
  'PENDING',
  'PAID',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

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
}

/** `GET /api/admin/billing/transactions` response, newest first. */
export interface TransactionList {
  items: AdminTransaction[];
  total: number;
  skip: number;
  take: number;
}
