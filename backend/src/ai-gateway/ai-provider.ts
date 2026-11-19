/**
 * LLM provider config (M5-T1, decisions D1/D16). Pure types + constants: no Nest imports, so
 * `env.validation.ts` can use `AI_PROVIDERS` without a cycle.
 */

export const AI_PROVIDERS = ['neon', 'openai', 'anthropic', 'google'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export function isAiProvider(value: unknown): value is AiProvider {
  return (
    typeof value === 'string' &&
    (AI_PROVIDERS as readonly string[]).includes(value)
  );
}

/** One resolved provider: everything `AiGatewayService.chat()` needs for a call. */
export interface AiProviderConfig {
  provider: AiProvider;
  /** Provider model id (Neon gateway catalog id, OpenAI / Gemini / Anthropic model name). */
  model: string;
  apiKey: string;
  /**
   * API root without the operation path. Neon: the bare branch host (`/v1` is appended when
   * missing); OpenAI `https://api.openai.com/v1`; Google the Gemini OpenAI-compatible root.
   */
  baseUrl: string;
}

/** Defaults when `AI_GATEWAY_MODEL` (later: the admin setting) names no model. M5-T16 bake-off may change them. */
export const DEFAULT_AI_MODELS: Readonly<Record<AiProvider, string>> = {
  /** Cheapest general chat model in the Neon catalog at wiring time (models.dev, Nov 2026). */
  neon: 'gpt-oss-20b',
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-haiku-4-5',
  google: 'gemini-2.5-flash-lite',
};

/** Fixed API roots for the direct providers (Neon's comes from `NEON_AI_GATEWAY_BASE_URL`). */
export const DEFAULT_AI_BASE_URLS: Readonly<
  Record<Exclude<AiProvider, 'neon'>, string>
> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com/v1beta/openai',
};

/**
 * The only place that reads LLM config. M5-T1 ships `EnvAiConfigResolver`; M5-T3 swaps in a DB
 * resolver (admin settings, keys encrypted) that falls back to env.
 * `null` = the active provider has no key (or, for Neon, no base URL): calls fail `not_configured`.
 */
export interface AiConfigResolver {
  resolve(): Promise<AiProviderConfig | null>;
}

export const AI_CONFIG_RESOLVER = Symbol('AI_CONFIG_RESOLVER');
