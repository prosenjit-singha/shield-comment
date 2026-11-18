import type { PlanFeatureConfig } from '../db/schema/index.js';
import {
  isEmptyPlanPatch,
  mergePlanPatch,
  normalizeFeatureConfig,
  offerPriceError,
  type PlanEditableValues,
  toAdminPlan,
} from './plan-rules.js';

const config = (): PlanFeatureConfig => ({
  limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 3 },
  features: {
    banglaAiFilter: true,
    autoHideScams: true,
    customBlocklist: true,
    autoReplyTemplates: true,
    messengerAlerts: true,
    whiteLabelReports: false,
    prioritySupportApi: false,
  },
});

const growth = (): PlanEditableValues => ({
  originalPriceBdt: 1499,
  offerPriceBdt: null,
  offerBadge: null,
  featureConfig: config(),
});

describe('normalizeFeatureConfig', () => {
  it('keeps a complete config as is', () => {
    expect(normalizeFeatureConfig(config())).toEqual(config());
  });

  it('fills missing keys, drops unknown ones and zeroes mistyped values', () => {
    const result = normalizeFeatureConfig({
      limits: { connectedPages: 2, teamSeats: -4, monthlyComments: '10', x: 1 },
      features: { customBlocklist: true, banglaAiFilter: 'yes', y: true },
      extra: {},
    });
    expect(result).toEqual({
      limits: { connectedPages: 2, monthlyComments: 0, teamSeats: 0 },
      features: {
        banglaAiFilter: false,
        autoHideScams: false,
        customBlocklist: true,
        autoReplyTemplates: false,
        messengerAlerts: false,
        whiteLabelReports: false,
        prioritySupportApi: false,
      },
    });
  });

  it.each([null, undefined, 'x', 5, []])('handles %j as empty', (raw) => {
    const result = normalizeFeatureConfig(raw);
    expect(Object.values(result.limits)).toEqual([0, 0, 0]);
    expect(Object.values(result.features).every((v) => v === false)).toBe(true);
  });
});

describe('isEmptyPlanPatch', () => {
  it.each([
    [{}, true],
    [{ featureConfig: {} }, true],
    [{ featureConfig: { limits: {}, features: {} } }, true],
    [{ originalPriceBdt: 0 }, false],
    [{ offerPriceBdt: null }, false],
    [{ offerBadge: null }, false],
    [{ featureConfig: { limits: { teamSeats: 0 } } }, false],
    [{ featureConfig: { features: { customBlocklist: false } } }, false],
  ])('%j → %s', (patch, empty) => {
    expect(isEmptyPlanPatch(patch)).toBe(empty);
  });
});

describe('mergePlanPatch', () => {
  it('changes only the keys sent', () => {
    const next = mergePlanPatch(growth(), {
      offerPriceBdt: 999,
      featureConfig: {
        limits: { teamSeats: 4 },
        features: { whiteLabelReports: true },
      },
    });
    expect(next).toEqual({
      originalPriceBdt: 1499,
      offerPriceBdt: 999,
      offerBadge: null,
      featureConfig: {
        limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 4 },
        features: { ...config().features, whiteLabelReports: true },
      },
    });
  });

  it('null clears the offer and the badge, absent keeps them', () => {
    const current = { ...growth(), offerPriceBdt: 999, offerBadge: '33% Off' };
    expect(mergePlanPatch(current, { originalPriceBdt: 2000 })).toMatchObject({
      originalPriceBdt: 2000,
      offerPriceBdt: 999,
      offerBadge: '33% Off',
    });
    expect(
      mergePlanPatch(current, { offerPriceBdt: null, offerBadge: null }),
    ).toMatchObject({ offerPriceBdt: null, offerBadge: null });
  });

  it('does not mutate the stored config', () => {
    const current = growth();
    mergePlanPatch(current, { featureConfig: { limits: { teamSeats: 9 } } });
    expect(current.featureConfig.limits.teamSeats).toBe(3);
  });
});

describe('offerPriceError', () => {
  it.each([
    [1499, null, false],
    [1499, 1499, false],
    [1499, 0, false],
    [0, 0, false],
    [1499, 1500, true],
    [0, 1, true],
  ])('original %d, offer %s → error %s', (original, offer, hasError) => {
    const values = {
      ...growth(),
      originalPriceBdt: original,
      offerPriceBdt: offer,
    };
    expect(offerPriceError(values) !== null).toBe(hasError);
  });
});

describe('toAdminPlan', () => {
  it('serialises dates and normalises the config', () => {
    const at = new Date('2026-11-18T10:00:00.000Z');
    const plan = toAdminPlan({
      ...growth(),
      featureConfig: {
        limits: { teamSeats: 3 },
      } as unknown as PlanFeatureConfig,
      id: 'id-1',
      slug: 'growth',
      name: 'Growth',
      sortOrder: 2,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    });
    expect(plan.createdAt).toBe('2026-11-18T10:00:00.000Z');
    expect(plan.featureConfig.limits).toEqual({
      connectedPages: 0,
      monthlyComments: 0,
      teamSeats: 3,
    });
    expect(Object.keys(plan).sort()).toEqual(
      [
        'createdAt',
        'featureConfig',
        'id',
        'isActive',
        'name',
        'offerBadge',
        'offerPriceBdt',
        'originalPriceBdt',
        'slug',
        'sortOrder',
        'updatedAt',
      ].sort(),
    );
  });
});
