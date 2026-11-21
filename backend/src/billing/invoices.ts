import type {
  PaymentGateway,
  PaymentKind,
  PaymentPrice,
  PaymentPromotion,
  SubscriptionInterval,
} from '../db/schema/index.js';
import { gatewayLabel } from '../payments/gateway-label.js';

/** Settled statuses only: a PAID row is the invoice (D8), REFUNDED keeps it (D9). */
export type InvoiceStatus = 'PAID' | 'REFUNDED';

/** One row of `GET …/billing/invoices` (M8-T7). */
export interface InvoiceListItem {
  id: string;
  /** D8 `SC-YYYY-NNNNN`. */
  invoiceNumber: string;
  paidAt: string;
  status: InvoiceStatus;
  plan: { id: string; name: string };
  interval: SubscriptionInterval;
  /** Whole ৳ charged (VAT-inclusive, D8). */
  amountBdt: number;
  /** `gatewayLabel()`: bKash / Nagad / Visa / … / `PROMOTION`. */
  gateway: string;
}

export interface InvoiceList {
  items: InvoiceListItem[];
  total: number;
  skip: number;
  take: number;
}

/** A promotion on the bill (PR-D12): what it took off and the "k of N" months it covers. */
export interface InvoicePromotionLine {
  type: 'DISCOUNT' | 'COUPON';
  name: string;
  /** COUPON only. */
  code: string | null;
  label: string;
  labelBn: string;
  amountOffBdt: number;
  months: { from: number; to: number; of: number } | null;
}

/** `GET …/billing/invoices/:invoiceId` (M8-T7, D8: on-screen, VAT-inclusive, no VAT line). */
export interface InvoiceView extends InvoiceListItem {
  tranId: string;
  kind: PaymentKind;
  /** The term the payment bought `[start, end)`. */
  term: { start: string; end: string };
  /** The plan's price for the term before promotions. */
  listPriceBdt: number;
  promotions: InvoicePromotionLine[];
  /** D7: unused part of the previous term taken off an UPGRADE; 0 otherwise. */
  creditBdt: number;
  /** = `amountBdt` (what was paid). */
  chargedBdt: number;
  /** D8 seller details from env; unset → `null`. */
  seller: { name: string | null; address: string | null };
}

/** The settled `payment_transactions` row fields an invoice is built from. */
export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  tranId: string;
  paidAt: Date;
  status: InvoiceStatus;
  kind: PaymentKind;
  planId: string;
  planName: string;
  interval: SubscriptionInterval;
  amountBdt: number;
  gateway: PaymentGateway;
  cardType: string | null;
  termStart: Date;
  termEnd: Date;
  price: PaymentPrice;
}

export function toInvoiceListItem(
  r: Omit<InvoiceRow, 'tranId' | 'kind' | 'termStart' | 'termEnd' | 'price'>,
): InvoiceListItem {
  return {
    id: r.id,
    invoiceNumber: r.invoiceNumber,
    paidAt: r.paidAt.toISOString(),
    status: r.status,
    plan: { id: r.planId, name: r.planName },
    interval: r.interval,
    amountBdt: r.amountBdt,
    gateway: gatewayLabel(r.gateway, r.cardType),
  };
}

const promotionLine = (
  type: InvoicePromotionLine['type'],
  p: PaymentPromotion,
): InvoicePromotionLine => ({
  type,
  name: p.name,
  code: p.code,
  label: p.label,
  labelBn: p.labelBn,
  amountOffBdt: p.amountBdt,
  months: p.months,
});

/** Pure: a settled row (+ seller env) → the invoice; promotion lines = discount, then coupon. */
export function toInvoiceView(
  r: InvoiceRow,
  seller: InvoiceView['seller'],
): InvoiceView {
  const { discount, coupon } = r.price;
  return {
    ...toInvoiceListItem(r),
    tranId: r.tranId,
    kind: r.kind,
    term: { start: r.termStart.toISOString(), end: r.termEnd.toISOString() },
    listPriceBdt: r.price.listChargedBdt,
    promotions: [
      ...(discount ? [promotionLine('DISCOUNT', discount)] : []),
      ...(coupon ? [promotionLine('COUPON', coupon)] : []),
    ],
    creditBdt: r.price.creditBdt,
    chargedBdt: r.amountBdt,
    seller,
  };
}
