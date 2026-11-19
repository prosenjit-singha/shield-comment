import type { PlanFeatureConfig } from '../db/schema/index.js';
import {
  auditUserAgent,
  diffPlanValues,
  isEmptyPlanPatch,
  mergePlanPatch,
  normalizeFeatureConfig,
  type PlanEditableValues,
  toAdminPlan,
  yearlyPriceError,
} from './plan-rules.js';

const config = (): PlanFeatureConfig => ({
  limits: {
    connectedPages: 5,
    monthlyComments: 15000,
    teamSeats: 3,
    workspaces: 3,
  },
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
  monthlyPriceBdt: 1499,
  yearlyMonthlyPriceBdt: null,
  badgeEn: null,
  badgeBn: null,
  descriptionEn: null,
  descriptionBn: null,
  isHighlighted: false,
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
        monthlyComments: '10',
        x: 1,
      },
      features: { customBlocklist: true, banglaAiFilter: 'yes', y: true },
      extra: {},
    });
    expect(result).toEqual({
      limits: {
        connectedPages: 2,
        monthlyComments: 0,
        teamSeats: 0,
        workspaces: 0,
      },
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

  it('reads the old monthlyAiCredits key when monthlyComments is missing (PW-T1b)', () => {
    expect(
      normalizeFeatureConfig({
        limits: { connectedPages: 1, monthlyAiCredits: 2500, teamSeats: 1 },
      }).limits,
    ).toEqual({
      connectedPages: 1,
      monthlyComments: 2500,
      teamSeats: 1,
      workspaces: 0,
    });
    // The new key wins when both are present (also when it is invalid → 0).
    expect(
      normalizeFeatureConfig({
        limits: { monthlyAiCredits: 2500, monthlyComments: 900 },
      }).limits.monthlyComments,
    ).toBe(900);
    expect(
      normalizeFeatureConfig({
        limits: { monthlyAiCredits: 2500, monthlyComments: -1 },
      }).limits.monthlyComments,
    ).toBe(0);
    // An invalid old value → 0; the old key never appears in the output.
    const result = normalizeFeatureConfig({
      limits: { monthlyAiCredits: 1.5 },
    });
    expect(result.limits).toEqual({
      connectedPages: 0,
      monthlyComments: 0,
      teamSeats: 0,
      workspaces: 0,
    });
    expect('monthlyAiCredits' in result.limits).toBe(false);
  });

  it('reads the new workspaces limit (PW-D10)', () => {
    expect(
      normalizeFeatureConfig({ limits: { workspaces: 10 } }).limits.workspaces,
    ).toBe(10);
  });

  it.each([null, undefined, 'x', 5, []])('handles %j as empty', (raw) => {
    const result = normalizeFeatureConfig(raw);
    expect(Object.values(result.limits)).toEqual([0, 0, 0, 0]);
    expect(Object.values(result.features).every((v) => v === false)).toBe(true);
  });
});

describe('isEmptyPlanPatch', () => {
  it.each([
    [{}, true],
    [{ featureConfig: {} }, true],
    [{ featureConfig: { limits: {}, features: {} } }, true],
    [{ monthlyPriceBdt: 0 }, false],
    [{ yearlyMonthlyPriceBdt: null }, false],
    [{ badgeEn: null }, false],
    [{ badgeBn: 'জনপ্রিয়' }, false],
    [{ descriptionEn: null }, false],
    [{ descriptionBn: null }, false],
    [{ isHighlighted: false }, false],
    [{ featureConfig: { limits: { workspaces: 1 } } }, false],
    [{ featureConfig: { limits: { teamSeats: 0 } } }, false],
    [{ featureConfig: { features: { customBlocklist: false } } }, false],
  ])('%j → %s', (patch, empty) => {
    expect(isEmptyPlanPatch(patch)).toBe(empty);
  });
});

describe('mergePlanPatch', () => {
  it('changes only the keys sent', () => {
    const next = mergePlanPatch(growth(), {
      badgeEn: 'Popular',
      featureConfig: {
        limits: { teamSeats: 4 },
        features: { whiteLabelReports: true },
      },
    });
    expect(next).toEqual({
      ...growth(),
      badgeEn: 'Popular',
      featureConfig: {
        limits: {
          connectedPages: 5,
          monthlyComments: 15000,
          teamSeats: 4,
          workspaces: 3,
        },
        features: { ...config().features, whiteLabelReports: true },
      },
    });
  });

  it('null clears the badge, description and yearly price; absent keeps them', () => {
    const current = {
      ...growth(),
      yearlyMonthlyPriceBdt: 1349,
      badgeEn: 'Popular',
      badgeBn: 'জনপ্রিয়',
      descriptionEn: 'For growing shops',
      descriptionBn: 'বাড়তে থাকা দোকানের জন্য',
      isHighlighted: true,
    };
    expect(mergePlanPatch(current, { monthlyPriceBdt: 2000 })).toEqual({
      ...current,
      monthlyPriceBdt: 2000,
    });
    expect(
      mergePlanPatch(current, {
        yearlyMonthlyPriceBdt: null,
        badgeEn: null,
        descriptionBn: null,
        isHighlighted: false,
      }),
    ).toMatchObject({
      yearlyMonthlyPriceBdt: null,
      badgeEn: null,
      badgeBn: 'জনপ্রিয়',
      descriptionEn: 'For growing shops',
      descriptionBn: null,
      isHighlighted: false,
    });
  });

  it('does not mutate the stored config', () => {
    const current = growth();
    mergePlanPatch(current, { featureConfig: { limits: { teamSeats: 9 } } });
    expect(current.featureConfig.limits.teamSeats).toBe(3);
  });
});

describe('yearlyPriceError (PW-D5, PR-T1)', () => {
  it.each([
    [1499, null, false],
    [1499, 1499, false],
    [1499, 1349, false],
    [1499, 1500, true],
    [0, 0, false],
    [0, 1, true],
  ])('monthly %d, yearly %s → error %s', (monthly, yearly, hasError) => {
    const values = {
      ...growth(),
      monthlyPriceBdt: monthly,
      yearlyMonthlyPriceBdt: yearly,
    };
    expect(yearlyPriceError(values) !== null).toBe(hasError);
  });

  it('names both prices', () => {
    expect(yearlyPriceError({ ...growth(), yearlyMonthlyPriceBdt: 1500 })).toBe(
      'yearlyMonthlyPriceBdt (1500) must not be greater than the monthly price (1499)',
    );
  });
});

describe('toAdminPlan', () => {
  it('serialises dates, normalises the config, no offer/trial fields (PR-T7)', () => {
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
      workspaces: 0,
    });
    expect(Object.keys(plan).sort()).toEqual(
      [
        'badgeBn',
        'badgeEn',
        'createdAt',
        'descriptionBn',
        'descriptionEn',
        'featureConfig',
        'id',
        'isActive',
        'isHighlighted',
        'monthlyPriceBdt',
        'name',
        'slug',
        'sortOrder',
        'updatedAt',
        'yearlyMonthlyPriceBdt',
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
          monthlyPriceBdt: 1499,
          badgeEn: null,
          isHighlighted: false,
          featureConfig: { limits: { teamSeats: 3 }, features: {} },
        }),
      ),
    ).toEqual([]);
  });

  it('lists only the changed fields, before → after, in PLAN_AUDIT_FIELDS order', () => {
    const after = mergePlanPatch(growth(), {
      featureConfig: {
        features: { whiteLabelReports: true },
        limits: { teamSeats: 4 },
      },
      isHighlighted: true,
      descriptionBn: 'বাংলা',
      descriptionEn: 'English',
      badgeBn: 'জনপ্রিয়',
      badgeEn: 'Popular',
      yearlyMonthlyPriceBdt: 1349,
      monthlyPriceBdt: 2499,
    });
    expect(diffPlanValues(growth(), after)).toEqual([
      { field: 'monthlyPriceBdt', before: 1499, after: 2499 },
      { field: 'yearlyMonthlyPriceBdt', before: null, after: 1349 },
      { field: 'badgeEn', before: null, after: 'Popular' },
      { field: 'badgeBn', before: null, after: 'জনপ্রিয়' },
      { field: 'descriptionEn', before: null, after: 'English' },
      { field: 'descriptionBn', before: null, after: 'বাংলা' },
      { field: 'isHighlighted', before: false, after: true },
      { field: 'featureConfig.limits.teamSeats', before: 3, after: 4 },
      {
        field: 'featureConfig.features.whiteLabelReports',
        before: false,
        after: true,
      },
    ]);
  });

  it('records clearing values as → null', () => {
    const before = { ...growth(), badgeEn: 'Sale', yearlyMonthlyPriceBdt: 999 };
    expect(
      diffPlanValues(before, {
        ...before,
        badgeEn: null,
        yearlyMonthlyPriceBdt: null,
      }),
    ).toEqual([
      { field: 'yearlyMonthlyPriceBdt', before: 999, after: null },
      { field: 'badgeEn', before: 'Sale', after: null },
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
