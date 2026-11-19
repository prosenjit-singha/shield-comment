import { type PublicPlanRow, toPublicPlan } from './public-plan.js';

const starter: PublicPlanRow = {
  id: '019a0000-0000-7000-8000-0000000000a1',
  slug: 'starter',
  name: 'Starter',
  monthlyPriceBdt: 999,
  offerPriceBdt: 499,
  offerBadge: '50% Launch Offer',
  yearlyMonthlyPriceBdt: 949,
  trialDays: 7,
  trialCommentLimit: 300,
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

describe('toPublicPlan (PW-T6)', () => {
  it('Starter: both intervals through planPrice, normalised limits + flags, trial fields', () => {
    expect(toPublicPlan(starter)).toEqual({
      id: starter.id,
      slug: 'starter',
      name: 'Starter',
      monthly: {
        perMonthBdt: 499,
        chargedBdt: 499,
        listPerMonthBdt: 999,
        badge: '50% Launch Offer',
      },
      yearly: {
        perMonthBdt: 449,
        chargedBdt: 5_388,
        listPerMonthBdt: 999,
        badge: '50% Launch Offer',
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
      trialDays: 7,
      trialCommentLimit: 300,
    });
  });

  it('no yearly price → yearly null; monthly still set', () => {
    const plan = toPublicPlan({ ...starter, yearlyMonthlyPriceBdt: null });
    expect(plan.yearly).toBeNull();
    expect(plan.monthly.perMonthBdt).toBe(499);
  });

  it('trial comment limit null → the plan’s monthly comments; no trial days → both null', () => {
    expect(
      toPublicPlan({ ...starter, trialCommentLimit: null }).trialCommentLimit,
    ).toBe(500);
    expect(toPublicPlan({ ...starter, trialDays: null })).toMatchObject({
      trialDays: null,
      trialCommentLimit: null,
    });
  });

  it('trial fields only on Starter: another plan never shows them', () => {
    expect(
      toPublicPlan({ ...starter, id: 'x', slug: 'growth', name: 'Growth' }),
    ).toMatchObject({ trialDays: null, trialCommentLimit: null });
  });

  it('legacy monthlyAiCredits key and bad values are normalised', () => {
    const plan = toPublicPlan({
      ...starter,
      featureConfig: { limits: { monthlyAiCredits: 2_500, teamSeats: -1 } },
    });
    expect(plan.limits).toEqual({
      connectedPages: 0,
      monthlyComments: 2_500,
      teamSeats: 0,
      workspaces: 0,
    });
  });
});
