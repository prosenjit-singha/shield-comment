import type { PaymentGateway } from '../db/schema/index.js';

/** SSLCommerz `card_type` prefixes (before the first `-`) → the label A4 shows. */
const CARD_TYPE_LABELS: Record<string, string> = {
  BKASH: 'bKash',
  NAGAD: 'Nagad',
  VISA: 'Visa',
  MASTER: 'Mastercard',
  AMEX: 'Amex',
};

/**
 * The payment method label of a transaction (M8-T2, M2-T9 `AdminTransaction.gateway`):
 * ৳0 rows → `PROMOTION`; else the `card_type` prefix (`BKASH-BKash` → `bKash`, `VISA-Brac Bank`
 * → `Visa`, unknown → the raw prefix); no `card_type` yet (PENDING / FAILED) → `SSLCommerz`.
 */
export function gatewayLabel(
  gateway: PaymentGateway,
  cardType: string | null,
): string {
  if (gateway === 'PROMOTION') return 'PROMOTION';
  const prefix = cardType?.split('-')[0]?.trim();
  if (!prefix) return 'SSLCommerz';
  return CARD_TYPE_LABELS[prefix.toUpperCase()] ?? prefix;
}
