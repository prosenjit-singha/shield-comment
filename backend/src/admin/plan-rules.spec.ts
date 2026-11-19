import type { PlanFeatureConfig } from '../db/schema/index.js';
import {
  auditUserAgent,
  diffPlanValues,
  isEmptyPlanPatch,
  mergePlanPatch,
  normalizeFeatureConfig,
  offerPriceError,
  type PlanEditableValues,
  toAdminPlan,
} from './plan-rules.js';

const config = (): PlanFeatureConfig => ({
  limits: { connectedPages: 5, monthlyAiCredits: 15000, teamSeats: 3 },
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
      limits: {
        connectedPages: 2,
        teamSeats: -4,
        monthlyAiCredits: '10',
        x: 1,
      },
      features: { customBlocklist: true, banglaAiFilter: 'yes', y: true },
      extra: {},
    });
    expect(result).toEqual({
      limits: { connectedPages: 2, monthlyAiCredits: 0, teamSeats: 0 },
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

  it('reads the old monthlyComments key when monthlyAiCredits is missing (M5-T11)', () => {
    expect(
      normalizeFeatureConfig({
        limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1 },
      }).limits,
    ).toEqual({ connectedPages: 1, monthlyAiCredits: 2500, teamSeats: 1 });
    // The new key wins when both are present (also when it is invalid → 0).
    expect(
      normalizeFeatureConfig({
        limits: { monthlyComments: 2500, monthlyAiCredits: 900 },
      }).limits.monthlyAiCredits,
    ).toBe(900);
    expect(
      normalizeFeatureConfig({
        limits: { monthlyComments: 2500, monthlyAiCredits: -1 },
      }).limits.monthlyAiCredits,
    ).toBe(0);
    // An invalid old value → 0; the old key never appears in the output.
    const result = normalizeFeatureConfig({
      limits: { monthlyComments: 1.5 },
    });
    expect(result.limits).toEqual({
      connectedPages: 0,
      monthlyAiCredits: 0,
      teamSeats: 0,
    });
    expect('monthlyComments' in result.limits).toBe(false);
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
        limits: { connectedPages: 5, monthlyAiCredits: 15000, teamSeats: 4 },
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
      monthlyAiCredits: 0,
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

describe('diffPlanValues', () => {
  it('is empty when nothing changed (also for a merged re-send of the stored values)', () => {
    expect(diffPlanValues(growth(), growth())).toEqual([]);
    expect(
      diffPlanValues(
        growth(),
        mergePlanPatch(growth(), {
          originalPriceBdt: 1499,
          offerPriceBdt: null,
          featureConfig: { limits: { teamSeats: 3 }, features: {} },
        }),
      ),
    ).toEqual([]);
  });

  it('lists only the changed fields, before → after, in a stable order', () => {
    const after = mergePlanPatch(growth(), {
      featureConfig: {
        features: { whiteLabelReports: true },
        limits: { teamSeats: 4 },
      },
      offerBadge: '40% Off',
      offerPriceBdt: 1499,
      originalPriceBdt: 2499,
    });
    expect(diffPlanValues(growth(), after)).toEqual([
      { field: 'originalPriceBdt', before: 1499, after: 2499 },
      { field: 'offerPriceBdt', before: null, after: 1499 },
      { field: 'offerBadge', before: null, after: '40% Off' },
      { field: 'featureConfig.limits.teamSeats', before: 3, after: 4 },
      {
        field: 'featureConfig.features.whiteLabelReports',
        before: false,
        after: true,
      },
    ]);
  });

  it('records clearing the offer and badge as → null', () => {
    const before = { ...growth(), offerPriceBdt: 999, offerBadge: 'Sale' };
    expect(
      diffPlanValues(before, {
        ...before,
        offerPriceBdt: null,
        offerBadge: null,
      }),
    ).toEqual([
      { field: 'offerPriceBdt', before: 999, after: null },
      { field: 'offerBadge', before: 'Sale', after: null },
    ]);
  });

  it('compares normalized feature configs (a missing stored key counts as 0 / false)', () => {
    const stored = {
      ...growth(),
      featureConfig: {
        limits: {},
        features: {},
      } as unknown as PlanFeatureConfig,
    };
    const after = mergePlanPatch(stored, {
      featureConfig: { limits: { teamSeats: 0, connectedPages: 2 } },
    });
    expect(diffPlanValues(stored, after)).toEqual([
      { field: 'featureConfig.limits.connectedPages', before: 0, after: 2 },
    ]);
  });
});

describe('auditUserAgent', () => {
  it('trims, keeps null for a missing or blank header and takes the first of an array', () => {
    expect(auditUserAgent('  curl/8.0  ')).toBe('curl/8.0');
    expect(auditUserAgent(undefined)).toBeNull();
    expect(auditUserAgent('   ')).toBeNull();
    expect(auditUserAgent(['a/1', 'b/2'])).toBe('a/1');
  });

  it('cuts at 512 code points without splitting a surrogate pair', () => {
    expect(auditUserAgent('x'.repeat(600))).toHaveLength(512);
    const emoji = auditUserAgent('x'.repeat(511) + '😀😀')!;
    expect(Array.from(emoji)).toHaveLength(512);
    expect(emoji.endsWith('😀')).toBe(true);
  });
});
