import {
  type CommentsExecutor,
  dhakaDayKey,
  incrementDailyCommentStats,
  webhookPayloadHash,
} from './comments.queries.js';

describe('dhakaDayKey', () => {
  it('is the Asia/Dhaka (UTC+6) calendar day', () => {
    expect(dhakaDayKey(new Date('2026-11-18T10:00:00Z'))).toBe('2026-11-18');
    // 17:59:59.999 UTC = 23:59:59.999 Dhaka, still the same day.
    expect(dhakaDayKey(new Date('2026-11-18T17:59:59.999Z'))).toBe(
      '2026-11-18',
    );
    // 18:00 UTC = 00:00 Dhaka next day.
    expect(dhakaDayKey(new Date('2026-11-18T18:00:00Z'))).toBe('2026-11-19');
    // Early UTC morning is already the same Dhaka day.
    expect(dhakaDayKey(new Date('2026-12-31T20:30:00Z'))).toBe('2027-01-01');
  });

  it('defaults to now', () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T19:00:00Z') });
    try {
      expect(dhakaDayKey()).toBe('2026-11-19');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('webhookPayloadHash', () => {
  it('is the sha256 hex of the JSON', () => {
    // sha256('{"a":1}')
    expect(webhookPayloadHash({ a: 1 })).toBe(
      '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
    );
  });

  it('is stable for equal payloads and differs for an edited message', () => {
    const change = { field: 'feed', value: { verb: 'edited', message: 'hi' } };
    expect(webhookPayloadHash(change)).toBe(
      webhookPayloadHash(structuredClone(change)),
    );
    expect(webhookPayloadHash(change)).not.toBe(
      webhookPayloadHash({
        ...change,
        value: { ...change.value, message: 'x' },
      }),
    );
    expect(webhookPayloadHash(change)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes undefined like null', () => {
    expect(webhookPayloadHash(undefined)).toBe(webhookPayloadHash(null));
  });
});

describe('incrementDailyCommentStats', () => {
  const executor = {
    insert: vi.fn<CommentsExecutor['insert']>(),
    select: vi.fn<CommentsExecutor['select']>(),
    update: vi.fn<CommentsExecutor['update']>(),
  } as unknown as CommentsExecutor;
  const key = {
    workspaceId: '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c',
    pageId: '123',
    platform: 'FACEBOOK' as const,
    day: '2026-11-18',
  };

  it.each([
    ['negative', { received: -1 }],
    ['fractional', { edited: 0.5 }],
    ['NaN', { removed: Number.NaN }],
  ])('rejects a %s delta without touching the DB', async (_label, delta) => {
    await expect(
      incrementDailyCommentStats(executor, { ...key, ...delta }),
    ).rejects.toThrow('integers ≥ 0');
    expect(executor.insert).not.toHaveBeenCalled();
  });
});
