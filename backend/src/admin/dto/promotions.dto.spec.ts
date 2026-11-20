import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdatePlatformSettingsDto } from './platform-settings.dto.js';
import {
  CreatePromotionDto,
  ListPromotionsQueryDto,
  UpdatePromotionDto,
} from './promotions.dto.js';

/** Same options as the global ValidationPipe. */
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
  return { dto, fields: errors.map((e) => e.property) };
}

const PLAN = '01a1ecf3-0000-7000-8000-000000000001';

describe('CreatePromotionDto', () => {
  it('trims the name, trims + uppercases the code', async () => {
    const { dto, fields } = await check(CreatePromotionDto, {
      kind: 'COUPON',
      name: '  Eid sale ',
      code: ' eid-2026 ',
      planIds: [PLAN],
      endsOn: '2026-12-31',
      maxRedemptions: 10,
      discountType: 'PERCENT',
      discountValue: 20,
      discountScope: 'TOTAL',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ name: 'Eid sale', code: 'EID-2026' });
  });

  it.each([
    ['missing kind', { name: 'x' }, 'kind'],
    ['unknown kind', { kind: 'GIFT', name: 'x' }, 'kind'],
    ['missing name', { kind: 'TRIAL' }, 'name'],
    ['blank name', { kind: 'TRIAL', name: '   ' }, 'name'],
    ['name over 60', { kind: 'TRIAL', name: 'x'.repeat(61) }, 'name'],
    ['code too short', { kind: 'COUPON', name: 'x', code: 'ab' }, 'code'],
    ['code with a space', { kind: 'COUPON', name: 'x', code: 'A B C' }, 'code'],
    [
      'planIds not uuids',
      { kind: 'TRIAL', name: 'x', planIds: ['x'] },
      'planIds',
    ],
    [
      'planIds repeated',
      { kind: 'TRIAL', name: 'x', planIds: [PLAN, PLAN] },
      'planIds',
    ],
    ['allPlans null', { kind: 'TRIAL', name: 'x', allPlans: null }, 'allPlans'],
    [
      'endsOn not a date',
      { kind: 'TRIAL', name: 'x', endsOn: '2026-02-30' },
      'endsOn',
    ],
    [
      'cap 0',
      { kind: 'TRIAL', name: 'x', maxRedemptions: 0 },
      'maxRedemptions',
    ],
    ['trialDays 91', { kind: 'TRIAL', name: 'x', trialDays: 91 }, 'trialDays'],
    [
      'negative trial limit',
      { kind: 'TRIAL', name: 'x', trialCommentLimit: -1 },
      'trialCommentLimit',
    ],
    [
      'unknown type',
      { kind: 'DISCOUNT', name: 'x', discountType: 'BOGO' },
      'discountType',
    ],
    [
      'value 0',
      { kind: 'DISCOUNT', name: 'x', discountValue: 0 },
      'discountValue',
    ],
    [
      'unknown scope',
      { kind: 'DISCOUNT', name: 'x', discountScope: 'YEAR' },
      'discountScope',
    ],
    [
      'months 0',
      { kind: 'DISCOUNT', name: 'x', durationMonths: 0 },
      'durationMonths',
    ],
    [
      'months above 120',
      { kind: 'DISCOUNT', name: 'x', durationMonths: 121 },
      'durationMonths',
    ],
    [
      'unknown field',
      { kind: 'TRIAL', name: 'x', stoppedAt: 'now' },
      'stoppedAt',
    ],
  ])('rejects %s', async (_label, body, field) => {
    expect((await check(CreatePromotionDto, body)).fields).toContain(field);
  });
});

describe('UpdatePromotionDto', () => {
  it('accepts an empty body (the service answers "Nothing to update") and nulls that clear', async () => {
    expect((await check(UpdatePromotionDto, {})).fields).toEqual([]);
    expect(
      (
        await check(UpdatePromotionDto, {
          endsOn: null,
          maxRedemptions: null,
          durationMonths: null,
        })
      ).fields,
    ).toEqual([]);
  });

  it.each([
    ['kind', { kind: 'TRIAL' }, 'kind'],
    ['null name', { name: null }, 'name'],
    ['null planIds', { planIds: null }, 'planIds'],
  ])('rejects %s', async (_label, body, field) => {
    expect((await check(UpdatePromotionDto, body)).fields).toContain(field);
  });
});

describe('ListPromotionsQueryDto', () => {
  it('takes kind + status filters only', async () => {
    expect(
      (
        await check(ListPromotionsQueryDto, {
          kind: 'COUPON',
          status: 'USED_UP',
        })
      ).fields,
    ).toEqual([]);
    for (const [query, field] of [
      [{ kind: 'coupon' }, 'kind'],
      [{ status: 'Live' }, 'status'],
      [{ take: '5' }, 'take'],
    ] as const)
      expect((await check(ListPromotionsQueryDto, query)).fields).toEqual([
        field,
      ]);
  });
});

describe('UpdatePlatformSettingsDto (PR-D18)', () => {
  it.each([
    ['8801712345678', '8801712345678'],
    [' 8801912345678 ', '8801912345678'],
    [null, null],
    ['  ', null],
  ])('accepts %j → %j', async (value, stored) => {
    const { dto, fields } = await check(UpdatePlatformSettingsDto, {
      supportWhatsappNumber: value,
    });
    expect(fields).toEqual([]);
    expect(dto.supportWhatsappNumber).toBe(stored);
  });

  it.each([
    [{ supportWhatsappNumber: '01712345678' }],
    [{ supportWhatsappNumber: '+8801712345678' }],
    [{ supportWhatsappNumber: '8801212345678' }],
    [{ supportWhatsappNumber: '88017123456789' }],
    [{ supportWhatsappNumber: 8801712345678 }],
  ])('rejects %j', async (body) => {
    expect((await check(UpdatePlatformSettingsDto, body)).fields).toEqual([
      'supportWhatsappNumber',
    ]);
  });

  // M6-T7b: partial body; the empty-body 400 is the service's (AdminPlansService spec).
  it.each([
    [{}],
    [{ playgroundDailyLimit: 0 }],
    [{ playgroundDailyLimit: 25 }],
    [{ playgroundDailyLimit: 1000 }],
    [{ supportWhatsappNumber: null, playgroundDailyLimit: 10 }],
  ])('partial: accepts %j', async (body) => {
    const { dto, fields } = await check(UpdatePlatformSettingsDto, body);
    expect(fields).toEqual([]);
    expect(dto.supportWhatsappNumber).toBe(
      (body as { supportWhatsappNumber?: null }).supportWhatsappNumber,
    );
  });

  it.each([-1, 1001, 2.5, '5', null, true, Number.NaN])(
    'rejects playgroundDailyLimit %j',
    async (value) => {
      expect(
        (
          await check(UpdatePlatformSettingsDto, {
            playgroundDailyLimit: value,
          })
        ).fields,
      ).toEqual(['playgroundDailyLimit']);
    },
  );
});
