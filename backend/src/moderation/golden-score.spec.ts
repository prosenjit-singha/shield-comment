import {
  formatGoldenReport,
  GOLDEN_PASS_ACCURACY,
  type GoldenOutcome,
  modelPrice,
  scoreGolden,
} from './golden-score.js';
import type { ModerationCategory } from './moderation.constants.js';

let n = 0;
function outcome(
  expected: ModerationCategory,
  got: ModerationCategory | { kind: string },
  extra: Partial<GoldenOutcome> & {
    tags?: string[];
    language?: GoldenOutcome['item']['language'];
  } = {},
): GoldenOutcome {
  n += 1;
  const { tags = [], language = 'en', ...rest } = extra;
  return {
    item: {
      id: `item-${String(n).padStart(2, '0')}`,
      text: `comment ${n}`,
      expected,
      language,
      tags,
    },
    result:
      typeof got === 'string'
        ? { ok: true, category: got, confidence: 0.8 }
        : { ok: false, kind: got.kind },
    latencyMs: 100,
    attempts: 1,
    usage: { promptTokens: 1000, completionTokens: 50, totalTokens: 1050 },
    ...rest,
  };
}

describe('scoreGolden', () => {
  it('computes accuracy, precision, recall and the confusion matrix', () => {
    const report = scoreGolden([
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY'),
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY'),
      outcome('SAFE_INQUIRY', 'SCAM_PHISHING'),
      outcome('SCAM_PHISHING', 'SCAM_PHISHING'),
      outcome('COMPETITOR_POACH', 'SAFE_INQUIRY'),
      outcome('ABUSIVE_TOXIC', { kind: 'invalid_output' }),
      outcome('ABUSIVE_TOXIC', { kind: 'timeout' }),
      outcome('ABUSIVE_TOXIC', { kind: 'timeout' }),
    ]);
    expect(report).toMatchObject({
      total: 8,
      correct: 3,
      failed: 3,
      accuracy: 3 / 8,
      passed: false,
    });
    expect(report.perCategory.SAFE_INQUIRY).toEqual({
      support: 3,
      predicted: 3,
      truePositives: 2,
      precision: 2 / 3,
      recall: 2 / 3,
    });
    expect(report.perCategory.SCAM_PHISHING).toEqual({
      support: 1,
      predicted: 2,
      truePositives: 1,
      precision: 0.5,
      recall: 1,
    });
    // Failures count against recall but are not predictions.
    expect(report.perCategory.ABUSIVE_TOXIC).toEqual({
      support: 3,
      predicted: 0,
      truePositives: 0,
      precision: null,
      recall: 0,
    });
    expect(report.perCategory.SPAM_IRRELEVANT).toEqual({
      support: 0,
      predicted: 0,
      truePositives: 0,
      precision: null,
      recall: null,
    });
    expect(report.confusion.SAFE_INQUIRY).toEqual({
      SAFE_INQUIRY: 2,
      COMPETITOR_POACH: 0,
      SCAM_PHISHING: 1,
      SPAM_IRRELEVANT: 0,
      ABUSIVE_TOXIC: 0,
      FAILED: 0,
    });
    expect(report.confusion.ABUSIVE_TOXIC.FAILED).toBe(3);
    expect(report.confusion.COMPETITOR_POACH.SAFE_INQUIRY).toBe(1);
    expect(report.failuresByKind).toEqual({ invalid_output: 1, timeout: 2 });
    expect(report.mistakes.map((m) => [m.expected, m.got, m.detail])).toEqual([
      ['SAFE_INQUIRY', 'SCAM_PHISHING', 'confidence 0.8'],
      ['COMPETITOR_POACH', 'SAFE_INQUIRY', 'confidence 0.8'],
      ['ABUSIVE_TOXIC', 'FAILED', 'failed: invalid_output'],
      ['ABUSIVE_TOXIC', 'FAILED', 'failed: timeout'],
      ['ABUSIVE_TOXIC', 'FAILED', 'failed: timeout'],
    ]);
  });

  it('passes at exactly 90 % and fails just below', () => {
    const nine = Array.from({ length: 9 }, () =>
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY'),
    );
    const pass = scoreGolden([
      ...nine,
      outcome('SAFE_INQUIRY', 'SPAM_IRRELEVANT'),
    ]);
    expect(pass.accuracy).toBe(GOLDEN_PASS_ACCURACY);
    expect(pass.passed).toBe(true);
    const fail = scoreGolden([
      ...nine.slice(0, 8),
      outcome('SAFE_INQUIRY', 'SPAM_IRRELEVANT'),
      outcome('SAFE_INQUIRY', { kind: 'rate_limited' }),
    ]);
    expect(fail.accuracy).toBe(0.8);
    expect(fail.passed).toBe(false);
  });

  it('handles an empty run without dividing by zero', () => {
    const report = scoreGolden([], { input: 1, output: 1 });
    expect(report).toMatchObject({
      total: 0,
      correct: 0,
      failed: 0,
      accuracy: null,
      passed: false,
      latency: null,
      costUsd: null,
      tokens: { prompt: 0, completion: 0, total: 0, itemsWithUsage: 0 },
      attempts: { total: 0, max: 0 },
    });
    for (const score of Object.values(report.perCategory)) {
      expect(score).toMatchObject({ precision: null, recall: null });
    }
    expect(report.byLanguage.bn).toEqual({
      total: 0,
      correct: 0,
      accuracy: null,
    });
    expect(report.byTag).toEqual({});
  });

  it('sums tokens, latency, attempts and slices by language and tag', () => {
    const report = scoreGolden([
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY', {
        language: 'bn',
        tags: ['bkash'],
        latencyMs: 300,
        attempts: 2,
      }),
      outcome('SCAM_PHISHING', 'SAFE_INQUIRY', {
        language: 'bn',
        tags: ['bkash', 'injection'],
        latencyMs: 101,
      }),
      outcome('SPAM_IRRELEVANT', 'SPAM_IRRELEVANT', {
        language: 'banglish',
        usage: undefined,
        latencyMs: 0,
      }),
    ]);
    expect(report.tokens).toEqual({
      prompt: 2000,
      completion: 100,
      total: 2100,
      itemsWithUsage: 2,
    });
    expect(report.latency).toEqual({ avgMs: 134, maxMs: 300 });
    expect(report.attempts).toEqual({ total: 4, max: 2 });
    expect(report.byLanguage).toEqual({
      bn: { total: 2, correct: 1, accuracy: 0.5 },
      banglish: { total: 1, correct: 1, accuracy: 1 },
      en: { total: 0, correct: 0, accuracy: null },
    });
    expect(report.byTag).toEqual({
      bkash: { total: 2, correct: 1, accuracy: 0.5 },
      injection: { total: 1, correct: 0, accuracy: 0 },
    });
  });

  it('estimates cost from the price table, or n/a', () => {
    const outcomes = [
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY'),
      outcome('SAFE_INQUIRY', 'SAFE_INQUIRY'),
    ];
    const price = modelPrice('openai', 'gpt-4.1-mini');
    expect(price).toEqual({ input: 0.4, output: 1.6 });
    const report = scoreGolden(outcomes, price);
    // 2000 prompt × 0.4 + 100 completion × 1.6 per 1M tokens.
    expect(report.costUsd?.total).toBeCloseTo(0.00096, 10);
    expect(report.costUsd?.perItem).toBeCloseTo(0.00048, 10);
    expect(modelPrice('neon', 'unlisted-model')).toBeNull();
    expect(scoreGolden(outcomes, null).costUsd).toBeNull();
    // A price but no usage reported → n/a, not $0.
    expect(
      scoreGolden(
        [outcome('SAFE_INQUIRY', 'SAFE_INQUIRY', { usage: undefined })],
        price,
      ).costUsd,
    ).toBeNull();
  });
});

describe('formatGoldenReport', () => {
  it('prints the summary, matrix, slices, cost and mistakes', () => {
    const report = scoreGolden(
      [
        outcome('SAFE_INQUIRY', 'SAFE_INQUIRY', { tags: ['mixed'] }),
        outcome(
          'SCAM_PHISHING',
          { kind: 'invalid_output' },
          { usage: undefined },
        ),
      ],
      null,
    );
    const text = formatGoldenReport(report, {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      level: 'comment_only',
      promptVersion: 'moderation-v1',
      source: 'live',
    });
    expect(text).toContain(
      'Golden suite · openai / gpt-4.1-mini · level comment_only · prompt moderation-v1 · live',
    );
    expect(text).toContain(
      'Accuracy: 50.0 % (1/2) · failed calls: 1 · gate ≥ 90 %: FAIL',
    );
    expect(text).toMatch(/SPAM_IRRELEVANT\s+0\s+n\/a\s+n\/a/);
    expect(text).toMatch(/SCAM\s+0\s+0\s+0\s+0\s+0\s+1/);
    expect(text).toContain('Failures by kind: invalid_output 1');
    expect(text).toContain('By tag: mixed 1/1');
    expect(text).toContain('usage on 1/2 items');
    expect(text).toContain('Estimated cost: n/a');
    expect(text).toMatch(
      /- item-\d+: expected SCAM_PHISHING, got FAILED \(failed: invalid_output\) · "comment \d+"/,
    );
  });
});
