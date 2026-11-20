import type { AiUsage } from '../ai-gateway/ai-adapter.js';
import type { AiProvider } from '../ai-gateway/ai-provider.js';
import {
  DEFAULT_AI_MODEL_PRICES,
  lookupModelPrice,
  type ModelPrice,
} from './ai-model-prices.js';
import type { GoldenComment } from './golden-fixture.js';
import {
  COMMENT_LANGUAGES,
  type CommentLanguage,
  MODERATION_CATEGORIES,
  type ModerationCategory,
} from './moderation.constants.js';
import type { ClassifierOutputMode } from './moderation-prompt.js';

/**
 * Pure scorer of a golden-suite run (M5-T6, D12): accuracy, per-category precision / recall,
 * confusion matrix, failures by kind, tokens, latency and an estimated cost. No I/O.
 */

/** Gate (spec § "Agent Test & Verification Gate"): ≥ 90 % of the fixture classified correctly. */
export const GOLDEN_PASS_ACCURACY = 0.9;

/** What one fixture item produced. A failed classification counts as a wrong answer. */
export interface GoldenOutcome {
  item: Pick<GoldenComment, 'id' | 'text' | 'expected' | 'language' | 'tags'>;
  result:
    | {
        ok: true;
        category: ModerationCategory;
        confidence: number;
        /** Output mode that answered (after any fallback), or `systemone` (Jev typed questions). */
        outputMode?: ClassifierOutputMode | 'systemone';
      }
    | { ok: false; kind: string };
  /** Tokens of every call made for this item (retries included); absent = provider sent none. */
  usage?: AiUsage;
  /** Provider time of every call made for this item, ms. */
  latencyMs: number;
  attempts: number;
}

/** USD per 1M tokens (shared with the admin AI usage card, M5-T13). */
export type { ModelPrice };

/**
 * List prices for the estimate (`DEFAULT_AI_MODEL_PRICES`, USD per 1M tokens). Only an estimate:
 * check the provider before trusting it. Unknown provider/model → cost "n/a".
 */
export const GOLDEN_MODEL_PRICES = DEFAULT_AI_MODEL_PRICES;

export function modelPrice(
  provider: AiProvider,
  model: string,
): ModelPrice | null {
  return lookupModelPrice(GOLDEN_MODEL_PRICES, provider, model);
}

export interface CategoryScore {
  /** Items whose label is this category. */
  support: number;
  /** Successful answers with this category. */
  predicted: number;
  truePositives: number;
  /** `null` when nothing was predicted as this category (0 / 0). */
  precision: number | null;
  /** `null` when no item has this label (0 / 0). */
  recall: number | null;
}

export interface SliceScore {
  total: number;
  correct: number;
  accuracy: number | null;
}

export const FAILED_COLUMN = 'FAILED';
export type ConfusionColumn = ModerationCategory | typeof FAILED_COLUMN;

export interface GoldenReport {
  total: number;
  correct: number;
  /** Items whose classification failed (no category). */
  failed: number;
  /** `correct / total`; `null` for an empty run. */
  accuracy: number | null;
  passed: boolean;
  perCategory: Record<ModerationCategory, CategoryScore>;
  /** Rows = expected label, columns = answer (or `FAILED`). */
  confusion: Record<ModerationCategory, Record<ConfusionColumn, number>>;
  failuresByKind: Record<string, number>;
  byLanguage: Record<CommentLanguage, SliceScore>;
  byTag: Record<string, SliceScore>;
  mistakes: {
    id: string;
    text: string;
    expected: ModerationCategory;
    got: ConfusionColumn;
    detail: string;
  }[];
  tokens: {
    prompt: number;
    completion: number;
    total: number;
    /** Items whose calls reported usage (the rest are missing from the sums). */
    itemsWithUsage: number;
  };
  latency: { avgMs: number; maxMs: number } | null;
  attempts: { total: number; max: number };
  /** `null` = no price for the model, or no usage reported. */
  costUsd: { total: number; perItem: number } | null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function slice(outcomes: readonly GoldenOutcome[]): SliceScore {
  const correct = outcomes.filter(isCorrect).length;
  return {
    total: outcomes.length,
    correct,
    accuracy: ratio(correct, outcomes.length),
  };
}

function isCorrect(outcome: GoldenOutcome): boolean {
  return outcome.result.ok && outcome.result.category === outcome.item.expected;
}

function emptyRow(): Record<ConfusionColumn, number> {
  const row = Object.fromEntries(
    MODERATION_CATEGORIES.map((c) => [c, 0]),
  ) as Record<ModerationCategory, number>;
  return { ...row, [FAILED_COLUMN]: 0 };
}

export function scoreGolden(
  outcomes: readonly GoldenOutcome[],
  price: ModelPrice | null = null,
): GoldenReport {
  const confusion = Object.fromEntries(
    MODERATION_CATEGORIES.map((c) => [c, emptyRow()]),
  ) as Record<ModerationCategory, Record<ConfusionColumn, number>>;
  const failuresByKind: Record<string, number> = {};
  const mistakes: GoldenReport['mistakes'] = [];
  let prompt = 0;
  let completion = 0;
  let total = 0;
  let itemsWithUsage = 0;
  let latencySum = 0;
  let latencyMax = 0;
  let attemptsTotal = 0;
  let attemptsMax = 0;

  for (const outcome of outcomes) {
    const { item, result } = outcome;
    const got: ConfusionColumn = result.ok ? result.category : FAILED_COLUMN;
    confusion[item.expected][got] += 1;
    if (!result.ok) {
      failuresByKind[result.kind] = (failuresByKind[result.kind] ?? 0) + 1;
    }
    if (got !== item.expected) {
      mistakes.push({
        id: item.id,
        text: item.text,
        expected: item.expected,
        got,
        detail: result.ok
          ? `confidence ${result.confidence}`
          : `failed: ${result.kind}`,
      });
    }
    if (outcome.usage) {
      itemsWithUsage += 1;
      prompt += outcome.usage.promptTokens;
      completion += outcome.usage.completionTokens;
      total += outcome.usage.totalTokens;
    }
    latencySum += outcome.latencyMs;
    latencyMax = Math.max(latencyMax, outcome.latencyMs);
    attemptsTotal += outcome.attempts;
    attemptsMax = Math.max(attemptsMax, outcome.attempts);
  }

  const perCategory = Object.fromEntries(
    MODERATION_CATEGORIES.map((category): [string, CategoryScore] => {
      const row = confusion[category];
      const support = Object.values(row).reduce((a, b) => a + b, 0);
      const predicted = MODERATION_CATEGORIES.reduce(
        (sum, expected) => sum + confusion[expected][category],
        0,
      );
      const truePositives = row[category];
      return [
        category,
        {
          support,
          predicted,
          truePositives,
          precision: ratio(truePositives, predicted),
          recall: ratio(truePositives, support),
        },
      ];
    }),
  ) as Record<ModerationCategory, CategoryScore>;

  const byLanguage = Object.fromEntries(
    COMMENT_LANGUAGES.map((language) => [
      language,
      slice(outcomes.filter((o) => o.item.language === language)),
    ]),
  ) as Record<CommentLanguage, SliceScore>;
  const tags = [...new Set(outcomes.flatMap((o) => o.item.tags))].sort();
  const byTag = Object.fromEntries(
    tags.map((tag) => [
      tag,
      slice(outcomes.filter((o) => o.item.tags.includes(tag))),
    ]),
  );

  const overall = slice(outcomes);
  const costTotal =
    price && itemsWithUsage > 0
      ? (prompt * price.input + completion * price.output) / 1_000_000
      : null;
  return {
    total: outcomes.length,
    correct: overall.correct,
    failed: outcomes.filter((o) => !o.result.ok).length,
    accuracy: overall.accuracy,
    passed:
      overall.accuracy !== null && overall.accuracy >= GOLDEN_PASS_ACCURACY,
    perCategory,
    confusion,
    failuresByKind,
    byLanguage,
    byTag,
    mistakes,
    tokens: { prompt, completion, total, itemsWithUsage },
    latency:
      outcomes.length === 0
        ? null
        : {
            avgMs: Math.round(latencySum / outcomes.length),
            maxMs: latencyMax,
          },
    attempts: { total: attemptsTotal, max: attemptsMax },
    costUsd:
      costTotal === null
        ? null
        : { total: costTotal, perItem: costTotal / itemsWithUsage },
  };
}

const ABBREVIATIONS: Record<ConfusionColumn, string> = {
  SAFE_INQUIRY: 'SAFE',
  COMPETITOR_POACH: 'COMP',
  SCAM_PHISHING: 'SCAM',
  SPAM_IRRELEVANT: 'SPAM',
  ABUSIVE_TOXIC: 'ABUSE',
  FAILED: 'FAIL',
};

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)} %`;
}

function usd(value: number): string {
  return value < 0.01 ? `$${value.toFixed(6)}` : `$${value.toFixed(4)}`;
}

function oneLine(text: string, max = 90): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}

/** Plain-text report for the terminal. Prints fixture comment text of mistakes, nothing else. */
export function formatGoldenReport(
  report: GoldenReport,
  header: {
    provider: string;
    model: string;
    level: string;
    promptVersion: string;
    source: string;
  },
): string {
  const lines: string[] = [];
  lines.push(
    `Golden suite · ${header.provider} / ${header.model} · level ${header.level} · prompt ${header.promptVersion} · ${header.source}`,
  );
  lines.push(
    `Accuracy: ${pct(report.accuracy)} (${report.correct}/${report.total}) · failed calls: ${report.failed} · gate ≥ ${GOLDEN_PASS_ACCURACY * 100} %: ${report.passed ? 'PASS' : 'FAIL'}`,
  );
  lines.push('');
  lines.push('Category           support  precision  recall');
  for (const category of MODERATION_CATEGORIES) {
    const s = report.perCategory[category];
    lines.push(
      `${category.padEnd(18)} ${String(s.support).padStart(7)}  ${pct(s.precision).padStart(9)}  ${pct(s.recall).padStart(7)}`,
    );
  }
  lines.push('');
  const columns: ConfusionColumn[] = [...MODERATION_CATEGORIES, FAILED_COLUMN];
  lines.push(
    `Confusion (rows = expected, cols = answer)\n${'expected'.padEnd(9)}${columns.map((c) => ABBREVIATIONS[c].padStart(6)).join('')}`,
  );
  for (const category of MODERATION_CATEGORIES) {
    lines.push(
      `${ABBREVIATIONS[category].padEnd(9)}${columns.map((c) => String(report.confusion[category][c]).padStart(6)).join('')}`,
    );
  }
  lines.push('');
  lines.push(
    `By language: ${COMMENT_LANGUAGES.map((l) => `${l} ${pct(report.byLanguage[l].accuracy)} (${report.byLanguage[l].correct}/${report.byLanguage[l].total})`).join(' · ')}`,
  );
  lines.push(
    `By tag: ${Object.entries(report.byTag)
      .map(([tag, s]) => `${tag} ${s.correct}/${s.total}`)
      .join(' · ')}`,
  );
  const kinds = Object.entries(report.failuresByKind);
  lines.push(
    `Failures by kind: ${kinds.length === 0 ? 'none' : kinds.map(([k, n]) => `${k} ${n}`).join(' · ')}`,
  );
  lines.push(
    `Tokens: prompt ${report.tokens.prompt} · completion ${report.tokens.completion} · total ${report.tokens.total} (usage on ${report.tokens.itemsWithUsage}/${report.total} items)`,
  );
  lines.push(
    `Latency: ${report.latency ? `avg ${report.latency.avgMs} ms · max ${report.latency.maxMs} ms` : 'n/a'} · calls ${report.attempts.total} (max ${report.attempts.max} per item)`,
  );
  lines.push(
    `Estimated cost: ${report.costUsd ? `${usd(report.costUsd.total)} total · ${usd(report.costUsd.perItem)} per comment (list price, estimate)` : 'n/a (no price for this model or no usage)'}`,
  );
  if (report.mistakes.length > 0) {
    lines.push('');
    lines.push('Mistakes:');
    for (const m of report.mistakes) {
      lines.push(
        `- ${m.id}: expected ${m.expected}, got ${m.got} (${m.detail}) · "${oneLine(m.text)}"`,
      );
    }
  }
  return lines.join('\n');
}
