import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Database } from '../db/database.js';
import type { RedisService } from '../redis/redis.service.js';
import type {
  ClassificationFailure,
  ClassificationResult,
  ClassificationSuccess,
  CommentClassifier,
} from './comment-classifier.js';
import { PlaygroundTestDto } from './dto/playground.dto.js';
import type { ModerationPolicyService } from './moderation-policy.service.js';
import { workspacePlanFeatures } from './moderation-policy.service.js';
import {
  classificationUsageDelta,
  defaultModerationPolicy,
  type ModerationPolicy,
  recordDailyAiUsage,
} from './moderation.queries.js';
import {
  PLAYGROUND_COUNTER_TTL_SECONDS,
  PlaygroundCounter,
  playgroundDailyLimit,
  playgroundCounterKey,
  PlaygroundService,
  RedisPlaygroundCounter,
} from './playground.js';

vi.mock('./moderation.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDailyAiUsage: vi.fn(),
}));
vi.mock('./moderation-policy.service.js', () => ({
  ModerationPolicyService: class {},
  workspacePlanFeatures: vi.fn(async () => ({ autoReplyTemplates: false })),
}));

const WS = '019a0000-0000-7000-8000-00000000000a';
// 18:30 UTC = 00:30 the next day in Dhaka.
const NOW = new Date('2026-11-19T18:30:00.000Z');
const KEY = `playground:${WS}:2026-11-20`;

class MemoryCounter extends PlaygroundCounter {
  counts = new Map<string, number>();
  async hit(key: string) {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
  async undo(key: string) {
    this.counts.set(key, (this.counts.get(key) ?? 0) - 1);
  }
  async peek(key: string) {
    return this.counts.get(key) ?? 0;
  }
}

const success = (
  patch: Partial<ClassificationSuccess> = {},
): ClassificationSuccess => ({
  ok: true,
  category: 'SCAM_PHISHING',
  confidence: 0.95,
  reasoning: 'Asks for a bKash payment.',
  language: 'banglish',
  contextLevel: 'comment_only',
  promptVersion: 'moderation-v2',
  provider: 'neon',
  model: 'gpt-oss-20b',
  outputMode: 'json_schema',
  usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
  latencyMs: 40,
  attempts: 1,
  ...patch,
});

const failure = (
  patch: Partial<ClassificationFailure> = {},
): ClassificationFailure => ({
  ok: false,
  kind: 'transient',
  retryable: true,
  promptVersion: 'moderation-v2',
  attempts: 1,
  latencyMs: 30,
  provider: 'neon',
  model: 'gpt-oss-20b',
  ...patch,
});

/** Only `playgroundDailyLimit()` reads the db here: `platform_settings` row `id = 1`, or none. */
function settingsDb(limit?: number) {
  const where = vi.fn(async () => (limit === undefined ? [] : [{ limit }]));
  const db = { select: () => ({ from: () => ({ where }) }) };
  return { db: db as unknown as Database, where };
}

function setup(
  policy: ModerationPolicy = defaultModerationPolicy(WS),
  limit?: number,
) {
  const counter = new MemoryCounter();
  const classify = vi.fn<CommentClassifier['classify']>(async () => success());
  const service = new PlaygroundService(
    settingsDb(limit).db,
    { policy: vi.fn(async () => policy) } as unknown as ModerationPolicyService,
    { classify } as unknown as CommentClassifier,
    counter,
  );
  const run = (text: string, platform?: 'FACEBOOK' | 'INSTAGRAM') =>
    service.test(WS, { text, platform }, NOW);
  const usage = () => service.usage(WS, NOW);
  return { counter, classify, run, usage };
}

async function rejected(promise: Promise<unknown>): Promise<HttpException> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpException);
  return error as HttpException;
}

beforeEach(() => {
  vi.mocked(recordDailyAiUsage).mockReset();
  vi.mocked(workspacePlanFeatures).mockClear();
});

describe('PlaygroundService', () => {
  it('a rule hit never calls the classifier; decision = rules.actions[kind]', async () => {
    const policy = defaultModerationPolicy(WS);
    policy.rules.blockedKeywords = ['cashback'];
    policy.rules.actions.keyword = 'DELETE';
    const { classify, run } = setup(policy);
    const res = await run('Get CASHBACK now');
    expect(classify).not.toHaveBeenCalled();
    expect(recordDailyAiUsage).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      ruleMatch: { kind: 'keyword', value: 'cashback' },
      classification: null,
      decision: { action: 'DELETE', status: 'DELETED', reason: 'policy' },
      testsLeft: 9,
    });
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('REVIEW mode: a rule hit is not applied (NEEDS_REVIEW)', async () => {
    const policy = { ...defaultModerationPolicy(WS), mode: 'REVIEW' as const };
    policy.rules.blockPhoneNumbers = true;
    const { classify, run } = setup(policy);
    const res = await run('call 01712345678');
    expect(classify).not.toHaveBeenCalled();
    expect(res.ruleMatch).toEqual({ kind: 'phone', value: '01712345678' });
    expect(res.decision).toEqual({
      action: 'NONE',
      status: 'NEEDS_REVIEW',
      reason: 'review_mode',
    });
  });

  it('no match → classifier with comment-only context, decision as for a new visible comment', async () => {
    const { classify, run } = setup();
    const res = await run('bkash e taka pathan', 'INSTAGRAM');
    expect(classify).toHaveBeenCalledWith({
      text: 'bkash e taka pathan',
      platform: 'INSTAGRAM',
      isReply: false,
      contextLevel: 'comment_only',
    });
    expect(res).toEqual({
      ruleMatch: null,
      classification: {
        category: 'SCAM_PHISHING',
        confidence: 0.95,
        reasoning: 'Asks for a bKash payment.',
        language: 'banglish',
      },
      decision: { action: 'HIDE', status: 'HIDDEN', reason: 'policy' },
      latencyMs: expect.any(Number),
      testsLeft: 9,
    });
    expect(recordDailyAiUsage).toHaveBeenCalledWith(expect.anything(), {
      day: '2026-11-20',
      provider: 'neon',
      model: 'gpt-oss-20b',
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      latencyMs: 40,
    });
  });

  it('platform defaults to FACEBOOK; reply preview needs the plan flag', async () => {
    const policy = defaultModerationPolicy(WS);
    policy.categories.SCAM_PHISHING = {
      action: 'HIDE',
      autoReply: true,
      replyEn: 'Please DM us.',
      replyBn: 'ইনবক্স করুন।',
    };
    const { classify, run } = setup(policy);
    expect((await run('hi')).decision.reply).toBeUndefined();
    expect(classify.mock.calls[0]![0].platform).toBe('FACEBOOK');
    vi.mocked(workspacePlanFeatures).mockResolvedValueOnce({
      autoReplyTemplates: true,
    } as Awaited<ReturnType<typeof workspacePlanFeatures>>);
    expect((await run('hi')).decision.reply).toEqual({
      language: 'bn',
      text: 'ইনবক্স করুন।',
    });
  });

  it('below threshold → NEEDS_REVIEW, no action', async () => {
    const { classify, run } = setup();
    classify.mockResolvedValueOnce(success({ confidence: 0.4 }));
    expect((await run('hm')).decision).toEqual({
      action: 'NONE',
      status: 'NEEDS_REVIEW',
      reason: 'below_threshold',
    });
  });

  it('a usage write failure never fails the test', async () => {
    vi.mocked(recordDailyAiUsage).mockRejectedValueOnce(new Error('db down'));
    const { run } = setup();
    await expect(run('hello')).resolves.toMatchObject({ testsLeft: 9 });
  });

  it('AI failure → 502 PLAYGROUND_AI_FAILED (usage recorded, test given back)', async () => {
    const { classify, counter, run } = setup();
    classify.mockResolvedValueOnce(failure());
    const error = await rejected(run('hello'));
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toMatchObject({
      code: 'PLAYGROUND_AI_FAILED',
      details: { errorKind: 'transient', retryable: true },
    });
    expect(recordDailyAiUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ calls: 1, failures: { transient: 1 } }),
    );
    expect(counter.counts.get(KEY)).toBe(0);
  });

  it('no AI provider → 503 PLAYGROUND_AI_NOT_CONFIGURED, nothing recorded', async () => {
    const { classify, counter, run } = setup();
    classify.mockResolvedValueOnce(
      failure({
        kind: 'not_configured',
        retryable: false,
        attempts: 0,
        provider: undefined,
        model: undefined,
      }),
    );
    const error = await rejected(run('hello'));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toMatchObject({
      code: 'PLAYGROUND_AI_NOT_CONFIGURED',
    });
    expect(recordDailyAiUsage).not.toHaveBeenCalled();
    expect(counter.counts.get(KEY)).toBe(0);
  });

  it('a thrown error gives the test back too', async () => {
    const { classify, counter, run } = setup();
    classify.mockRejectedValueOnce(new Error('resolver down'));
    await expect(run('hello')).rejects.toThrow('resolver down');
    expect(counter.counts.get(KEY)).toBe(0);
  });

  it('cap: counter per workspace per Dhaka day; the 11th test → 429 with resetsAt', async () => {
    const { counter, classify, run } = setup();
    const left: number[] = [];
    for (let i = 0; i < 10; i++) left.push((await run('hello')).testsLeft);
    expect(left).toEqual([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const error = await rejected(run('hello'));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      code: 'PLAYGROUND_LIMIT_REACHED',
      details: { limit: 10, resetsAt: '2026-11-20T18:00:00.000Z' },
    });
    expect(classify).toHaveBeenCalledTimes(10);
    expect([...counter.counts]).toEqual([[KEY, 10]]);
  });

  it('cap = the admin setting (M6-T7b): 2 → the 3rd test is 429 with limit 2', async () => {
    const { counter, run } = setup(undefined, 2);
    expect((await run('hello')).testsLeft).toBe(1);
    expect((await run('hello')).testsLeft).toBe(0);
    const error = await rejected(run('hello'));
    expect(error.getResponse()).toMatchObject({
      code: 'PLAYGROUND_LIMIT_REACHED',
      details: { limit: 2 },
    });
    expect(counter.counts.get(KEY)).toBe(2);
  });

  it('setting 0 = playground off: every test → 429, nothing counted, no AI', async () => {
    const { counter, classify, run } = setup(undefined, 0);
    const error = await rejected(run('hello'));
    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toMatchObject({
      message: 'The playground is turned off right now.',
      code: 'PLAYGROUND_LIMIT_REACHED',
      details: { limit: 0 },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(counter.counts.get(KEY)).toBe(0);
  });
});

describe('PlaygroundService.usage (M6-T11)', () => {
  it('reads the count without counting; testsLeft follows each test', async () => {
    const { counter, run, usage } = setup();
    const fresh = {
      limit: 10,
      used: 0,
      testsLeft: 10,
      resetsAt: '2026-11-20T18:00:00.000Z',
    };
    await expect(usage()).resolves.toEqual(fresh);
    await expect(usage()).resolves.toEqual(fresh);
    expect(counter.counts.size).toBe(0);
    await run('hello');
    await expect(usage()).resolves.toMatchObject({ used: 1, testsLeft: 9 });
  });

  it('a lowered limit never shows a negative count; 0 = off', async () => {
    const lowered = setup(undefined, 2);
    lowered.counter.counts.set(KEY, 5);
    await expect(lowered.usage()).resolves.toMatchObject({
      limit: 2,
      used: 5,
      testsLeft: 0,
    });
    await expect(setup(undefined, 0).usage()).resolves.toMatchObject({
      limit: 0,
      used: 0,
      testsLeft: 0,
    });
  });
});

describe('playground helpers', () => {
  it('playgroundDailyLimit: the setting, or 10 without a row', async () => {
    await expect(playgroundDailyLimit(settingsDb().db)).resolves.toBe(10);
    await expect(playgroundDailyLimit(settingsDb(25).db)).resolves.toBe(25);
    await expect(playgroundDailyLimit(settingsDb(0).db)).resolves.toBe(0);
  });

  it('counter key', () => {
    expect(playgroundCounterKey(WS, '2026-11-20')).toBe(KEY);
  });

  it('RedisPlaygroundCounter: INCR + EXPIRE in one MULTI, DECR on undo, GET on peek', async () => {
    const multi = {
      incr: vi.fn(() => multi),
      expire: vi.fn(() => multi),
      exec: vi.fn(async () => [
        [null, 3],
        [null, 1],
      ]),
    };
    const client = {
      status: 'ready',
      multi: vi.fn(() => multi),
      decr: vi.fn(async () => 2),
      get: vi.fn(async (): Promise<string | null> => '2'),
    };
    const counter = new RedisPlaygroundCounter({
      client,
    } as unknown as RedisService);
    await expect(counter.hit(KEY)).resolves.toBe(3);
    expect(multi.incr).toHaveBeenCalledWith(KEY);
    expect(multi.expire).toHaveBeenCalledWith(
      KEY,
      PLAYGROUND_COUNTER_TTL_SECONDS,
    );
    await counter.undo(KEY);
    expect(client.decr).toHaveBeenCalledWith(KEY);
    await expect(counter.peek(KEY)).resolves.toBe(2);
    expect(client.get).toHaveBeenCalledWith(KEY);
    client.get.mockResolvedValueOnce(null);
    await expect(counter.peek(KEY)).resolves.toBe(0);
    multi.exec.mockResolvedValueOnce([[new Error('READONLY'), null]] as never);
    await expect(counter.hit(KEY)).rejects.toThrow('READONLY');
  });

  it('classificationUsageDelta: nothing when no provider was reached', () => {
    const none: ClassificationResult = failure({
      kind: 'empty_text',
      attempts: 0,
      provider: undefined,
      model: undefined,
    });
    expect(classificationUsageDelta(none, '2026-11-20')).toBeNull();
    expect(
      classificationUsageDelta(failure({ attempts: 0 }), '2026-11-20'),
    ).toMatchObject({ calls: 0 });
  });
});

describe('PlaygroundTestDto', () => {
  const check = async (plain: object) => {
    const dto = plainToInstance(PlaygroundTestDto, plain);
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    return { dto, fields: errors.map((e) => e.property) };
  };

  it('trims the text and accepts 1–2,000 chars + a platform', async () => {
    const ok = await check({ text: '  hello  ', platform: 'INSTAGRAM' });
    expect(ok.fields).toEqual([]);
    expect(ok.dto.text).toBe('hello');
    expect((await check({ text: 'x'.repeat(2_000) })).fields).toEqual([]);
  });

  it('rejects blank, too long, non-string text, bad platform, extra keys', async () => {
    expect((await check({ text: '   ' })).fields).toEqual(['text']);
    expect((await check({ text: 'x'.repeat(2_001) })).fields).toEqual(['text']);
    expect((await check({ text: 5 })).fields).toEqual(['text']);
    expect((await check({})).fields).toEqual(['text']);
    expect((await check({ text: 'a', platform: 'TIKTOK' })).fields).toEqual([
      'platform',
    ]);
    expect((await check({ text: 'a', extra: 1 })).fields).toEqual(['extra']);
  });
});
