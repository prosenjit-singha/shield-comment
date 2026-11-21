import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { LiveSubscription } from '../wallet/live-subscription.queries.js';
import {
  type BillingSummaryInput,
  toBillingSummary,
} from './billing-summary.js';
import type { SummarySubscription } from './billing-summary.queries.js';

const TRIAL_END = new Date('2026-11-26T10:00:00.000Z');
const TERM_END = new Date('2026-12-19T10:00:00.000Z');
const RESET = new Date('2026-12-19T10:00:00.000Z');

const livePlan = (
  status: LiveSubscription['status'],
  limits: { connectedPages: number; workspaces: number },
): BillingSummaryInput['live'] => ({
  status,
  plan: {
    id: '019a0000-0000-7000-8000-0000000000c1',
    slug: status === 'TRIALING' ? 'starter' : 'growth',
    featureConfig: normalizeFeatureConfig({
      limits: { ...limits, monthlyComments: 2_500, teamSeats: 3 },
      features: {},
    }),
    trialCommentLimit: null,
  },
});

const sub = (
  patch: Partial<SummarySubscription> & Pick<SummarySubscription, 'status'>,
): SummarySubscription => ({
  id: '019a0000-0000-7000-8000-0000000000d1',
  interval: 'month',
  trialEndsAt: null,
  currentTermEnd: TERM_END,
  plan: { slug: 'growth', name: 'Growth' },
  ...patch,
});

describe('toBillingSummary (PW-T6)', () => {
  it('trial: TRIALING, trial end = term end = comments reset, Starter limits', () => {
    expect(
      toBillingSummary({
        live: livePlan('TRIALING', { connectedPages: 1, workspaces: 1 }),
        subscription: sub({
          status: 'TRIALING',
          trialEndsAt: TRIAL_END,
          currentTermEnd: TRIAL_END,
          plan: { slug: 'starter', name: 'Starter' },
        }),
        balance: { included: 300, added: 0, used: 12, resetsAt: TRIAL_END },
        workspaceCount: 1,
        activePages: 1,
        trialEligible: false,
      }),
    ).toEqual({
      plan: { slug: 'starter', name: 'Starter' },
      interval: 'month',
      status: 'TRIALING',
      trialEndsAt: TRIAL_END,
      termEndsAt: TRIAL_END,
      comments: { used: 12, limit: 300, resetsAt: TRIAL_END },
      workspaces: { used: 1, limit: 1 },
      pages: { used: 1, limit: 1 },
      trialEligible: false,
      renewal: null,
      pendingPayment: null,
      scheduled: null,
      autoRenew: { available: false, enabled: false, tokenSaved: false },
    });
  });

  it('active paid term: ACTIVE, no trial end, comments limit = included + added', () => {
    const summary = toBillingSummary({
      live: livePlan('ACTIVE', { connectedPages: 5, workspaces: 3 }),
      subscription: sub({ status: 'ACTIVE', interval: 'year' }),
      balance: { included: 2_500, added: 100, used: 1_234, resetsAt: RESET },
      workspaceCount: 2,
      activePages: 4,
      trialEligible: false,
    });
    expect(summary).toEqual({
      plan: { slug: 'growth', name: 'Growth' },
      interval: 'year',
      status: 'ACTIVE',
      trialEndsAt: null,
      termEndsAt: TERM_END,
      comments: { used: 1_234, limit: 2_600, resetsAt: RESET },
      workspaces: { used: 2, limit: 3 },
      pages: { used: 4, limit: 5 },
      trialEligible: false,
      renewal: null,
      pendingPayment: null,
      scheduled: null,
      autoRenew: { available: false, enabled: false, tokenSaved: false },
    });
  });

  it('expired trial (no live plan): the ended plan + its dates, every limit 0, comments 0/0, no reset', () => {
    expect(
      toBillingSummary({
        live: null,
        subscription: sub({
          status: 'EXPIRED',
          trialEndsAt: TRIAL_END,
          currentTermEnd: TRIAL_END,
          plan: { slug: 'starter', name: 'Starter' },
        }),
        balance: null,
        workspaceCount: 1,
        activePages: 2,
        trialEligible: false,
      }),
    ).toEqual({
      plan: { slug: 'starter', name: 'Starter' },
      interval: 'month',
      status: 'EXPIRED',
      trialEndsAt: TRIAL_END,
      termEndsAt: TRIAL_END,
      comments: { used: 0, limit: 0, resetsAt: null },
      workspaces: { used: 1, limit: 0 },
      pages: { used: 2, limit: 0 },
      trialEligible: false,
      renewal: null,
      pendingPayment: null,
      scheduled: null,
      autoRenew: { available: false, enabled: false, tokenSaved: false },
    });
  });

  it('a live status whose term is over (expiry job not run yet) reads EXPIRED; CANCELED stays CANCELED', () => {
    const base = {
      live: null,
      balance: null,
      workspaceCount: 1,
      activePages: 0,
      trialEligible: false,
    };
    for (const status of ['TRIALING', 'ACTIVE'] as const) {
      expect(
        toBillingSummary({ ...base, subscription: sub({ status }) }).status,
      ).toBe('EXPIRED');
    }
    expect(
      toBillingSummary({ ...base, subscription: sub({ status: 'CANCELED' }) })
        .status,
    ).toBe('CANCELED');
  });

  it('never subscribed: NONE, plan + interval + dates null, limits 0, trialEligible passed through', () => {
    expect(
      toBillingSummary({
        live: null,
        subscription: null,
        balance: null,
        workspaceCount: 1,
        activePages: 0,
        trialEligible: true,
      }),
    ).toEqual({
      plan: null,
      interval: null,
      status: 'NONE',
      trialEndsAt: null,
      termEndsAt: null,
      comments: { used: 0, limit: 0, resetsAt: null },
      workspaces: { used: 1, limit: 0 },
      pages: { used: 0, limit: 0 },
      trialEligible: true,
      renewal: null,
      pendingPayment: null,
      scheduled: null,
      autoRenew: { available: false, enabled: false, tokenSaved: false },
    });
  });

  it('a live plan without a balance (race) still shows 0/0 comments rather than throwing', () => {
    const summary = toBillingSummary({
      live: livePlan('ACTIVE', { connectedPages: 5, workspaces: 3 }),
      subscription: sub({ status: 'ACTIVE' }),
      balance: null,
      workspaceCount: 1,
      activePages: 0,
      trialEligible: false,
    });
    expect(summary.comments).toEqual({ used: 0, limit: 0, resetsAt: null });
    expect(summary.status).toBe('ACTIVE');
  });
});
