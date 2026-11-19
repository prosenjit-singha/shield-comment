import type { AiProvider } from '../ai-gateway/ai-provider.js';
import {
  lookupModelPrice,
  type ModelPrice,
  type ModelPriceTable,
} from '../moderation/ai-model-prices.js';
import {
  addDays,
  DASHBOARD_TIMEZONE,
  dhakaBucketKey,
} from './dashboard-range.js';
import type {
  AiModelUsage,
  AiUsageReport,
  AiUsageStats,
  AiUsageWindow,
} from './dto/system-health.dto.js';

/**
 * Pure maths of the A6 "AI moderation" card (M5-T13, D14): `daily_ai_usage` rows → today + last
 * 7 Dhaka days, per provider + model and in total, with an estimated cost. No I/O.
 */

/** The 7-day window includes today. */
export const AI_USAGE_WINDOW_DAYS = 7;

/** The `daily_ai_usage` columns the summary reads. */
export interface AiUsageRow {
  day: string;
  provider: AiProvider;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  failedCalls: number;
  failuresByKind: Readonly<Record<string, number>>;
  latencyMsSum: number;
  latencyMsMax: number;
}

/** Dhaka days of both windows for an instant: `today` and the first day of the 7-day window. */
export function aiUsageDays(now: Date): { from: string; today: string } {
  const today = dhakaBucketKey(now, 'day');
  return { from: addDays(today, -(AI_USAGE_WINDOW_DAYS - 1)), today };
}

/** USD with 6 decimals (a few thousand tokens cost fractions of a cent). */
export function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/** BDT with 2 decimals (poisha), half away from zero. */
export function roundBdt(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Unrounded USD for the tokens at a price (USD per 1M tokens). */
export function tokenCostUsd(
  price: ModelPrice,
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

interface Accumulator {
  calls: number;
  failedCalls: number;
  failuresByKind: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  credits: number;
  latencyMsSum: number;
  latencyMsMax: number;
}

function emptyAccumulator(): Accumulator {
  return {
    calls: 0,
    failedCalls: 0,
    failuresByKind: {},
    inputTokens: 0,
    outputTokens: 0,
    credits: 0,
    latencyMsSum: 0,
    latencyMsMax: 0,
  };
}

function add(
  acc: Accumulator,
  row: Omit<Accumulator, 'failuresByKind'> & {
    failuresByKind: Readonly<Record<string, number>>;
  },
): void {
  acc.calls += row.calls;
  acc.failedCalls += row.failedCalls;
  acc.inputTokens += row.inputTokens;
  acc.outputTokens += row.outputTokens;
  acc.credits += row.credits;
  acc.latencyMsSum += row.latencyMsSum;
  acc.latencyMsMax = Math.max(acc.latencyMsMax, row.latencyMsMax);
  for (const [kind, n] of Object.entries(row.failuresByKind)) {
    if (Number.isFinite(n) && n > 0) {
      acc.failuresByKind[kind] = (acc.failuresByKind[kind] ?? 0) + n;
    }
  }
}

function stats(
  acc: Accumulator,
  costUsd: number | null,
  rate: number,
): AiUsageStats {
  return {
    calls: acc.calls,
    failedCalls: acc.failedCalls,
    // Sorted keys: a stable JSON shape for the UI and tests.
    failuresByKind: Object.fromEntries(
      Object.entries(acc.failuresByKind).toSorted(([a], [b]) =>
        a.localeCompare(b),
      ),
    ),
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    credits: acc.credits,
    avgLatencyMs:
      acc.calls > 0 ? Math.round(acc.latencyMsSum / acc.calls) : null,
    maxLatencyMs: acc.calls > 0 ? acc.latencyMsMax : null,
    estimatedCostUsd: costUsd === null ? null : roundUsd(costUsd),
    estimatedCostBdt: costUsd === null ? null : roundBdt(costUsd * rate),
  };
}

/** One window: rows of days `from..to` (others ignored), per provider + model and in total. */
export function summarizeAiUsageWindow(
  rows: readonly AiUsageRow[],
  window: { from: string; to: string },
  prices: ModelPriceTable,
  usdToBdtRate: number,
): AiUsageWindow {
  const perModel = new Map<
    string,
    { provider: AiProvider; model: string; acc: Accumulator }
  >();
  const total = emptyAccumulator();
  for (const row of rows) {
    if (row.day < window.from || row.day > window.to) continue;
    const key = `${row.provider}\u0000${row.model}`;
    let entry = perModel.get(key);
    if (!entry) {
      entry = {
        provider: row.provider,
        model: row.model,
        acc: emptyAccumulator(),
      };
      perModel.set(key, entry);
    }
    add(entry.acc, row);
    add(total, row);
  }

  let pricedCostUsd = 0;
  let pricedModelsWithCalls = 0;
  let unpricedModels = 0;
  const models: AiModelUsage[] = [...perModel.values()]
    .toSorted(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    )
    .map(({ provider, model, acc }) => {
      const price = lookupModelPrice(prices, provider, model);
      const costUsd = price
        ? tokenCostUsd(price, acc.inputTokens, acc.outputTokens)
        : null;
      if (costUsd !== null) {
        pricedCostUsd += costUsd;
        if (acc.calls > 0) pricedModelsWithCalls++;
      } else if (acc.calls > 0) {
        unpricedModels++;
      }
      return {
        provider,
        model,
        ...stats(acc, costUsd, usdToBdtRate),
        priceUsdPer1M: price
          ? { input: price.input, output: price.output }
          : null,
      };
    });

  // Every model with calls unpriced → the total is unknown, not 0.
  const totalCostUsd =
    unpricedModels > 0 && pricedModelsWithCalls === 0 ? null : pricedCostUsd;
  return {
    from: window.from,
    to: window.to,
    totals: { ...stats(total, totalCostUsd, usdToBdtRate), unpricedModels },
    models,
  };
}

/** The `ai` block of `GET /api/admin/system/health` from the rows of the last 7 Dhaka days. */
export function buildAiUsageReport(
  rows: readonly AiUsageRow[],
  options: { now: Date; prices: ModelPriceTable; usdToBdtRate: number },
): AiUsageReport {
  const { from, today } = aiUsageDays(options.now);
  return {
    timezone: DASHBOARD_TIMEZONE,
    usdToBdtRate: options.usdToBdtRate,
    today: summarizeAiUsageWindow(
      rows,
      { from: today, to: today },
      options.prices,
      options.usdToBdtRate,
    ),
    last7Days: summarizeAiUsageWindow(
      rows,
      { from, to: today },
      options.prices,
      options.usdToBdtRate,
    ),
  };
}
