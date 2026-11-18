import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListClientsQueryDto } from './list-clients-query.dto.js';
import { UpdateClientStatusDto } from './update-client-status.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check<T extends object>(
  cls: new () => T,
  plain: Record<string, unknown>,
) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('ListClientsQueryDto', () => {
  it('defaults to the first 50, newest first, unfiltered', async () => {
    const { dto, fields } = await check(ListClientsQueryDto, {});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ skip: 0, take: 50, sort: 'newest' });
    expect(dto.q).toBeUndefined();
  });

  it('accepts every filter and trims q (blank q = no search)', async () => {
    const { dto, fields } = await check(ListClientsQueryDto, {
      skip: '10',
      take: '100',
      q: '  Rahim ',
      status: 'SUSPENDED',
      createdFrom: '2026-11-01',
      createdTo: '2026-11-18T23:59:59.999+06:00',
      sort: 'name',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({
      skip: 10,
      take: 100,
      q: 'Rahim',
      sort: 'name',
    });
    expect(
      (await check(ListClientsQueryDto, { q: '   ' })).dto.q,
    ).toBeUndefined();
  });

  it('accepts a plan slug or none (existence is checked by the service)', async () => {
    for (const plan of ['growth', 'none', 'pro-annual', 'unknown-plan']) {
      const { dto, fields } = await check(ListClientsQueryDto, { plan });
      expect(fields).toEqual([]);
      expect(dto.plan).toBe(plan);
    }
  });

  it.each([
    [{ take: '101' }, 'take'],
    [{ skip: '-1' }, 'skip'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ status: 'active' }, 'status'],
    [{ status: 'DELETED' }, 'status'],
    [{ sort: 'newest,name' }, 'sort'],
    [{ sort: 'createdAt' }, 'sort'],
    [{ createdFrom: 'yesterday' }, 'createdFrom'],
    [{ createdFrom: '2026-02-30' }, 'createdFrom'],
    [{ createdFrom: '2026-W47' }, 'createdFrom'],
    [{ createdTo: '2026-11-18T10:00:00' }, 'createdTo'],
    [{ createdTo: '1731900000000' }, 'createdTo'],
    [{ plan: 'Growth' }, 'plan'],
    [{ plan: ' growth' }, 'plan'],
    [{ plan: 'growth plan' }, 'plan'],
    [{ plan: '' }, 'plan'],
    [{ plan: ['growth', 'pro'] }, 'plan'],
    [{ plan: 'x'.repeat(41) }, 'plan'],
    [{ planId: 'growth' }, 'planId'],
  ])('rejects %j', async (plain, field) => {
    expect((await check(ListClientsQueryDto, plain)).fields).toEqual([field]);
  });
});

describe('UpdateClientStatusDto', () => {
  it('accepts a status and a trimmed reason', async () => {
    const { dto, fields } = await check(UpdateClientStatusDto, {
      status: 'SUSPENDED',
      reason: '  Chargeback fraud  ',
    });
    expect(fields).toEqual([]);
    expect(dto).toEqual({ status: 'SUSPENDED', reason: 'Chargeback fraud' });
  });

  it.each([
    [{ reason: 'x' }, ['status']],
    [{ status: 'suspended', reason: 'x' }, ['status']],
    [{ status: 'SUSPENDED' }, ['reason']],
    [{ status: 'SUSPENDED', reason: '' }, ['reason']],
    [{ status: 'SUSPENDED', reason: '   ' }, ['reason']],
    [{ status: 'SUSPENDED', reason: 42 }, ['reason']],
    [{ status: 'SUSPENDED', reason: 'x'.repeat(501) }, ['reason']],
    [{ status: 'ACTIVE', reason: 'ok', note: 'x' }, ['note']],
  ])('rejects %j', async (plain, expected) => {
    expect((await check(UpdateClientStatusDto, plain)).fields).toEqual(
      expected,
    );
  });

  it('allows exactly 500 characters', async () => {
    const reason = 'x'.repeat(500);
    expect(
      (await check(UpdateClientStatusDto, { status: 'ACTIVE', reason })).fields,
    ).toEqual([]);
  });
});
