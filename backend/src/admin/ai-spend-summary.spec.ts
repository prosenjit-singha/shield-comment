import { DEFAULT_AI_MODEL_PRICES } from '../moderation/ai-model-prices.js';
import {
  analysisCostUsd,
  analyzedSince,
  buildAiSpendSummary,
} from './ai-spend-summary.js';

const prices = DEFAULT_AI_MODEL_PRICES;
const JEV = 'typesafeai-jev-1-14-0';

describe('analysisCostUsd', () => {
  it('catalog price: gpt-oss-20b in 0.07 / out 0.3 per 1M', () => {
    expect(
      analysisCostUsd(prices, {
        provider: 'neon',
        model: 'gpt-oss-20b',
        inputTokens: 1000,
        outputTokens: 100,
      }),
    ).toBe(0.0001); // 0.00007 + 0.00003
  });

  it('jev bills input only (output 0)', () => {
    expect(
      analysisCostUsd(prices, {
        provider: 'neon',
        model: JEV,
        inputTokens: 1_000_000,
        outputTokens: 999,
      }),
    ).toBe(0.042);
  });

  it('free model = 0', () => {
    expect(
      analysisCostUsd(prices, {
        provider: 'neon',
        model: 'gemini-4-carbon',
        inputTokens: 5000,
        outputTokens: 500,
      }),
    ).toBe(0);
  });

  it('unknown model or missing tokens → null', () => {
    const row = { provider: 'neon', inputTokens: 10, outputTokens: 1 } as const;
    expect(analysisCostUsd(prices, { ...row, model: 'mystery' })).toBeNull();
    expect(
      analysisCostUsd(prices, {
        ...row,
        model: 'gpt-oss-20b',
        inputTokens: null,
      }),
    ).toBeNull();
  });
});

describe('analyzedSince (Asia/Dhaka days)', () => {
  it('today starts at 00:00 Dhaka (18:00 UTC the day before); 7 days include today', () => {
    // 2026-11-20 00:30 Dhaka = 2026-11-19 18:30 UTC.
    const since = analyzedSince(new Date('2026-11-19T18:30:00.000Z'));
    expect(since.today.toISOString()).toBe('2026-11-19T18:00:00.000Z');
    expect(since.last7Days.toISOString()).toBe('2026-11-13T18:00:00.000Z');
  });

  it('17:59 UTC is still the previous Dhaka day', () => {
    const since = analyzedSince(new Date('2026-11-19T17:59:59.999Z'));
    expect(since.today.toISOString()).toBe('2026-11-18T18:00:00.000Z');
  });
});

describe('buildAiSpendSummary', () => {
  const now = new Date('2026-11-20T06:00:00.000Z');
  const analyzed = { total: 5, today: 2, last7Days: 4 };

  it('spend by model, unpriced calls, tokens, remaining (may be negative)', () => {
    const summary = buildAiSpendSummary({
      now,
      prices,
      creditAddedUsd: 0.0001,
      commentsAnalyzed: analyzed,
      modelRows: [
        {
          provider: 'neon',
          model: JEV,
          calls: 3,
          inputTokens: 1_000_000,
          outputTokens: 50,
        },
        {
          provider: 'neon',
          model: 'gemini-4-carbon',
          calls: 1,
          inputTokens: 100,
          outputTokens: 10,
        },
        {
          provider: 'neon',
          model: 'mystery',
          calls: 2,
          inputTokens: 7,
          outputTokens: 3,
        },
      ],
      decisionRows: [],
    });
    expect(summary).toMatchObject({
      asOf: now,
      timezone: 'Asia/Dhaka',
      creditAddedUsd: 0,
      estimatedSpendUsd: 0.042,
      estimatedRemainingUsd: -0.042,
      unpricedCalls: 2,
      commentsAnalyzed: analyzed,
      tokens: { input: 1_000_107, output: 63 },
    });
    expect(summary.spendByModel.map((m) => [m.model, m.costUsd])).toEqual([
      ['gemini-4-carbon', 0],
      ['mystery', null],
      [JEV, 0.042],
    ]);
  });

  it('decision grouping: fixed order, null-token + unpriced comments counted with cost 0', () => {
    const summary = buildAiSpendSummary({
      now,
      prices,
      creditAddedUsd: 5,
      commentsAnalyzed: analyzed,
      modelRows: [],
      decisionRows: [
        {
          decision: 'HIDE',
          provider: 'neon',
          model: 'gpt-oss-20b',
          comments: 3,
          withoutTokens: 1,
          inputTokens: 2000,
          outputTokens: 200,
        },
        {
          decision: 'HIDE',
          provider: 'neon',
          model: 'mystery',
          comments: 2,
          withoutTokens: 0,
          inputTokens: 50,
          outputTokens: 5,
        },
        {
          decision: 'NONE',
          provider: 'neon',
          model: JEV,
          comments: 1,
          withoutTokens: 0,
          inputTokens: 1_000_000,
          outputTokens: 0,
        },
      ],
    });
    expect(summary.estimatedRemainingUsd).toBe(5);
    expect(summary.spendByDecision).toEqual([
      { decision: 'NONE', comments: 1, costUsd: 0.042, unpricedComments: 0 },
      { decision: 'HIDE', comments: 5, costUsd: 0.0002, unpricedComments: 3 },
      { decision: 'DELETE', comments: 0, costUsd: 0, unpricedComments: 0 },
    ]);
  });
});
