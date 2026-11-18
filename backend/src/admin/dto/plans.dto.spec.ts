import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
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
