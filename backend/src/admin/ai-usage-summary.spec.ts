import {
  DEFAULT_AI_MODEL_PRICES,
  type ModelPriceTable,
} from '../moderation/ai-model-prices.js';
import {
  aiUsageDays,
  type AiUsageRow,
  buildAiUsageReport,
  roundBdt,
  roundUsd,
  summarizeAiUsageWindow,
  tokenCostUsd,
} from './ai-usage-summary.js';

function row(day: string, overrides: Partial<AiUsageRow> = {}): AiUsageRow {
  return {
    day,
    provider: 'openai',
    model: 'gpt-4.1-mini',
    calls: 4,
    inputTokens: 2000,
    outputTokens: 400,
    credits: 5,
    failedCalls: 0,
    failuresByKind: {},
    latencyMsSum: 2000,
    latencyMsMax: 800,
    ...overrides,
  };
}

const PRICES: ModelPriceTable = DEFAULT_AI_MODEL_PRICES;

describe('aiUsageDays (Asia/Dhaka)', () => {
  it.each([
    // 23:59:59.999 Dhaka on Nov 18 → still Nov 18.
    ['2026-11-18T17:59:59.999Z', '2026-11-18', '2026-11-12'],
    // 00:00 Dhaka on Nov 19.
    ['2026-11-18T18:00:00.000Z', '2026-11-19', '2026-11-13'],
    // Month + leap-day edges.
    ['2024-03-01T05:00:00.000Z', '2024-03-01', '2024-02-24'],
    ['2026-01-02T00:00:00.000Z', '2026-01-02', '2025-12-27'],
  ])(
    '%s → today %s, window from %s (7 days incl. today)',
    (now, today, from) => {
      expect(aiUsageDays(new Date(now))).toEqual({ today, from });
    },
  );
});

describe('cost helpers', () => {
  it('tokenCostUsd = (input × in + output × out) / 1M', () => {
    expect(tokenCostUsd({ input: 0.4, output: 1.6 }, 2000, 400)).toBeCloseTo(
      0.00144,
      12,
    );
    expect(tokenCostUsd({ input: 1, output: 5 }, 0, 0)).toBe(0);
  });

  it('roundUsd keeps 6 decimals; roundBdt 2 decimals, half up', () => {
    expect(roundUsd(0.0000014999)).toBe(0.000001);
    expect(roundUsd(0.1234565)).toBe(0.123457);
    expect(roundBdt(1.005)).toBe(1.01);
    expect(roundBdt(0.175668)).toBe(0.18);
    expect(roundBdt(0.004)).toBe(0);
  });
});

describe('summarizeAiUsageWindow', () => {
  const window = { from: '2026-11-12', to: '2026-11-18' };

  it('empty usage → zeros, null latency, cost 0, no models', () => {
    expect(summarizeAiUsageWindow([], window, PRICES, 122)).toEqual({
      ...window,
      totals: {
        calls: 0,
        failedCalls: 0,
        failuresByKind: {},
        inputTokens: 0,
        outputTokens: 0,
        credits: 0,
        avgLatencyMs: null,
        maxLatencyMs: null,
        estimatedCostUsd: 0,
        estimatedCostBdt: 0,
        unpricedModels: 0,
      },
      models: [],
    });
  });

  it('sums days per provider + model, prices known models, BDT at the rate', () => {
    const w = summarizeAiUsageWindow(
      [row('2026-11-12'), row('2026-11-18', { latencyMsMax: 1500 })],
      window,
      PRICES,
      121.5,
    );
    expect(w.models).toEqual([
      {
        provider: 'openai',
        model: 'gpt-4.1-mini',
        calls: 8,
        failedCalls: 0,
        failuresByKind: {},
        inputTokens: 4000,
        outputTokens: 800,
        credits: 10,
        avgLatencyMs: 500,
        maxLatencyMs: 1500,
        // 4000 × 0.4 + 800 × 1.6 = 2880 / 1M.
        estimatedCostUsd: 0.00288,
        // 0.00288 × 121.5 = 0.34992 → 0.35.
        estimatedCostBdt: 0.35,
        priceUsdPer1M: { input: 0.4, output: 1.6 },
      },
    ]);
    expect(w.totals).toMatchObject({
      calls: 8,
      estimatedCostUsd: 0.00288,
      estimatedCostBdt: 0.35,
      unpricedModels: 0,
    });
  });

  it('an unknown model has cost null and is left out of the total (counted as unpriced)', () => {
    const w = summarizeAiUsageWindow(
      [
        row('2026-11-18'),
        row('2026-11-18', { provider: 'neon', model: 'gpt-oss-20b' }),
      ],
      window,
      PRICES,
      122,
    );
    expect(w.models.map((m) => [m.provider, m.estimatedCostUsd])).toEqual([
      ['neon', null],
      ['openai', 0.00144],
    ]);
    expect(w.models[0]?.priceUsdPer1M).toBeNull();
    expect(w.models[0]?.estimatedCostBdt).toBeNull();
    expect(w.totals).toMatchObject({
      calls: 8,
      inputTokens: 4000,
      estimatedCostUsd: 0.00144,
      estimatedCostBdt: 0.18,
      unpricedModels: 1,
    });
  });

  it('only unpriced models with calls → total cost null', () => {
    const w = summarizeAiUsageWindow(
      [row('2026-11-18', { provider: 'neon', model: 'gpt-oss-20b' })],
      window,
      PRICES,
      122,
    );
    expect(w.totals.estimatedCostUsd).toBeNull();
    expect(w.totals.estimatedCostBdt).toBeNull();
    expect(w.totals.unpricedModels).toBe(1);
  });

  it('merges failures by kind across days and models (sorted keys, zeros dropped)', () => {
    const w = summarizeAiUsageWindow(
      [
        row('2026-11-12', {
          failedCalls: 3,
          failuresByKind: { timeout: 2, rate_limited: 1 },
        }),
        row('2026-11-13', {
          failedCalls: 2,
          failuresByKind: { timeout: 1, invalid_output: 1, network: 0 },
        }),
        row('2026-11-13', {
          provider: 'google',
          model: 'gemini-2.5-flash-lite',
          failedCalls: 1,
          failuresByKind: { server_error: 1 },
        }),
      ],
      window,
      PRICES,
      122,
    );
    expect(w.totals.failedCalls).toBe(6);
    expect(w.totals.failuresByKind).toEqual({
      invalid_output: 1,
      rate_limited: 1,
      server_error: 1,
      timeout: 3,
    });
    expect(Object.keys(w.totals.failuresByKind)).toEqual([
      'invalid_output',
      'rate_limited',
      'server_error',
      'timeout',
    ]);
    expect(w.models.map((m) => m.model)).toEqual([
      'gemini-2.5-flash-lite',
      'gpt-4.1-mini',
    ]);
  });

  it('ignores rows outside the window', () => {
    const w = summarizeAiUsageWindow(
      [row('2026-11-11'), row('2026-11-19'), row('2026-11-15')],
      window,
      PRICES,
      122,
    );
    expect(w.totals.calls).toBe(4);
  });
});

describe('buildAiUsageReport', () => {
  it('splits today from the 7-day window on the Dhaka day boundary', () => {
    const rows = [
      row('2026-11-12', { calls: 1, latencyMsSum: 100, latencyMsMax: 100 }),
      row('2026-11-18', { calls: 2, latencyMsSum: 300, latencyMsMax: 200 }),
      row('2026-11-19', { calls: 4, latencyMsSum: 400, latencyMsMax: 100 }),
    ];
    // 23:59 Dhaka on Nov 18: Nov 19 is tomorrow, Nov 12 is the window's first day.
    const late = buildAiUsageReport(rows, {
      now: new Date('2026-11-18T17:59:00.000Z'),
      prices: PRICES,
      usdToBdtRate: 122,
    });
    expect(late.timezone).toBe('Asia/Dhaka');
    expect(late.usdToBdtRate).toBe(122);
    expect(late.today).toMatchObject({ from: '2026-11-18', to: '2026-11-18' });
    expect(late.today.totals).toMatchObject({
      calls: 2,
      avgLatencyMs: 150,
      maxLatencyMs: 200,
    });
    expect(late.last7Days.totals.calls).toBe(3);
    // One minute later it is Nov 19 in Dhaka: Nov 12 leaves the window.
    const midnight = buildAiUsageReport(rows, {
      now: new Date('2026-11-18T18:00:00.000Z'),
      prices: PRICES,
      usdToBdtRate: 122,
    });
    expect(midnight.today.totals.calls).toBe(4);
    expect(midnight.last7Days).toMatchObject({
      from: '2026-11-13',
      to: '2026-11-19',
    });
    expect(midnight.last7Days.totals.calls).toBe(6);
  });
});
