import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  decodeFeedCursor,
  encodeFeedCursor,
  toFeedFilter,
} from './comments-feed.js';
import { CommentsFeedQueryDto } from './dto/comments-feed.dto.js';

const ID = '019a4f3e-1c2d-7abc-8def-0123456789ab';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(CommentsFeedQueryDto, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, fields: errors.map((e) => e.property) };
}

describe('feed cursor', () => {
  it('round-trips (created_at, id) and is URL-safe', () => {
    const cursor = { createdAt: new Date('2026-11-20T08:15:30.123Z'), id: ID };
    const raw = encodeFeedCursor(cursor);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeFeedCursor(raw)).toEqual(cursor);
  });

  it.each([
    ['empty', ''],
    ['not base64url', 'abc+/='],
    [
      'no separator',
      Buffer.from('2026-11-20T08:15:30.123Z').toString('base64url'),
    ],
    [
      'bad date',
      Buffer.from(`2026-13-40T00:00:00.000Z|${ID}`).toString('base64url'),
    ],
    [
      'non-canonical date',
      Buffer.from(`2026-11-20|${ID}`).toString('base64url'),
    ],
    [
      'bad id',
      Buffer.from('2026-11-20T08:15:30.123Z|42').toString('base64url'),
    ],
    [
      'extra part',
      Buffer.from(`2026-11-20T08:15:30.123Z|${ID}|x`).toString('base64url'),
    ],
  ])('rejects %s', (_label, raw) => {
    expect(decodeFeedCursor(raw)).toBeUndefined();
  });
});

describe('toFeedFilter', () => {
  it('turns Dhaka days into [start, end) and since into a Date', () => {
    expect(
      toFeedFilter(
        Object.assign(new CommentsFeedQueryDto(), {
          from: '2026-11-01',
          to: '2026-11-20',
          since: '2026-11-20T10:00:00+06:00',
          status: 'HIDDEN',
        }),
      ),
    ).toEqual({
      status: 'HIDDEN',
      limit: 20,
      start: new Date('2026-10-31T18:00:00.000Z'),
      end: new Date('2026-11-20T18:00:00.000Z'),
      since: new Date('2026-11-20T04:00:00.000Z'),
      cursor: undefined,
    });
  });

  it('decodes the cursor', () => {
    const cursor = { createdAt: new Date('2026-11-20T00:00:00.000Z'), id: ID };
    const dto = Object.assign(new CommentsFeedQueryDto(), {
      cursor: encodeFeedCursor(cursor),
    });
    expect(toFeedFilter(dto).cursor).toEqual(cursor);
  });

  it('400 on a bad cursor or from after to', () => {
    expect(() =>
      toFeedFilter(
        Object.assign(new CommentsFeedQueryDto(), { cursor: 'nope' }),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      toFeedFilter(
        Object.assign(new CommentsFeedQueryDto(), {
          from: '2026-11-02',
          to: '2026-11-01',
        }),
      ),
    ).toThrow(BadRequestException);
  });
});

describe('CommentsFeedQueryDto', () => {
  it('defaults to 20 and accepts every filter (q trimmed, blank = none)', async () => {
    expect((await check({})).dto.limit).toBe(20);
    const { dto, fields } = await check({
      status: 'NEEDS_REVIEW',
      category: 'SCAM_PHISHING',
      platform: 'INSTAGRAM',
      pageId: ID,
      from: '2026-11-01',
      to: '2026-11-20',
      q: '  50% off_ ',
      since: '2026-11-20T08:15:30.123Z',
      cursor: 'abc',
      limit: '50',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ q: '50% off_', limit: 50 });
    expect((await check({ q: '   ' })).dto.q).toBeUndefined();
  });

  it.each([
    [{ status: 'hidden' }, 'status'],
    [{ category: 'SCAM' }, 'category'],
    [{ platform: 'TIKTOK' }, 'platform'],
    [{ pageId: '123456789' }, 'pageId'],
    [{ from: '2026-02-30' }, 'from'],
    [{ to: '2026-11-20T00:00:00Z' }, 'to'],
    [{ q: 'x'.repeat(101) }, 'q'],
    [{ since: '2026-11-20' }, 'since'],
    [{ since: '2026-11-20T10:00:00' }, 'since'],
    [{ since: 'yesterday' }, 'since'],
    [{ cursor: 'x'.repeat(201) }, 'cursor'],
    [{ limit: '0' }, 'limit'],
    [{ limit: '51' }, 'limit'],
    [{ limit: '2.5' }, 'limit'],
    [{ workspaceId: ID }, 'workspaceId'],
  ])('rejects %j', async (plain, field) => {
    expect((await check(plain)).fields).toEqual([field]);
  });
});
