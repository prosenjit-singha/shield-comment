import { type InvoiceRow, toInvoiceView } from './invoices.js';

const row = (patch: Partial<InvoiceRow> = {}): InvoiceRow => ({
  id: 'inv-1',
  invoiceNumber: 'SC-2026-00001',
  tranId: 'SCabcdefgh12345678',
  paidAt: new Date('2026-11-21T06:00:00Z'),
  status: 'PAID',
  kind: 'NEW',
  planId: 'plan-1',
  planName: 'Growth',
  interval: 'month',
  amountBdt: 1200,
  gateway: 'SSLCOMMERZ',
  cardType: 'BKASH-BKash',
  termStart: new Date('2026-11-21T06:00:00Z'),
  termEnd: new Date('2026-12-21T06:00:00Z'),
  price: {
    listChargedBdt: 3000,
    chargedBdt: 2400,
    perMonthBdt: 3000,
    discount: null,
    coupon: null,
    creditBdt: 0,
  },
  ...patch,
});

const promo = {
  promotionId: 'p',
  redemptionId: 'r',
  label: 'x',
  labelBn: 'y',
  months: null,
};

describe('toInvoiceView', () => {
  it('maps a plain paid row: gateway label, term, list price, no promotions, seller as given', () => {
    expect(toInvoiceView(row(), { name: null, address: null })).toEqual({
      id: 'inv-1',
      invoiceNumber: 'SC-2026-00001',
      tranId: 'SCabcdefgh12345678',
      paidAt: '2026-11-21T06:00:00.000Z',
      status: 'PAID',
      kind: 'NEW',
      plan: { id: 'plan-1', name: 'Growth' },
      interval: 'month',
      amountBdt: 1200,
      gateway: 'bKash',
      term: {
        start: '2026-11-21T06:00:00.000Z',
        end: '2026-12-21T06:00:00.000Z',
      },
      listPriceBdt: 3000,
      promotions: [],
      creditBdt: 0,
      chargedBdt: 1200,
      seller: { name: null, address: null },
    });
  });

  it('lists the discount then the coupon with amount off and "k of N"; keeps the credit; REFUNDED / PROMOTION', () => {
    const view = toInvoiceView(
      row({
        status: 'REFUNDED',
        gateway: 'PROMOTION',
        cardType: null,
        amountBdt: 0,
        price: {
          listChargedBdt: 3000,
          chargedBdt: 1200,
          perMonthBdt: 3000,
          discount: {
            ...promo,
            name: 'Launch',
            code: null,
            amountBdt: 1500,
            months: { from: 2, to: 2, of: 3 },
          },
          coupon: {
            ...promo,
            name: 'Welcome',
            code: 'WELCOME',
            amountBdt: 300,
          },
          creditBdt: 1200,
        },
      }),
      { name: 'Seller', address: 'Dhaka' },
    );
    expect(view).toMatchObject({
      status: 'REFUNDED',
      gateway: 'PROMOTION',
      creditBdt: 1200,
      chargedBdt: 0,
      seller: { name: 'Seller', address: 'Dhaka' },
    });
    expect(view.promotions).toEqual([
      {
        type: 'DISCOUNT',
        name: 'Launch',
        code: null,
        label: 'x',
        labelBn: 'y',
        amountOffBdt: 1500,
        months: { from: 2, to: 2, of: 3 },
      },
      {
        type: 'COUPON',
        name: 'Welcome',
        code: 'WELCOME',
        label: 'x',
        labelBn: 'y',
        amountOffBdt: 300,
        months: null,
      },
    ]);
  });
});
