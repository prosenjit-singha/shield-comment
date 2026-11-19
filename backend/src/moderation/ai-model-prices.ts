import { AI_PROVIDERS, type AiProvider } from '../ai-gateway/ai-provider.js';

/**
 * LLM list prices for cost **estimates** (golden suite M5-T6, admin AI usage M5-T13). Pure: no
 * Nest imports, so `env.validation.ts` can use the parser.
 */

/** USD per 1M tokens. */
export interface ModelPrice {
  input: number;
  output: number;
}

/** provider → model → price. A missing provider or model = unknown price (cost "n/a" / `null`). */
export type ModelPriceTable = Readonly<
  Partial<Record<AiProvider, Readonly<Record<string, ModelPrice>>>>
>;

/**
 * Built-in list prices (USD per 1M tokens, provider price pages, Nov 2026). Only an estimate:
 * check the provider before trusting it. Neon AI Gateway models have no entry (n/a) until the
 * operator sets one with `AI_MODEL_PRICES`.
 */
export const DEFAULT_AI_MODEL_PRICES: ModelPriceTable = {
  openai: {
    'gpt-4.1-mini': { input: 0.4, output: 1.6 },
    'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  },
  anthropic: {
    'claude-haiku-4-5': { input: 1, output: 5 },
  },
  google: {
    'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  },
};

/** Largest accepted price (USD per 1M tokens), a sanity bound for the env override. */
export const MAX_MODEL_PRICE_USD = 1000;

const PRICE_NUMBER = /^\d+(\.\d+)?$/;

/**
 * Parses `AI_MODEL_PRICES`: comma-separated `provider:model=input/output` entries (USD per 1M
 * tokens), e.g. `neon:gpt-oss-20b=0.05/0.2,openai:gpt-4.1-mini=0.4/1.6`. The provider ends at the
 * first `:`, the price starts after the last `=`, so model ids may contain `:` or `/`. Blank →
 * no entries. Throws `Error` with a message that names the bad entry's position (never secrets).
 */
export function parseModelPrices(text: string): ModelPriceTable {
  const table: Partial<Record<AiProvider, Record<string, ModelPrice>>> = {};
  const entries = text
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`;
    const colon = entry.indexOf(':');
    const equals = entry.lastIndexOf('=');
    if (colon < 1 || equals < colon + 2) {
      throw new Error(`${where} must look like provider:model=input/output`);
    }
    const provider = entry.slice(0, colon).trim();
    const model = entry.slice(colon + 1, equals).trim();
    const [input, output, ...rest] = entry.slice(equals + 1).split('/');
    if (!(AI_PROVIDERS as readonly string[]).includes(provider)) {
      throw new Error(
        `${where}: provider must be one of ${AI_PROVIDERS.join(', ')}`,
      );
    }
    if (model.length === 0 || model.length > 100) {
      throw new Error(`${where}: model must be 1–100 characters`);
    }
    const price = (value: string | undefined) => {
      const v = value?.trim() ?? '';
      if (!PRICE_NUMBER.test(v)) return null;
      const n = Number(v);
      return n <= MAX_MODEL_PRICE_USD ? n : null;
    };
    const inputUsd = price(input);
    const outputUsd = price(output);
    if (rest.length > 0 || inputUsd === null || outputUsd === null) {
      throw new Error(
        `${where}: price must be input/output USD per 1M tokens (0–${MAX_MODEL_PRICE_USD})`,
      );
    }
    const models = (table[provider as AiProvider] ??= {});
    if (Object.hasOwn(models, model)) {
      throw new Error(`${where}: duplicate ${provider}:${model}`);
    }
    models[model] = { input: inputUsd, output: outputUsd };
  });
  return table;
}

/** `base` with `override`'s models added or replaced (per provider + model). */
export function mergeModelPrices(
  base: ModelPriceTable,
  override: ModelPriceTable,
): ModelPriceTable {
  const merged: Partial<Record<AiProvider, Record<string, ModelPrice>>> = {};
  for (const provider of AI_PROVIDERS) {
    const models = { ...base[provider], ...override[provider] };
    if (Object.keys(models).length > 0) merged[provider] = models;
  }
  return merged;
}

/** The price of a provider + model, or `null` when the table has none. */
export function lookupModelPrice(
  table: ModelPriceTable,
  provider: AiProvider,
  model: string,
): ModelPrice | null {
  const models = table[provider];
  return models && Object.hasOwn(models, model) ? models[model]! : null;
}
