import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { ListPlanAuditQueryDto } from './plan-audit.dto.js';
import { ListPlansQueryDto, UpdatePlanDto } from './plans.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts; Nest sets `forbidUnknownValues: false`). */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  return { dto, fields: errors.flatMap((e) => paths(e)) };
}

/** Dotted paths of every failing (nested) property, e.g. `featureConfig.limits.teamSeats`. */
function paths(error: ValidationError, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${error.property}` : error.property;
  const own = error.constraints ? [path] : [];
  return [...own, ...(error.children ?? []).flatMap((c) => paths(c, path))];
}

describe('ListPlansQueryDto', () => {
  it('accepts no params and rejects any param', async () => {
    expect((await check(ListPlansQueryDto, {})).fields).toEqual([]);
    expect((await check(ListPlansQueryDto, { take: '5' })).fields).toEqual([
      'take',
    ]);
  });
});

describe('UpdatePlanDto', () => {
  it('accepts a full valid body; trims the card text', async () => {
    const { dto, fields } = await check(UpdatePlanDto, {
      monthlyPriceBdt: 999,
      yearlyMonthlyPriceBdt: 449,
      badgeEn: '  Popular ',
      badgeBn: 'জনপ্রিয়',
      descriptionEn: ' For growing shops ',
      descriptionBn: 'বাড়তে থাকা দোকানের জন্য',
      isHighlighted: true,
      featureConfig: {
        limits: {
          connectedPages: 3,
          monthlyComments: 0,
          teamSeats: 2,
          workspaces: 1,
        },
        features: { customBlocklist: true, prioritySupportApi: false },
      },
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({
      monthlyPriceBdt: 999,
      yearlyMonthlyPriceBdt: 449,
      badgeEn: 'Popular',
      badgeBn: 'জনপ্রিয়',
      descriptionEn: 'For growing shops',
      isHighlighted: true,
    });
    expect(dto.featureConfig?.limits?.monthlyComments).toBe(0);
    expect(dto.featureConfig?.limits?.workspaces).toBe(1);
  });

  it('accepts an empty body at DTO level (the service answers "Nothing to update")', async () => {
    expect((await check(UpdatePlanDto, {})).fields).toEqual([]);
  });

  it('null or a blank string clears the badge / description; null clears the yearly price', async () => {
    const cleared = await check(UpdatePlanDto, {
      yearlyMonthlyPriceBdt: null,
      badgeEn: null,
      badgeBn: '   ',
      descriptionEn: '',
      descriptionBn: null,
    });
    expect(cleared.fields).toEqual([]);
    expect(cleared.dto).toMatchObject({
      yearlyMonthlyPriceBdt: null,
      badgeEn: null,
      badgeBn: null,
      descriptionEn: null,
      descriptionBn: null,
    });
  });

  it('accepts the price, text and limit bounds', async () => {
    const { fields } = await check(UpdatePlanDto, {
      monthlyPriceBdt: 1_000_000,
      yearlyMonthlyPriceBdt: 1_000_000,
      badgeEn: 'x'.repeat(24),
      descriptionBn: 'ক'.repeat(160),
      isHighlighted: false,
      featureConfig: {
        limits: {
          connectedPages: 1000,
          monthlyComments: 10_000_000,
          teamSeats: 1000,
          workspaces: 1000,
        },
      },
    });
    expect(fields).toEqual([]);
    const low = await check(UpdatePlanDto, {
      monthlyPriceBdt: 0,
      yearlyMonthlyPriceBdt: 0,
      featureConfig: { limits: { workspaces: 0 } },
    });
    expect(low.fields).toEqual([]);
  });

  it.each([
    ['negative monthly', { monthlyPriceBdt: -1 }, 'monthlyPriceBdt'],
    ['fractional monthly', { monthlyPriceBdt: 49.5 }, 'monthlyPriceBdt'],
    ['string monthly', { monthlyPriceBdt: '499' }, 'monthlyPriceBdt'],
    ['null monthly', { monthlyPriceBdt: null }, 'monthlyPriceBdt'],
    ['too large monthly', { monthlyPriceBdt: 1_000_001 }, 'monthlyPriceBdt'],
    // PR-T4: the old API names and the offer/trial fields are unknown now.
    ['legacy originalPriceBdt', { originalPriceBdt: 999 }, 'originalPriceBdt'],
    ['legacy offerPriceBdt', { offerPriceBdt: 499 }, 'offerPriceBdt'],
    ['legacy offerBadge', { offerBadge: 'Sale' }, 'offerBadge'],
    ['legacy trialDays', { trialDays: 7 }, 'trialDays'],
    [
      'legacy trialCommentLimit',
      { trialCommentLimit: 300 },
      'trialCommentLimit',
    ],
    ['badgeEn too long', { badgeEn: 'x'.repeat(25) }, 'badgeEn'],
    ['badgeBn too long', { badgeBn: 'ক'.repeat(25) }, 'badgeBn'],
    ['badge not a string', { badgeEn: 5 }, 'badgeEn'],
    [
      'descriptionEn too long',
      { descriptionEn: 'x'.repeat(161) },
      'descriptionEn',
    ],
    ['descriptionBn not a string', { descriptionBn: [] }, 'descriptionBn'],
    ['null isHighlighted', { isHighlighted: null }, 'isHighlighted'],
    ['string isHighlighted', { isHighlighted: 'true' }, 'isHighlighted'],
    ['unknown field', { name: 'Gold' }, 'name'],
    ['slug is read-only', { slug: 'gold' }, 'slug'],
    ['featureConfig not an object', { featureConfig: 'x' }, 'featureConfig'],
    ['featureConfig array', { featureConfig: [] }, 'featureConfig'],
    ['featureConfig null', { featureConfig: null }, 'featureConfig'],
    [
      'unknown featureConfig group',
      { featureConfig: { extras: {} } },
      'featureConfig.extras',
    ],
    [
      'unknown limit key',
      { featureConfig: { limits: { storageGb: 5 } } },
      'featureConfig.limits.storageGb',
    ],
    [
      'old limit name monthlyAiCredits (PW-T1b)',
      { featureConfig: { limits: { monthlyAiCredits: 500 } } },
      'featureConfig.limits.monthlyAiCredits',
    ],
    [
      'string monthlyComments',
      { featureConfig: { limits: { monthlyComments: '500' } } },
      'featureConfig.limits.monthlyComments',
    ],
    [
      'workspaces above max',
      { featureConfig: { limits: { workspaces: 1001 } } },
      'featureConfig.limits.workspaces',
    ],
    ['negative yearly', { yearlyMonthlyPriceBdt: -1 }, 'yearlyMonthlyPriceBdt'],
    [
      'fractional yearly',
      { yearlyMonthlyPriceBdt: 449.5 },
      'yearlyMonthlyPriceBdt',
    ],
    [
      'string yearly',
      { yearlyMonthlyPriceBdt: '449' },
      'yearlyMonthlyPriceBdt',
    ],
    [
      'yearly above max',
      { yearlyMonthlyPriceBdt: 1_000_001 },
      'yearlyMonthlyPriceBdt',
    ],
    [
      'unknown feature key',
      { featureConfig: { features: { aiImages: true } } },
      'featureConfig.features.aiImages',
    ],
    [
      'negative limit',
      { featureConfig: { limits: { teamSeats: -1 } } },
      'featureConfig.limits.teamSeats',
    ],
    [
      'fractional limit',
      { featureConfig: { limits: { connectedPages: 1.5 } } },
      'featureConfig.limits.connectedPages',
    ],
    [
      'limit above max',
      { featureConfig: { limits: { monthlyComments: 10_000_001 } } },
      'featureConfig.limits.monthlyComments',
    ],
    [
      'null limit',
      { featureConfig: { limits: { teamSeats: null } } },
      'featureConfig.limits.teamSeats',
    ],
    [
      'string flag',
      { featureConfig: { features: { customBlocklist: 'true' } } },
      'featureConfig.features.customBlocklist',
    ],
    [
      'limits not an object',
      { featureConfig: { limits: 5 } },
      'featureConfig.limits',
    ],
  ])('rejects %s', async (_label, body, field) => {
    const { fields } = await check(UpdatePlanDto, body);
    expect(fields).toContain(field);
  });
});

describe('ListPlanAuditQueryDto', () => {
  const PLAN_ID = '01a1ecf3-2bc3-798d-b4f7-aa6b28d1f2db';

  it('defaults to skip 0 / take 50 and converts query strings', async () => {
    const empty = await check(ListPlanAuditQueryDto, {});
    expect(empty.fields).toEqual([]);
    expect(empty.dto).toMatchObject({ skip: 0, take: 50 });
    const full = await check(ListPlanAuditQueryDto, {
      skip: '20',
      take: '100',
      planId: PLAN_ID.toUpperCase(),
    });
    expect(full.fields).toEqual([]);
    expect(full.dto).toMatchObject({
      skip: 20,
      take: 100,
      planId: PLAN_ID.toUpperCase(),
    });
  });

  it.each([
    ['negative skip', { skip: '-1' }, 'skip'],
    ['fractional skip', { skip: '1.5' }, 'skip'],
    ['text skip', { skip: 'abc' }, 'skip'],
    ['take 0', { take: '0' }, 'take'],
    ['take above 100', { take: '101' }, 'take'],
    ['malformed planId', { planId: 'not-a-uuid' }, 'planId'],
    ['planId with extra chars', { planId: `${PLAN_ID}x` }, 'planId'],
    ['planId array', { planId: [PLAN_ID, PLAN_ID] }, 'planId'],
    ['unknown param', { action: 'UPDATE' }, 'action'],
  ])('rejects %s', async (_label, query, field) => {
    expect((await check(ListPlanAuditQueryDto, query)).fields).toEqual([field]);
  });
});
