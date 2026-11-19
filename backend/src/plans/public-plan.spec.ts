import type { PublicPlan } from './dto/public-plan.dto.js';
import type { PriceDiscount } from './plan-price.js';
import {
  type PublicPlanRow,
  toPublicPlan,
  yearlySaveUpToPercent,
} from './public-plan.js';

const starter: PublicPlanRow = {
  id: '019a0000-0000-7000-8000-0000000000a1',
  slug: 'starter',
  name: 'Starter',
  monthlyPriceBdt: 999,
  yearlyMonthlyPriceBdt: 949,
  badgeEn: null,
  badgeBn: null,
  descriptionEn: null,
  descriptionBn: null,
  isHighlighted: false,
  featureConfig: {
    limits: {
      connectedPages: 1,
      monthlyComments: 500,
      teamSeats: 1,
      workspaces: 1,
    },
    features: { banglaAiFilter: true, autoHideScams: true },
  },
};

const launch: PriceDiscount = {
  promotionId: 'launch',
  discountType: 'FLAT',
  discountValue: 500,
  discountScope: 'PER_MONTH',
  durationMonths: null,
  endsAt: null,
};
const trial = {
  promotionId: 'trial',
  days: 7,
  commentLimit: 300,
  endsAt: null,
};

describe('toPublicPlan (PR-T2)', () => {
  it('Starter with the Launch offer + trial: prices, texts, limits + flags, trial', () => {
    expect(toPublicPlan(starter, [launch], trial)).toEqual({
      id: starter.id,
      slug: 'starter',
      name: 'Starter',
      badge: null,
      description: null,
      highlighted: false,
      monthly: {
        listPerMonthBdt: 999,
        listChargedBdt: 999,
        perMonthBdt: 499,
        chargedBdt: 499,
        saving: {
          promotionId: 'launch',
          label: '৳500 off',
          labelBn: '৳৫০০ ছাড়',
          amountBdt: 500,
        },
      },
      yearly: {
        listPerMonthBdt: 949,
        listChargedBdt: 11_388,
        perMonthBdt: 449,
        chargedBdt: 5_388,
        saving: {
          promotionId: 'launch',
          label: '৳500 off',
          labelBn: '৳৫০০ ছাড়',
          amountBdt: 6_000,
        },
      },
      limits: {
        connectedPages: 1,
        monthlyComments: 500,
        teamSeats: 1,
        workspaces: 1,
      },
      features: {
        banglaAiFilter: true,
        autoHideScams: true,
        customBlocklist: false,
        autoReplyTemplates: false,
        messengerAlerts: false,
        whiteLabelReports: false,
        prioritySupportApi: false,
      },
      trial: { promotionId: 'trial', days: 7, commentLimit: 300, endsAt: null },
    });
  });

  it('no discount → list prices; no yearly price → yearly null; no trial → null', () => {
    const plan = toPublicPlan(
      { ...starter, yearlyMonthlyPriceBdt: null },
      [],
      null,
    );
    expect(plan.monthly).toMatchObject({ perMonthBdt: 999, saving: null });
    expect(plan.yearly).toBeNull();
    expect(plan.trial).toBeNull();
  });

  it('trial comment limit null → the plan’s monthly comments', () => {
    expect(
      toPublicPlan(starter, [], { ...trial, commentLimit: null }).trial
        ?.commentLimit,
    ).toBe(500);
  });

  it('badge/description: bn falls back to en and en to bn; both empty → null; highlight', () => {
    const plan = toPublicPlan(
      {
        ...starter,
        badgeEn: 'Popular',
        descriptionBn: 'ছোট দোকানের জন্য',
        isHighlighted: true,
      },
      [],
      null,
    );
    expect(plan.badge).toEqual({ en: 'Popular', bn: 'Popular' });
    expect(plan.description).toEqual({
      en: 'ছোট দোকানের জন্য',
      bn: 'ছোট দোকানের জন্য',
    });
    expect(plan.highlighted).toBe(true);
    expect(
      toPublicPlan({ ...starter, badgeEn: 'A', badgeBn: 'B' }, [], null).badge,
    ).toEqual({ en: 'A', bn: 'B' });
  });

  it('legacy monthlyAiCredits key and bad values are normalised', () => {
    const plan = toPublicPlan(
      {
        ...starter,
        featureConfig: { limits: { monthlyAiCredits: 2_500, teamSeats: -1 } },
      },
      [],
      null,
    );
    expect(plan.limits).toEqual({
      connectedPages: 0,
      monthlyComments: 2_500,
      teamSeats: 0,
      workspaces: 0,
    });
  });
});

describe('yearlySaveUpToPercent (PR-T2)', () => {
  const card = (month: number, year: number | null) =>
    ({
      monthly: { perMonthBdt: month },
      yearly: year === null ? null : { perMonthBdt: year },
    }) as PublicPlan;

  it('max over plans of the shown per-month prices, rounded down', () => {
    // Seeds: 449/499 = 10.02 %, 1,349/1,499 = 10.006 %, 3,599/3,999 = 10.002 % → 10.
    expect(
      yearlySaveUpToPercent([
        card(499, 449),
        card(1499, 1349),
        card(3999, 3599),
      ]),
    ).toBe(10);
    expect(yearlySaveUpToPercent([card(1000, 750), card(1000, 900)])).toBe(25);
  });

  it('no yearly option, a ৳0 monthly price or no plans → 0', () => {
    expect(yearlySaveUpToPercent([card(999, null), card(0, 0)])).toBe(0);
    expect(yearlySaveUpToPercent([])).toBe(0);
  });
});
