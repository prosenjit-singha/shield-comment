import type { AccountSummarySubscription } from '../billing/billing-summary.queries.js';
import { toClientBilling } from './client-billing.js';

const PLAN = { id: '019a0000-0000-7000-8000-0000000000b1' };
const TRIAL_END = new Date('2026-11-26T06:00:00.000Z');
const TERM_END = new Date('2026-12-15T06:00:00.000Z');

function sub(
  over: Partial<AccountSummarySubscription> = {},
): AccountSummarySubscription {
  return {
    billingAccountId: '019a0000-0000-7000-8000-0000000000c1',
    id: '019a0000-0000-7000-8000-0000000000d1',
    status: 'ACTIVE',
    interval: 'month',
    trialEndsAt: null,
    currentTermEnd: TERM_END,
    plan: { ...PLAN, slug: 'growth', name: 'Growth' },
    ...over,
  };
}

const balance = { included: 2500, added: 0, used: 1234, resetsAt: TERM_END };

describe('toClientBilling (PW-T6b)', () => {
  it('trial: Starter plan, TRIALING with its end, trial comments', () => {
    const trial = sub({
      status: 'TRIALING',
      trialEndsAt: TRIAL_END,
      currentTermEnd: TRIAL_END,
      plan: { ...PLAN, slug: 'starter', name: 'Starter' },
    });
    expect(
      toClientBilling({
        live: { status: 'TRIALING' },
        subscription: trial,
        balance: { included: 300, added: 0, used: 12, resetsAt: TRIAL_END },
      }),
    ).toEqual({
      plan: { ...PLAN, slug: 'starter', name: 'Starter' },
      subscription: {
        status: 'TRIALING',
        interval: 'month',
        trialEndsAt: TRIAL_END,
        termEndsAt: TRIAL_END,
      },
      comments: { used: 12, limit: 300, resetsAt: TRIAL_END },
    });
  });

  it('active: plan + subscription + comments limit = included + added', () => {
    expect(
      toClientBilling({
        live: { status: 'ACTIVE' },
        subscription: sub({ interval: 'year' }),
        balance: { ...balance, added: 100 },
      }),
    ).toEqual({
      plan: { ...PLAN, slug: 'growth', name: 'Growth' },
      subscription: {
        status: 'ACTIVE',
        interval: 'year',
        trialEndsAt: null,
        termEndsAt: TERM_END,
      },
      comments: { used: 1234, limit: 2600, resetsAt: TERM_END },
    });
  });

  it('expired: no plan, the ended subscription, zero comments', () => {
    expect(
      toClientBilling({
        live: null,
        subscription: sub({ status: 'EXPIRED' }),
        balance: null,
      }),
    ).toEqual({
      plan: null,
      subscription: {
        status: 'EXPIRED',
        interval: 'month',
        trialEndsAt: null,
        termEndsAt: TERM_END,
      },
      comments: { used: 0, limit: 0, resetsAt: null },
    });
  });

  it('a stale live row (term over, not flipped yet) reads EXPIRED; CANCELED stays CANCELED', () => {
    const stale = toClientBilling({
      live: null,
      subscription: sub({
        status: 'TRIALING',
        trialEndsAt: TRIAL_END,
        currentTermEnd: TRIAL_END,
      }),
      balance: null,
    });
    expect(stale.subscription).toEqual({
      status: 'EXPIRED',
      interval: 'month',
      trialEndsAt: TRIAL_END,
      termEndsAt: TRIAL_END,
    });
    expect(stale.plan).toBeNull();
    expect(
      toClientBilling({
        live: null,
        subscription: sub({ status: 'CANCELED' }),
        balance: null,
      }).subscription?.status,
    ).toBe('CANCELED');
  });

  it('no account / never subscribed: everything empty, comments zero', () => {
    expect(
      toClientBilling({ live: null, subscription: null, balance: null }),
    ).toEqual({
      plan: null,
      subscription: null,
      comments: { used: 0, limit: 0, resetsAt: null },
    });
  });

  it('wallet read failed (balance undefined) → comments null, the rest still mapped', () => {
    expect(
      toClientBilling({
        live: { status: 'ACTIVE' },
        subscription: sub(),
        balance: undefined,
      }),
    ).toMatchObject({
      plan: { slug: 'growth' },
      subscription: { status: 'ACTIVE' },
      comments: null,
    });
  });

  it('a live plan whose balance is missing reads zero comments (race with the expiry)', () => {
    expect(
      toClientBilling({
        live: { status: 'ACTIVE' },
        subscription: sub(),
        balance: null,
      }).comments,
    ).toEqual({ used: 0, limit: 0, resetsAt: null });
  });
});
