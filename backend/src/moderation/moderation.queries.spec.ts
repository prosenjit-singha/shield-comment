import { getTableConfig } from 'drizzle-orm/pg-core';
import {
  CLASSIFICATION_COLUMNS,
  comments,
  moderationPolicies,
} from '../db/schema/index.js';
import { snakeCase } from '../db/schema/check-sql.js';
import { MAX_REASONING_CHARS as PROMPT_MAX_REASONING_CHARS } from './moderation-prompt.js';
import { PROMPT_VERSION } from './moderation-prompt.js';
import {
  COMMENT_STATUSES,
  DEFAULT_CATEGORY_ACTIONS,
  DEFAULT_CONFIDENCE_THRESHOLD,
  isMachineCode,
  MAX_REASONING_CHARS,
  MODERATION_CATEGORIES,
  MODERATION_CATEGORY_KEYS,
  PROMPT_VERSION_PATTERN,
} from './moderation.constants.js';
import {
  dailyAiUsageIncrements,
  defaultModerationPolicy,
  type ModerationExecutor,
  type ModerationPolicyRow,
  recordDailyAiUsage,
  toModerationPolicy,
} from './moderation.queries.js';

const WS = '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c';

describe('moderation constants (M5-T7)', () => {
  it('comment statuses = the proposal, PENDING first (the column default)', () => {
    expect(COMMENT_STATUSES).toEqual([
      'PENDING',
      'VISIBLE',
      'NEEDS_REVIEW',
      'HIDDEN',
      'DELETED',
      'SKIPPED',
      'FAILED',
    ]);
    expect(comments.status.default).toBe('PENDING');
  });

  it('D3: hide every category except SAFE_INQUIRY, never delete by default', () => {
    expect(DEFAULT_CATEGORY_ACTIONS).toEqual({
      SAFE_INQUIRY: 'NONE',
      COMPETITOR_POACH: 'HIDE',
      SCAM_PHISHING: 'HIDE',
      SPAM_IRRELEVANT: 'HIDE',
      ABUSIVE_TOXIC: 'HIDE',
    });
    expect(Object.values(DEFAULT_CATEGORY_ACTIONS)).not.toContain('DELETE');
  });

  it('one camelCase key per category', () => {
    expect(Object.keys(MODERATION_CATEGORY_KEYS)).toEqual([
      ...MODERATION_CATEGORIES,
    ]);
    expect(new Set(Object.values(MODERATION_CATEGORY_KEYS)).size).toBe(5);
  });

  it('the stored prompt version and reasoning cap match the classifier', () => {
    expect(PROMPT_VERSION).toMatch(new RegExp(PROMPT_VERSION_PATTERN));
    expect(PROMPT_MAX_REASONING_CHARS).toBe(MAX_REASONING_CHARS);
    expect(MAX_REASONING_CHARS).toBe(280);
  });

  it('machine codes: lower snake case, ≤ 64 chars, no free text', () => {
    for (const ok of [
      'comment_limit_reached',
      'token_invalid',
      'not_found',
      'a',
    ]) {
      expect(isMachineCode(ok)).toBe(true);
    }
    for (const bad of [
      '',
      'Credits',
      '1abc',
      'has space',
      'a-b',
      'x'.repeat(65),
      42,
      null,
    ]) {
      expect(isMachineCode(bad)).toBe(false);
    }
  });

  it('classification columns exist on comments and are nullable', () => {
    const columns = new Map(
      // Column names are the TS keys until `casing: 'snake_case'` applies.
      getTableConfig(comments).columns.map((c) => [snakeCase(c.name), c]),
    );
    for (const name of CLASSIFICATION_COLUMNS) {
      expect(columns.get(name)?.notNull).toBe(false);
    }
    expect(columns.get('confidence')?.getSQLType()).toBe('numeric(4, 3)');
    // PW-T4: the AI credit counter is gone (comments are counted once: `usage_counted_at`).
    expect(columns.has('credits_charged')).toBe(false);
    expect(columns.get('usage_counted_at')?.notNull).toBe(false);
  });
});

describe('policy defaults (D3/D4/D6/D8)', () => {
  it('defaultModerationPolicy: AUTO, 0.80, comment_only, D3 actions, auto-reply off', () => {
    const policy = defaultModerationPolicy(WS);
    expect(policy).toMatchObject({
      workspaceId: WS,
      mode: 'AUTO',
      confidenceThreshold: 0.8,
      aiContextLevel: 'comment_only',
    });
    for (const category of MODERATION_CATEGORIES) {
      expect(policy.categories[category]).toEqual({
        action: DEFAULT_CATEGORY_ACTIONS[category],
        autoReply: false,
        replyEn: null,
        replyBn: null,
      });
    }
  });

  it('the column defaults are the same values (a lazily created row = defaultModerationPolicy)', () => {
    const t = moderationPolicies;
    expect(t.mode.default).toBe('AUTO');
    expect(t.confidenceThreshold.default).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(t.aiContextLevel.default).toBe('comment_only');
    for (const category of MODERATION_CATEGORIES) {
      const key = MODERATION_CATEGORY_KEYS[category];
      expect(t[`${key}Action`].default).toBe(
        DEFAULT_CATEGORY_ACTIONS[category],
      );
      expect(t[`${key}AutoReply`].default).toBe(false);
      expect(t[`${key}ReplyEn`].notNull).toBe(false);
      expect(t[`${key}ReplyBn`].notNull).toBe(false);
    }
  });

  it('toModerationPolicy groups the flat columns per category', () => {
    const row = {
      workspaceId: WS,
      mode: 'REVIEW',
      confidenceThreshold: 0.65,
      aiContextLevel: 'post_caption',
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Record<string, unknown>;
    for (const category of MODERATION_CATEGORIES) {
      const key = MODERATION_CATEGORY_KEYS[category];
      row[`${key}Action`] = category === 'SCAM_PHISHING' ? 'DELETE' : 'NONE';
      row[`${key}AutoReply`] = category === 'SAFE_INQUIRY';
      row[`${key}ReplyEn`] = category === 'SAFE_INQUIRY' ? 'Check inbox' : null;
      row[`${key}ReplyBn`] = category === 'SAFE_INQUIRY' ? 'ইনবক্স দেখুন' : null;
    }
    const policy = toModerationPolicy(row as unknown as ModerationPolicyRow);
    expect(policy).toMatchObject({
      workspaceId: WS,
      mode: 'REVIEW',
      confidenceThreshold: 0.65,
      aiContextLevel: 'post_caption',
    });
    expect(policy.categories.SAFE_INQUIRY).toEqual({
      action: 'NONE',
      autoReply: true,
      replyEn: 'Check inbox',
      replyBn: 'ইনবক্স দেখুন',
    });
    expect(policy.categories.SCAM_PHISHING.action).toBe('DELETE');
    expect(policy.categories.ABUSIVE_TOXIC.autoReply).toBe(false);
  });
});

describe('dailyAiUsageIncrements (D14)', () => {
  const base = {
    day: '2026-11-19',
    provider: 'neon',
    model: 'gpt-oss-20b',
  } as const;

  it('fills zeros, sums failures into failedCalls, drops zero kinds', () => {
    expect(dailyAiUsageIncrements(base)).toEqual({
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      failedCalls: 0,
      failuresByKind: {},
      latencyMs: 0,
    });
    expect(
      dailyAiUsageIncrements({
        ...base,
        calls: 3,
        inputTokens: 900,
        outputTokens: 120,
        latencyMs: 812,
        failures: { timeout: 1, invalid_output: 1, auth: 0 },
      }),
    ).toEqual({
      calls: 3,
      inputTokens: 900,
      outputTokens: 120,
      failedCalls: 2,
      failuresByKind: { timeout: 1, invalid_output: 1 },
      latencyMs: 812,
    });
  });

  it.each([
    ['negative calls', { calls: -1 }, '≥ 0'],
    ['fractional tokens', { inputTokens: 1.5 }, '≥ 0'],
    ['NaN latency', { latencyMs: Number.NaN }, '≥ 0'],
    [
      'free-text failure kind',
      { calls: 1, failures: { 'Bad thing': 1 } },
      'machine codes',
    ],
    [
      'more failures than calls',
      { calls: 1, failures: { timeout: 2 } },
      'exceed',
    ],
    ['empty model', { model: '' }, '1–100'],
    ['long model', { model: 'm'.repeat(101) }, '1–100'],
  ])('rejects %s before any SQL', async (_label, patch, message) => {
    const executor = {
      insert: vi.fn<ModerationExecutor['insert']>(),
      select: vi.fn<ModerationExecutor['select']>(),
      update: vi.fn<ModerationExecutor['update']>(),
    };
    await expect(
      recordDailyAiUsage(executor as unknown as ModerationExecutor, {
        ...base,
        ...patch,
      }),
    ).rejects.toThrow(message);
    expect(executor.insert).not.toHaveBeenCalled();
  });
});
