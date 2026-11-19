import type {
  DiscountScope,
  DiscountType,
  SubscriptionInterval,
} from '../db/schema/index.js';

/** The plan columns `planPrice` reads (a `plans` row or any shape that carries them). */
export interface PlanPriceSource {
  /** Monthly list price, whole BDT. */
  monthlyPriceBdt: number;
  /** Per-month list price when billed yearly; `null` = no yearly option. */
  yearlyMonthlyPriceBdt: number | null;
}

/** The money terms of a DISCOUNT or COUPON promotion (or a redemption snapshot of them). */
export interface PriceDiscount {
  promotionId: string;
  discountType: DiscountType;
  /** FLAT: whole ৳ off; PERCENT: 1–100. */
  discountValue: number;
  discountScope: DiscountScope;
  /** PER_MONTH: months it runs; `null` = forever. Ignored for TOTAL. */
  durationMonths: number | null;
  /** End of validity (tie-break: the one ending sooner wins); `null` = until stopped. */
  endsAt: Date | null;
}

/** One saving on the bill (first term). */
export interface PriceSaving {
  promotionId: string;
  /** "50% off" / "৳200 off" (+ " for 3 months"). */
  label: string;
  /** Bangla label ("৫০% ছাড়" / "প্রথম ৩ মাস ৳২০০ ছাড়"). */
  labelBn: string;
  /** Whole ৳ this promotion takes off the first bill. */
  amountBdt: number;
}

/** What a pricing card or checkout shows for one plan and interval (whole BDT). */
export interface PlanPrice {
  /** List price per month of this interval (the struck price): monthly or yearly per month. */
  listPerMonthBdt: number;
  /** List price of one term: monthly = list, yearly = yearly list × 12. */
  listChargedBdt: number;
  /** The figure the card shows: the first bill per month (yearly: `chargedBdt / 12` rounded down). */
  perMonthBdt: number;
  /** What the first term costs after the discount (and the coupon, when given). */
  chargedBdt: number;
  /** The best automatic discount (PR-D6); `null` = none applies. */
  saving: PriceSaving | null;
  /** Only when a coupon is passed: what it takes off on top of `saving` (PR-D16). */
  coupon?: PriceSaving;
}

/** A term's bill: each month's price, plus whole-bill ৳ off (TOTAL discounts). */
interface Bill {
  months: number[];
  off: number;
}

const total = (bill: Bill) =>
  Math.max(0, bill.months.reduce((sum, p) => sum + p, 0) - bill.off);

/** Price after one discount: flat floor ৳0, percent rounded down (reading 3). */
const cut = (price: number, d: PriceDiscount) =>
  d.discountType === 'FLAT'
    ? Math.max(0, price - d.discountValue)
    : Math.floor((price * (100 - d.discountValue)) / 100);

/**
 * PER_MONTH: off the first N months of the term (yearly: N of 12, reading 2; forever = all).
 * TOTAL: off the whole (first) bill, month count ignored.
 */
function apply(bill: Bill, d: PriceDiscount): Bill {
  if (d.discountScope === 'TOTAL') {
    const now = total(bill);
    return { months: bill.months, off: bill.off + now - cut(now, d) };
  }
  const n = d.durationMonths ?? bill.months.length;
  return {
    months: bill.months.map((p, i) => (i < n ? cut(p, d) : p)),
    off: bill.off,
  };
}

const bnDigits = (n: number) => n.toLocaleString('bn-BD');

function saving(d: PriceDiscount, amountBdt: number): PriceSaving {
  const value =
    d.discountType === 'PERCENT'
      ? `${d.discountValue}%`
      : `৳${d.discountValue.toLocaleString('en-US')}`;
  const valueBn =
    d.discountType === 'PERCENT'
      ? `${bnDigits(d.discountValue)}%`
      : `৳${bnDigits(d.discountValue)}`;
  const months = d.discountScope === 'PER_MONTH' ? d.durationMonths : null;
  return {
    promotionId: d.promotionId,
    label:
      months === null
        ? `${value} off`
        : `${value} off for ${months} month${months === 1 ? '' : 's'}`,
    labelBn:
      months === null
        ? `${valueBn} ছাড়`
        : `প্রথম ${bnDigits(months)} মাস ${valueBn} ছাড়`,
    amountBdt,
  };
}

/** Tie-break of equal savings: ends sooner (`null` = never, last), then id. */
const tieOrder = (a: PriceDiscount, b: PriceDiscount) =>
  (a.endsAt?.getTime() ?? Infinity) - (b.endsAt?.getTime() ?? Infinity) ||
  (a.promotionId < b.promotionId ? -1 : a.promotionId > b.promotionId ? 1 : 0);

/**
 * One price rule for every screen (plan doc §5.3; PR-D4, D6, D16; readings 2, 3, 10). Pure.
 *
 * Of `discounts`, only the one with the **largest first-bill saving** applies (no stacking; tie →
 * ends sooner, then id). A `coupon` then comes off that result. Floor ৳0. Returns `null` when the
 * interval has no price (yearly without a yearly price).
 */
export function planPrice(
  plan: PlanPriceSource,
  interval: SubscriptionInterval,
  discounts: readonly PriceDiscount[] = [],
  coupon?: PriceDiscount,
): PlanPrice | null {
  const listPerMonthBdt =
    interval === 'month' ? plan.monthlyPriceBdt : plan.yearlyMonthlyPriceBdt;
  if (listPerMonthBdt === null) return null;
  const list: Bill = {
    months: Array<number>(interval === 'month' ? 1 : 12).fill(listPerMonthBdt),
    off: 0,
  };
  const listChargedBdt = total(list);

  let best: { d: PriceDiscount; bill: Bill; amount: number } | null = null;
  for (const d of discounts) {
    const bill = apply(list, d);
    const amount = listChargedBdt - total(bill);
    if (
      amount > 0 &&
      (!best ||
        amount > best.amount ||
        (amount === best.amount && tieOrder(d, best.d) < 0))
    )
      best = { d, bill, amount };
  }
  const discounted = best?.bill ?? list;
  const final = coupon ? apply(discounted, coupon) : discounted;
  const chargedBdt = total(final);
  return {
    listPerMonthBdt,
    listChargedBdt,
    perMonthBdt: Math.floor(chargedBdt / list.months.length),
    chargedBdt,
    saving: best ? saving(best.d, best.amount) : null,
    ...(coupon && {
      coupon: saving(coupon, total(discounted) - chargedBdt),
    }),
  };
}
