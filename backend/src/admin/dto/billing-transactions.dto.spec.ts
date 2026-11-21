import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ListPaymentEventsQueryDto,
  ListTransactionsQueryDto,
  RefundTransactionDto,
} from './billing-transactions.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check(
  plain: Record<string, unknown>,
  cls: new () => object = ListTransactionsQueryDto,
) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('ListTransactionsQueryDto', () => {
  it('defaults to the first 50', async () => {
    const { dto, fields } = await check({});
    expect(fields).toEqual([]);
    expect(dto).toEqual({ skip: 0, take: 50 });
  });

  it.each([
    [
      { skip: '0', take: '1' },
      { skip: 0, take: 1 },
    ],
    [
      { skip: '40', take: '100' },
      { skip: 40, take: 100 },
    ],
  ])('accepts %j', async (plain, expected) => {
    const { dto, fields } = await check(plain);
    expect(fields).toEqual([]);
    expect(dto).toEqual(expected);
  });

  it.each([
    [{ skip: '-1' }, 'skip'],
    [{ skip: '1.5' }, 'skip'],
    [{ skip: 'abc' }, 'skip'],
    [{ take: '0' }, 'take'],
    [{ take: '101' }, 'take'],
    [{ take: '2.5' }, 'take'],
    [{ take: '' }, 'take'],
    [{ status: 'paid' }, 'status'],
    [{ gateway: 'x'.repeat(41) }, 'gateway'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ from: '2026-02-30' }, 'from'],
    [{ to: '2026-11-21T00:00:00Z' }, 'to'],
    [{ workspaceId: 'x' }, 'workspaceId'],
  ])('rejects %j', async (plain, field) => {
    expect((await check(plain)).fields).toEqual([field]);
  });

  it('accepts the M8-T8 filters (trimmed; blank q / gateway = none)', async () => {
    const { dto, fields } = await check({
      status: 'PAID',
      gateway: ' bKash ',
      q: '  ',
      from: '2026-11-01',
      to: '2026-11-21',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({
      status: 'PAID',
      gateway: 'bKash',
      q: undefined,
      from: '2026-11-01',
      to: '2026-11-21',
    });
  });
});

describe('ListPaymentEventsQueryDto + RefundTransactionDto', () => {
  it('outcome is failed or absent', async () => {
    expect((await check({}, ListPaymentEventsQueryDto)).fields).toEqual([]);
    expect(
      (await check({ outcome: 'failed' }, ListPaymentEventsQueryDto)).fields,
    ).toEqual([]);
    expect(
      (await check({ outcome: 'PAID' }, ListPaymentEventsQueryDto)).fields,
    ).toEqual(['outcome']);
  });

  it('reason: trimmed, 1–500 characters, required', async () => {
    const ok = await check(
      { reason: '  refunded in panel  ' },
      RefundTransactionDto,
    );
    expect(ok.fields).toEqual([]);
    expect(ok.dto).toEqual({ reason: 'refunded in panel' });
    expect(
      (await check({ reason: 'x'.repeat(500) }, RefundTransactionDto)).fields,
    ).toEqual([]);
    for (const reason of [undefined, '', '   ', 'x'.repeat(501), 42])
      expect((await check({ reason }, RefundTransactionDto)).fields).toEqual([
        'reason',
      ]);
  });
});
