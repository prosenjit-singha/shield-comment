import { type AnyColumn, type SQL, sql } from 'drizzle-orm';
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

/**
 * `gatewayLabel()` in SQL (M8-T8): A4's gateway filter and the dashboard's per-gateway volume
 * group by the same label the API shows. Keep in step with `gatewayLabel()` (e2e covers both).
 */
export function gatewayLabelSql(
  gateway: AnyColumn,
  cardType: AnyColumn,
): SQL<string> {
  const prefix = sql`trim(split_part(coalesce(${cardType}, ''), '-', 1))`;
  const known = Object.entries(CARD_TYPE_LABELS).map(
    // Constant literals (not params), so the expression also works in GROUP BY.
    ([key, label]) => sql.raw(`when '${key}' then '${label}'`),
  );
  return sql<string>`case when ${gateway} = 'PROMOTION' then 'PROMOTION' when ${prefix} = '' then 'SSLCommerz' else case upper(${prefix}) ${sql.join(known, sql` `)} else ${prefix} end end`;
}
