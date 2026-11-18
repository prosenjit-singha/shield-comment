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
  it('accepts a full valid body', async () => {
    const { dto, fields } = await check(UpdatePlanDto, {
      originalPriceBdt: 999,
      offerPriceBdt: 499,
      offerBadge: '  50% Launch Offer ',
      featureConfig: {
        limits: { connectedPages: 3, monthlyComments: 0, teamSeats: 2 },
        features: { customBlocklist: true, prioritySupportApi: false },
      },
    });
    expect(fields).toEqual([]);
    expect(dto.offerBadge).toBe('50% Launch Offer');
    expect(dto.featureConfig?.limits?.monthlyComments).toBe(0);
  });

  it('accepts an empty body at DTO level (the service answers "Nothing to update")', async () => {
    expect((await check(UpdatePlanDto, {})).fields).toEqual([]);
  });

  it('accepts null to clear the offer and the badge; blank badge becomes null', async () => {
    const cleared = await check(UpdatePlanDto, {
      offerPriceBdt: null,
      offerBadge: null,
    });
    expect(cleared.fields).toEqual([]);
    expect(cleared.dto).toMatchObject({
      offerPriceBdt: null,
      offerBadge: null,
    });
    const blank = await check(UpdatePlanDto, { offerBadge: '   ' });
    expect(blank.fields).toEqual([]);
    expect(blank.dto.offerBadge).toBeNull();
  });

  it('accepts the price and limit bounds', async () => {
    const { fields } = await check(UpdatePlanDto, {
      originalPriceBdt: 1_000_000,
      offerPriceBdt: 0,
      offerBadge: 'x'.repeat(40),
      featureConfig: {
        limits: {
          connectedPages: 1000,
          monthlyComments: 10_000_000,
          teamSeats: 1000,
        },
      },
    });
    expect(fields).toEqual([]);
  });

  it.each([
    ['negative original', { originalPriceBdt: -1 }, 'originalPriceBdt'],
    ['fractional original', { originalPriceBdt: 49.5 }, 'originalPriceBdt'],
    ['string original', { originalPriceBdt: '499' }, 'originalPriceBdt'],
    ['null original', { originalPriceBdt: null }, 'originalPriceBdt'],
    ['too large original', { originalPriceBdt: 1_000_001 }, 'originalPriceBdt'],
    ['negative offer', { offerPriceBdt: -5 }, 'offerPriceBdt'],
    ['string offer', { offerPriceBdt: '10' }, 'offerPriceBdt'],
    ['badge too long', { offerBadge: 'x'.repeat(41) }, 'offerBadge'],
    ['badge not a string', { offerBadge: 5 }, 'offerBadge'],
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
