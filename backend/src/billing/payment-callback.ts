import type { SslcommerzValidation } from '../payments/sslcommerz.client.js';

/**
 * Pure helpers of the SSLCommerz callbacks (M8-T5; Module 8 readings 3, 4, 9). The outcome is the
 * `payment_events.outcome` code written once per callback (A4 lists the IPNs not paid).
 */
export const PAYMENT_OUTCOMES = {
  /** The row turned PAID and the term was activated. */
  paid: 'PAID',
  /** PAID, but a promotion on the paid price was already claimed by the account (reading 6). */
  paidDuplicateClaim: 'PAID_DUPLICATE_CLAIM',
  /** The row was already settled (a second IPN, the success return after the IPN): ack only. */
  alreadyPaid: 'ALREADY_PAID',
  badSignature: 'BAD_SIGNATURE',
  unknownTranId: 'UNKNOWN_TRAN_ID',
  /** A paid-type callback without a `val_id` (nothing to validate). */
  noValId: 'NO_VAL_ID',
  /** The Order Validation API answered INVALID_TRANSACTION (or another status). */
  invalid: 'INVALID',
  tranIdMismatch: 'TRAN_ID_MISMATCH',
  currencyMismatch: 'CURRENCY_MISMATCH',
  amountMismatch: 'AMOUNT_MISMATCH',
  /** Transient: the validator could not be reached; the IPN answers 503 so SSLCommerz retries. */
  validationError: 'VALIDATION_ERROR',
  /** Transient: the activation transaction failed (logged with the error). */
  activationFailed: 'ACTIVATION_FAILED',
  /** SSLCommerz env unset: nothing can be verified. */
  notConfigured: 'NOT_CONFIGURED',
  /** fail / cancel return: the PENDING row moved to FAILED / CANCELLED. */
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  /** fail / cancel return on a row that is no longer PENDING: unchanged. */
  notPending: 'NOT_PENDING',
} as const;
export type PaymentOutcome =
  (typeof PAYMENT_OUTCOMES)[keyof typeof PAYMENT_OUTCOMES];

/** Outcomes that mean "the payment is settled" (success return → `payment=success`). */
const SETTLED_OUTCOMES: readonly PaymentOutcome[] = [
  PAYMENT_OUTCOMES.paid,
  PAYMENT_OUTCOMES.paidDuplicateClaim,
  PAYMENT_OUTCOMES.alreadyPaid,
];
/** Transient outcomes: the IPN asks for a retry (503), the success return says `pending`. */
const RETRY_OUTCOMES: readonly PaymentOutcome[] = [
  PAYMENT_OUTCOMES.validationError,
  PAYMENT_OUTCOMES.activationFailed,
  PAYMENT_OUTCOMES.notConfigured,
];

export const isRetryOutcome = (outcome: PaymentOutcome) =>
  RETRY_OUTCOMES.includes(outcome);

/** `tran_id` as received when it is a 1–64 character string (`payment_events.tran_id`), else null. */
export function callbackTranId(body: Record<string, unknown>): string | null {
  const value = body.tran_id;
  return typeof value === 'string' && value.length >= 1 && value.length <= 64
    ? value
    : null;
}

/**
 * Reading 3 checks on the Order Validation API answer against our row: status VALID|VALIDATED,
 * same `tran_id`, currency BDT, amount equal to `amount_bdt`. `null` = all good.
 */
export function validationOutcome(
  validation: SslcommerzValidation,
  row: { tranId: string; amountBdt: number },
): PaymentOutcome | null {
  if (validation.status !== 'VALID' && validation.status !== 'VALIDATED')
    return PAYMENT_OUTCOMES.invalid;
  if (validation.tranId !== row.tranId) return PAYMENT_OUTCOMES.tranIdMismatch;
  if (validation.currency !== 'BDT') return PAYMENT_OUTCOMES.currencyMismatch;
  if (validation.amount !== row.amountBdt)
    return PAYMENT_OUTCOMES.amountMismatch;
  return null;
}

export type ReturnPayment = 'success' | 'failed' | 'cancelled' | 'pending';

/** The success return's `payment=` value for a settle outcome. */
export function successReturn(outcome: PaymentOutcome): ReturnPayment {
  if (SETTLED_OUTCOMES.includes(outcome)) return 'success';
  return isRetryOutcome(outcome) ? 'pending' : 'failed';
}

/** 303 target: `CLIENT_APP_URL/billing?payment=…&tranId=…` (reading 4). */
export function paymentReturnUrl(
  clientAppUrl: string,
  payment: ReturnPayment,
  tranId: string | null,
): string {
  const query = new URLSearchParams({ payment });
  if (tranId) query.set('tranId', tranId);
  return `${clientAppUrl.replace(/\/+$/, '')}/billing?${query.toString()}`;
}
