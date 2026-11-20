/**
 * Neon AI Gateway models the admin can pick (M5-T15b, decisions D19/D22). Pure constant: the
 * single source of model facts and list prices (USD per 1M tokens, "no Neon markup").
 * Source: https://neon.com/ai-gateway#models (page "Last updated" 2026-11-17) + live
 * `GET <gateway>/v1/models` (`architecture.input_modalities`, `pricing`, `dialects`), both checked
 * 2026-11-20. Differences: the page says `pdf` where `/v1/models` says `file` (kept: `file`);
 * the page shows no inputs and no output price for Jev ("—"), `/v1/models` lists text + image and
 * `completion: "0"` (Neon Decisions doc: decision models bill input tokens only); Claude Haiku 5.5
 * costs $0.50 / $2.50 above 100K prompt tokens (`/v1/models` override; comments never get near).
 * `null` price = not published (cost "n/a"); `free` = the page says "Free" (prices 0).
 */

export const NEON_MODEL_INPUTS = [
  'text',
  'image',
  'video',
  'audio',
  'file',
] as const;
export type NeonModelInput = (typeof NEON_MODEL_INPUTS)[number];

/** Wire format: `chat` = `/v1/chat/completions`; `systemone` = TypeSafe typed questions (D24). */
export type NeonModelDialect = 'chat' | 'systemone';

export interface NeonModel {
  /** Gateway model id. */
  code: string;
  name: string;
  lab: string;
  inputs: readonly NeonModelInput[];
  /** Tokens. */
  contextWindow: number;
  inputUsdPer1M: number | null;
  outputUsdPer1M: number | null;
  free: boolean;
  dialect: NeonModelDialect;
  /** `/v1/models` `features.temperature`; `false` = the gateway 400s on `temperature` (M5-T16). */
  temperature: boolean;
}

export const NEON_MODEL_CATALOG_SOURCE = {
  url: 'https://neon.com/ai-gateway#models',
  checkedAt: '2026-11-20',
} as const;

export const NEON_MODEL_CATALOG: readonly NeonModel[] = [
  {
    code: 'gemini-4-carbon',
    name: 'Gemini 4 Carbon',
    lab: 'Google',
    inputs: ['text', 'image', 'video', 'audio', 'file'],
    contextWindow: 1_048_576,
    inputUsdPer1M: 0,
    outputUsdPer1M: 0,
    free: true,
    dialect: 'chat',
    temperature: false,
  },
  {
    code: 'typesafeai-jev-1-14-0',
    name: 'Jev 1.14',
    lab: 'TypeSafe AI',
    inputs: ['text', 'image'],
    contextWindow: 65_536,
    inputUsdPer1M: 0.042,
    // Not on the page; input-only billing per the Neon Decisions doc + `/v1/models` completion "0".
    outputUsdPer1M: 0,
    free: false,
    dialect: 'systemone',
    temperature: false,
  },
  {
    code: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    lab: 'Anthropic',
    inputs: ['text', 'image', 'file'],
    contextWindow: 200_000,
    inputUsdPer1M: 0.1,
    outputUsdPer1M: 0.5,
    free: false,
    dialect: 'chat',
    temperature: false,
  },
  {
    code: 'gpt-oss-20b',
    name: 'GPT OSS 20B',
    lab: 'OpenAI',
    inputs: ['text'],
    contextWindow: 131_072,
    inputUsdPer1M: 0.07,
    outputUsdPer1M: 0.3,
    free: false,
    dialect: 'chat',
    temperature: true,
  },
  {
    code: 'gpt-oss-120b',
    name: 'GPT OSS 120B',
    lab: 'OpenAI',
    inputs: ['text'],
    contextWindow: 131_072,
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
    free: false,
    dialect: 'chat',
    temperature: true,
  },
];

/** Default Text + Image model (D22); the Text model default is `DEFAULT_AI_MODELS.neon`. */
export const DEFAULT_TEXT_IMAGE_MODEL = 'claude-haiku-5-5';

export function neonModel(code: string): NeonModel | undefined {
  return NEON_MODEL_CATALOG.find((m) => m.code === code);
}

/** Unknown models keep `temperature` (the gateway decides). */
export function acceptsTemperature(code: string): boolean {
  return neonModel(code)?.temperature ?? true;
}

export function supportsImages(code: string): boolean {
  return neonModel(code)?.inputs.includes('image') ?? false;
}
