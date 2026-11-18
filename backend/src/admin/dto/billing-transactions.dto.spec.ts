import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AdminBillingService } from '../admin-billing.service.js';
import { ListTransactionsQueryDto } from './billing-transactions.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(ListTransactionsQueryDto, plain);
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
    [{ status: 'PAID' }, 'status'],
    [{ gateway: 'bkash' }, 'gateway'],
  ])('rejects %j', async (plain, field) => {
    expect((await check(plain)).fields).toEqual([field]);
  });
});

describe('AdminBillingService.listTransactions', () => {
  it('returns the final shape with an empty list until Module 8', async () => {
    const service = new AdminBillingService();
    await expect(
      service.listTransactions({ skip: 20, take: 10 }),
    ).resolves.toEqual({ items: [], total: 0, skip: 20, take: 10 });
  });
});
