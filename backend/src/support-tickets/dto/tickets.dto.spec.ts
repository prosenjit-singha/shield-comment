import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  ClientReplyTicketDto,
  CreateTicketDto,
  ListTicketsQueryDto,
  ReplyTicketDto,
  TicketsPageQueryDto,
  UpdateTicketStatusDto,
} from './tickets.dto.js';

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

const WS = '019a0000-0000-7000-8000-000000000001';

describe('ListTicketsQueryDto', () => {
  it('defaults to the first 50, unfiltered', async () => {
    const { dto, fields } = await check(ListTicketsQueryDto, {});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ skip: 0, take: 50 });
    expect(dto.q).toBeUndefined();
  });

  it('accepts every filter, converts numbers and trims q', async () => {
    const { dto, fields } = await check(ListTicketsQueryDto, {
      skip: '20',
      take: '100',
      status: 'IN_PROGRESS',
      category: 'TECHNICAL',
      priority: 'HIGH',
      workspaceId: WS,
      q: '  bKash ',
    });
    expect(fields).toEqual([]);
    expect(dto).toEqual({
      skip: 20,
      take: 100,
      status: 'IN_PROGRESS',
      category: 'TECHNICAL',
      priority: 'HIGH',
      workspaceId: WS,
      q: 'bKash',
    });
  });

  it('blank q = no search', async () => {
    const { dto, fields } = await check(ListTicketsQueryDto, { q: '   ' });
    expect(fields).toEqual([]);
    expect(dto.q).toBeUndefined();
  });

  it.each([
    [{ take: '0' }, 'take'],
    [{ take: '101' }, 'take'],
    [{ take: '1.5' }, 'take'],
    [{ skip: '-1' }, 'skip'],
    [{ skip: 'abc' }, 'skip'],
    [{ status: 'open' }, 'status'],
    [{ status: 'CLOSED' }, 'status'],
    [{ category: 'META' }, 'category'],
    [{ priority: 'URGENT' }, 'priority'],
    [{ workspaceId: 'not-a-uuid' }, 'workspaceId'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ sort: 'oldest' }, 'sort'],
  ])('rejects %j', async (plain, field) => {
    const { fields } = await check(ListTicketsQueryDto, plain);
    expect(fields).toEqual([field]);
  });
});

describe('ReplyTicketDto', () => {
  it('trims the body and defaults isInternalNote to false', async () => {
    const { dto, fields } = await check(ReplyTicketDto, {
      body: '  Hello  ',
    });
    expect(fields).toEqual([]);
    expect(dto).toEqual({ body: 'Hello', isInternalNote: false });
  });

  it('accepts an internal note and a 5000-character body', async () => {
    const { dto, fields } = await check(ReplyTicketDto, {
      body: 'x'.repeat(5000),
      isInternalNote: true,
    });
    expect(fields).toEqual([]);
    expect(dto.isInternalNote).toBe(true);
  });

  it('multipart strings "true"/"false" become booleans (M7-T3)', async () => {
    for (const [raw, expected] of [
      ['true', true],
      ['false', false],
    ] as const) {
      const { dto, fields } = await check(ReplyTicketDto, {
        body: 'ok',
        isInternalNote: raw,
      });
      expect(fields).toEqual([]);
      expect(dto.isInternalNote).toBe(expected);
    }
  });

  it.each([
    [{}, 'body'],
    [{ body: '' }, 'body'],
    [{ body: '   ' }, 'body'],
    [{ body: 42 }, 'body'],
    [{ body: 'x'.repeat(5001) }, 'body'],
    [{ body: 'ok', isInternalNote: 'yes' }, 'isInternalNote'],
    [{ body: 'ok', isInternalNote: 'TRUE' }, 'isInternalNote'],
    [{ body: 'ok', isInternalNote: 1 }, 'isInternalNote'],
    [{ body: 'ok', senderRole: 'CLIENT' }, 'senderRole'],
  ])('rejects %j', async (plain, field) => {
    const { fields } = await check(ReplyTicketDto, plain);
    expect(fields).toEqual([field]);
  });
});

describe('UpdateTicketStatusDto', () => {
  it.each(['OPEN', 'IN_PROGRESS', 'RESOLVED'])('accepts %s', async (status) => {
    const { fields } = await check(UpdateTicketStatusDto, { status });
    expect(fields).toEqual([]);
  });

  it.each([
    [{}, 'status'],
    [{ status: 'CLOSED' }, 'status'],
    [{ status: 'resolved' }, 'status'],
    [{ status: 'OPEN', reason: 'x' }, 'reason'],
  ])('rejects %j', async (plain, field) => {
    const { fields } = await check(UpdateTicketStatusDto, plain);
    expect(fields).toEqual([field]);
  });
});

describe('TicketsPageQueryDto (client list, M7-T2)', () => {
  it('takes paging + status, refuses the admin-only filters', async () => {
    expect(
      (await check(TicketsPageQueryDto, { status: 'OPEN' })).fields,
    ).toEqual([]);
    const { fields } = await check(TicketsPageQueryDto, {
      workspaceId: WS,
      priority: 'HIGH',
    });
    expect(fields.sort()).toEqual(['priority', 'workspaceId']);
  });
});

describe('CreateTicketDto (M7-T2, D3)', () => {
  const valid = { category: 'BILLING', subject: ' Refund ', body: ' Hi ' };

  it('trims subject and body', async () => {
    const { dto, fields } = await check(CreateTicketDto, valid);
    expect(fields).toEqual([]);
    expect(dto).toEqual({ category: 'BILLING', subject: 'Refund', body: 'Hi' });
  });

  it('refuses priority, status and bad values', async () => {
    const { fields } = await check(CreateTicketDto, {
      ...valid,
      priority: 'HIGH',
      status: 'RESOLVED',
    });
    expect(fields.sort()).toEqual(['priority', 'status']);
    const bad = await check(CreateTicketDto, {
      category: 'URGENT',
      subject: 'x'.repeat(201),
      body: '   ',
    });
    expect(bad.fields.sort()).toEqual(['body', 'category', 'subject']);
  });
});

describe('ClientReplyTicketDto (M7-T2)', () => {
  it('refuses isInternalNote', async () => {
    const { fields } = await check(ClientReplyTicketDto, {
      body: 'x',
      isInternalNote: true,
    });
    expect(fields).toEqual(['isInternalNote']);
  });
});
