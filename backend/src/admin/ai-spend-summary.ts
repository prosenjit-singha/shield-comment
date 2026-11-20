import type { AiProvider } from '../ai-gateway/ai-provider.js';
import {
  lookupModelPrice,
  type ModelPriceTable,
} from '../moderation/ai-model-prices.js';
import { POLICY_ACTIONS } from '../moderation/moderation.constants.js';
import { aiUsageDays, roundUsd, tokenCostUsd } from './ai-usage-summary.js';
import { DASHBOARD_TIMEZONE, dhakaMidnight } from './dashboard-range.js';
import type {
  AiDecision,
  AiSpendByModel,
  AiSpendSummary,
} from './dto/admin-ai.dto.js';

/**
 * Pure maths of the admin AI spend summary + analysis log costs (M5-T15d, D25/D26). Prices and
 * rounding come from the A6 card maths (`ai-usage-summary.ts`). No I/O.
 */

/** Estimated USD of one classification; `null` when its tokens or the model's price are unknown. */
export function analysisCostUsd(
  prices: ModelPriceTable,
  row: {
    provider: AiProvider;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
  },
): number | null {
  if (row.inputTokens === null || row.outputTokens === null) return null;
  const price = lookupModelPrice(prices, row.provider, row.model);
  return price
    ? roundUsd(tokenCostUsd(price, row.inputTokens, row.outputTokens))
    : null;
}

/** Start instants of the Dhaka "today" and "last 7 days (incl. today)" windows. */
export function analyzedSince(now: Date): { today: Date; last7Days: Date } {
  const { from, today } = aiUsageDays(now);
  return { today: dhakaMidnight(today), last7Days: dhakaMidnight(from) };
}

/** All-time `daily_ai_usage` per provider + model. */
export interface AiModelTotalsRow {
  provider: AiProvider;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Analyzed comments per decision + provider + model (tokens summed over non-null rows). */
export interface AiDecisionTotalsRow {
  decision: AiDecision;
  provider: AiProvider;
  model: string;
  comments: number;
  /** Comments of the group without stored tokens. */
  withoutTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export function buildAiSpendSummary(input: {
  now: Date;
  prices: ModelPriceTable;
  creditAddedUsd: number;
  modelRows: readonly AiModelTotalsRow[];
  decisionRows: readonly AiDecisionTotalsRow[];
  commentsAnalyzed: AiSpendSummary['commentsAnalyzed'];
}): AiSpendSummary {
  const { prices } = input;
  let spend = 0;
  let unpricedCalls = 0;
  const tokens = { input: 0, output: 0 };
  const spendByModel: AiSpendByModel[] = input.modelRows
    .toSorted(
      (a, b) =>
        a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    )
    .map((row) => {
      tokens.input += row.inputTokens;
      tokens.output += row.outputTokens;
      const price = lookupModelPrice(prices, row.provider, row.model);
      const cost = price
        ? tokenCostUsd(price, row.inputTokens, row.outputTokens)
        : null;
      if (cost === null) unpricedCalls += row.calls;
      else spend += cost;
      return { ...row, costUsd: cost === null ? null : roundUsd(cost) };
    });

  const byDecision = new Map(
    POLICY_ACTIONS.map((d) => [d, { comments: 0, cost: 0, unpriced: 0 }]),
  );
  for (const row of input.decisionRows) {
    const acc = byDecision.get(row.decision);
    if (!acc) continue;
    acc.comments += row.comments;
    const price = lookupModelPrice(prices, row.provider, row.model);
    if (price) {
      acc.cost += tokenCostUsd(price, row.inputTokens, row.outputTokens);
      acc.unpriced += row.withoutTokens;
    } else {
      acc.unpriced += row.comments;
    }
  }

  const creditAddedUsd = Math.round(input.creditAddedUsd * 100) / 100;
  return {
    asOf: input.now,
    timezone: DASHBOARD_TIMEZONE,
    creditAddedUsd,
    estimatedSpendUsd: roundUsd(spend),
    estimatedRemainingUsd: roundUsd(creditAddedUsd - spend),
    unpricedCalls,
    commentsAnalyzed: input.commentsAnalyzed,
    tokens,
    spendByModel,
    spendByDecision: [...byDecision].map(([decision, acc]) => ({
      decision,
      comments: acc.comments,
      costUsd: roundUsd(acc.cost),
      unpricedComments: acc.unpriced,
    })),
  };
}
