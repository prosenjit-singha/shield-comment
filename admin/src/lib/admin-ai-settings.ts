import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * A7 "AI provider" section (M5-T3 API, M5-T4 screen, decision D16). Mirrors the backend's
 * `src/admin/dto/ai-settings.dto.ts`, `AiConnectionTestResult` and `AiErrorKind`.
 *
 * - `GET /api/admin/settings/ai` → `AiSettingsResponse` (never a key: only `last4`).
 * - `PATCH /api/admin/settings/ai` `{ provider?, model?, keys?: { <p>: key | null } }` → same shape.
 *   400 = invalid / nothing to update; 503 `KEY_ENCRYPTION_NOT_CONFIGURED` = key save without cipher.
 * - `POST /api/admin/settings/ai/test` `{ provider?, model?, apiKey? }` (a draft over the saved
 *   config, never saved) → `AiConnectionTestResult`.
 * - `GET /api/admin/settings/ai/audit?skip&take` → `{ items, total, skip, take }`, newest first.
 *
 * Keys typed by the admin live only in the page's React state (the draft): never in Zustand,
 * `localStorage` or the query cache.
 */
export const AI_PROVIDERS = ['neon', 'openai', 'anthropic', 'google'] as const
export type AiProvider = (typeof AI_PROVIDERS)[number]

export type AiSettingSource = 'db' | 'env' | 'default'
export type AiKeySource = 'db' | 'env' | 'none'

export interface AiKeyStatus {
  /** A usable key exists (DB or `.env`). */
  configured: boolean
  source: AiKeySource
  /** Last 4 characters of the key in use, `null` when none. */
  last4: string | null
  /** A DB key exists but can't be decrypted: treated as unset. */
  unreadable: boolean
  /** When the DB key was saved; `null` = no DB key. */
  updatedAt: string | null
}

export interface AiProviderStatus {
  defaultModel: string
  /** Model used when this provider is the active one, and where it comes from. */
  model: string
  modelSource: AiSettingSource
  /** Neon needs `NEON_AI_GATEWAY_BASE_URL` (env only); the direct providers are always `true`. */
  baseUrlConfigured: boolean
  key: AiKeyStatus
}

export interface AiSettingsResponse {
  provider: AiProvider
  providerSource: AiSettingSource
  model: string
  modelSource: AiSettingSource
  /** The active provider has a key (and Neon a base URL): calls can be attempted. */
  configured: boolean
  /** Keys can be saved (`TOKEN_ENCRYPTION_KEY` set); else a key save answers 503. */
  cipherConfigured: boolean
  providers: Record<AiProvider, AiProviderStatus>
  updatedAt: string | null
  updatedBy: { id: string; name: string; email: string } | null
}

/** `PATCH` body: every key optional, at least one sent. A key string saves it, `null` clears the DB key. */
export interface UpdateAiSettingsBody {
  provider?: AiProvider
  model?: string | null
  keys?: Partial<Record<AiProvider, string | null>>
}

/** `POST …/ai/test` body: fields that differ from the saved config. `{}` tests the saved config. */
export interface TestAiConnectionBody {
  provider?: AiProvider
  model?: string
  apiKey?: string
}

export const AI_ERROR_KINDS = [
  'not_configured',
  'payment_required',
  'auth',
  'rate_limited',
  'transient',
  'timeout',
  'network',
  'invalid_request',
  'unexpected_response',
] as const
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number]

export type AiConnectionTestResult =
  | { ok: true; provider: AiProvider; model: string; latencyMs: number }
  | {
      ok: false
      kind: AiErrorKind
      latencyMs: number
      provider?: AiProvider
      model?: string
      /** The provider's message, scrubbed of keys by the backend (≤ 300 chars). */
      message?: string
    }

export type AiSettingsAuditField = 'provider' | 'model' | `key.${AiProvider}`

/**
 * One changed field. `provider`/`model`: DB values (`null` = `.env`/default fallback);
 * `key.<provider>`: `before` `set` | `null`, `after` `set` | `cleared`.
 */
export interface AiSettingsAuditEntry {
  id: string
  field: AiSettingsAuditField
  before: string | null
  after: string | null
  admin: { id: string; name: string; email: string }
  ip: string | null
  userAgent: string | null
  createdAt: string
}

export interface AiSettingsAuditList {
  items: AiSettingsAuditEntry[]
  total: number
  skip: number
  take: number
}

/** Same as the backend: model 1–100, key 8–500 printable ASCII characters without spaces, trimmed. */
export const AI_MODEL_MAX_LENGTH = 100
export const AI_KEY_MIN_LENGTH = 8
export const AI_KEY_MAX_LENGTH = 500
export const AI_MODEL_PATTERN = new RegExp(`^[\\x21-\\x7E]{1,${AI_MODEL_MAX_LENGTH}}$`)
export const AI_KEY_PATTERN = new RegExp(`^[\\x21-\\x7E]{${AI_KEY_MIN_LENGTH},${AI_KEY_MAX_LENGTH}}$`)

/** 503 `code` of a key save while `TOKEN_ENCRYPTION_KEY` is unset. */
export const KEY_ENCRYPTION_NOT_CONFIGURED = 'KEY_ENCRYPTION_NOT_CONFIGURED'

// ---------------------------------------------------------------------------------------------
// Labels

export const aiProviderLabels: Record<AiProvider, string> = {
  neon: 'Neon AI gateway',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
}

export const aiProviderHints: Record<AiProvider, string> = {
  neon: 'One key for many models, billed by Neon',
  openai: 'GPT models, direct',
  anthropic: 'Claude models, direct',
  google: 'Gemini models, direct',
}

export const aiSettingSourceLabels: Record<AiSettingSource, string> = {
  db: 'database',
  env: '.env',
  default: 'default',
}

export const aiKeySourceLabels: Record<AiKeySource, string> = {
  db: 'database',
  env: '.env',
  none: 'not set',
}

/**
 * Suggested model ids per provider (the backend's `DEFAULT_AI_MODELS` first). Suggestions only:
 * any id the provider accepts can be typed. The response's `defaultModel` is always offered too.
 */
export const AI_MODEL_SUGGESTIONS: Record<AiProvider, readonly string[]> = {
  neon: ['gpt-oss-20b', 'gpt-oss-120b'],
  openai: ['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini'],
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-4-5'],
  google: ['gemini-2.5-flash-lite', 'gemini-2.5-flash'],
}

/** `defaultModel` first, then the static suggestions, without duplicates. */
export function modelSuggestions(provider: AiProvider, status: AiProviderStatus | undefined): string[] {
  const list = [status?.defaultModel, ...AI_MODEL_SUGGESTIONS[provider]].filter((m): m is string => !!m)
  return [...new Set(list)]
}

/** `Saved ••••1234 · database`, `Saved · .env` (no last4), or `Not set`. */
export function keyStatusText(key: AiKeyStatus): string {
  if (!key.configured) return 'Not set'
  const masked = key.last4 ? ` ••••${key.last4}` : ''
  return `Saved${masked} · ${aiKeySourceLabels[key.source]}`
}

/** A key row exists in the DB (it may be unreadable): only this one can be cleared. */
export function hasDbKey(key: AiKeyStatus): boolean {
  return key.updatedAt !== null
}

export const aiErrorKindMessages: Record<AiErrorKind, string> = {
  not_configured: 'Not configured: this provider has no API key (or the Neon gateway URL is missing).',
  payment_required: 'The provider account needs credits or a paid plan.',
  auth: 'The API key was rejected. Check that it is correct and still active.',
  rate_limited: 'Rate limited by the provider. Try again in a minute.',
  transient: 'The provider had a temporary error. Try again.',
  timeout: "The provider didn't answer in time.",
  network: "Couldn't reach the provider (network error).",
  invalid_request: 'The provider rejected the request. Check the model id.',
  unexpected_response: "The provider's answer couldn't be read.",
}

/** Message for a failed probe; a kind added to the backend later still gets a sentence. */
export function aiErrorKindMessage(kind: string): string {
  return (aiErrorKindMessages as Record<string, string | undefined>)[kind] ?? `Connection failed (${kind}).`
}

export const KEY_ENCRYPTION_MESSAGE =
  "API keys can't be saved here: key encryption is not configured on the backend (TOKEN_ENCRYPTION_KEY). Keys from .env still work."

// ---------------------------------------------------------------------------------------------
// Queries

export const adminAiSettingsKey = ['admin', 'ai-settings'] as const
export const aiSettingsKey = [...adminAiSettingsKey, 'settings'] as const
export const aiSettingsAuditKey = [...adminAiSettingsKey, 'audit'] as const

export function aiSettingsQueryOptions() {
  return queryOptions({
    queryKey: aiSettingsKey,
    queryFn: ({ signal }) => apiFetch<AiSettingsResponse>('/admin/settings/ai', { signal }),
  })
}

export function updateAiSettings(body: UpdateAiSettingsBody) {
  return apiFetch<AiSettingsResponse>('/admin/settings/ai', { method: 'PATCH', body: JSON.stringify(body) })
}

export function testAiConnection(body: TestAiConnectionBody) {
  return apiFetch<AiConnectionTestResult>('/admin/settings/ai/test', { method: 'POST', body: JSON.stringify(body) })
}

export const AI_AUDIT_PAGE_SIZE = 20

/** `page` is 1-based. */
export function aiAuditParams(page: number): URLSearchParams {
  return new URLSearchParams({
    skip: String((Math.max(1, page) - 1) * AI_AUDIT_PAGE_SIZE),
    take: String(AI_AUDIT_PAGE_SIZE),
  })
}

/** Under `['admin','ai-settings']`, so a save's invalidation refreshes the history too. */
export function aiAuditQueryOptions(page: number) {
  const params = aiAuditParams(page)
  return queryOptions({
    queryKey: [...aiSettingsAuditKey, { skip: Number(params.get('skip')), take: AI_AUDIT_PAGE_SIZE }] as const,
    queryFn: ({ signal }) => apiFetch<AiSettingsAuditList>(`/admin/settings/ai/audit?${params.toString()}`, { signal }),
    placeholderData: keepPreviousData,
  })
}

// ---------------------------------------------------------------------------------------------
// Draft: strings so half-typed values can be shown and validated. Typed keys are write-only.

export interface AiDraft {
  provider: AiProvider
  model: string
  /** Typed (unsaved) keys; `''` = keep the saved one. */
  keys: Record<AiProvider, string>
  /** Confirmed "Clear" of the DB key, sent as `null` on save. */
  clearKeys: Record<AiProvider, boolean>
}

function perProvider<T>(value: T): Record<AiProvider, T> {
  return { neon: value, openai: value, anthropic: value, google: value }
}

/** The model a provider gets when it is (or becomes) the active one. */
export function effectiveModel(settings: AiSettingsResponse, provider: AiProvider): string {
  return provider === settings.provider ? settings.model : settings.providers[provider].model
}

export function draftFromAiSettings(settings: AiSettingsResponse): AiDraft {
  return { provider: settings.provider, model: settings.model, keys: perProvider(''), clearKeys: perProvider(false) }
}

/** Switching provider shows that provider's effective model (as the backend would resolve it). */
export function withProvider(draft: AiDraft, settings: AiSettingsResponse, provider: AiProvider): AiDraft {
  if (provider === draft.provider) return draft
  return { ...draft, provider, model: effectiveModel(settings, provider) }
}

export interface AiDraftErrors {
  model?: string
  keys: Partial<Record<AiProvider, string>>
}

/** Same rules as the backend's `UpdateAiSettingsDto` (after trimming). An empty key field is "unchanged". */
export function validateAiDraft(draft: AiDraft): AiDraftErrors {
  const errors: AiDraftErrors = { keys: {} }
  const model = draft.model.trim()
  if (model === '') errors.model = 'Enter a model id.'
  else if (model.length > AI_MODEL_MAX_LENGTH) errors.model = `Up to ${AI_MODEL_MAX_LENGTH} characters.`
  else if (!AI_MODEL_PATTERN.test(model)) errors.model = 'Use printable characters without spaces.'

  for (const provider of AI_PROVIDERS) {
    const key = draft.keys[provider].trim()
    if (key === '') continue
    if (key.length < AI_KEY_MIN_LENGTH || key.length > AI_KEY_MAX_LENGTH)
      errors.keys[provider] = `A key is ${AI_KEY_MIN_LENGTH}–${AI_KEY_MAX_LENGTH} characters.`
    else if (!AI_KEY_PATTERN.test(key)) errors.keys[provider] = 'Use printable characters without spaces.'
  }
  return errors
}

export function hasAiDraftErrors(errors: AiDraftErrors): boolean {
  return errors.model !== undefined || Object.keys(errors.keys).length > 0
}

/**
 * Minimal `PATCH` body: only what differs from the saved settings. Call it on a valid draft;
 * `{}` means nothing changed. A provider switch sends `model` only when it differs from what the
 * backend would pick for that provider (it resets the DB model when `model` is absent).
 */
export function aiSettingsPatch(draft: AiDraft, settings: AiSettingsResponse): UpdateAiSettingsBody {
  const body: UpdateAiSettingsBody = {}
  if (draft.provider !== settings.provider) body.provider = draft.provider
  const model = draft.model.trim()
  if (model !== '' && model !== effectiveModel(settings, draft.provider)) body.model = model

  const keys: Partial<Record<AiProvider, string | null>> = {}
  for (const provider of AI_PROVIDERS) {
    const typed = draft.keys[provider].trim()
    if (typed !== '') keys[provider] = typed
    else if (draft.clearKeys[provider] && hasDbKey(settings.providers[provider].key)) keys[provider] = null
  }
  if (Object.keys(keys).length > 0) body.keys = keys
  return body
}

/** Unsaved changes: an invalid draft always counts; a valid one when its PATCH body isn't empty. */
export function isAiDraftDirty(draft: AiDraft | undefined, settings: AiSettingsResponse | undefined): boolean {
  if (!draft || !settings) return false
  if (hasAiDraftErrors(validateAiDraft(draft))) return true
  return Object.keys(aiSettingsPatch(draft, settings)).length > 0
}

/** "Test connection" body: the draft's provider/model/typed key where they differ from the saved config. */
export function aiTestBody(draft: AiDraft, settings: AiSettingsResponse): TestAiConnectionBody {
  const body: TestAiConnectionBody = {}
  if (draft.provider !== settings.provider) body.provider = draft.provider
  const model = draft.model.trim()
  if (model !== '' && model !== effectiveModel(settings, draft.provider)) body.model = model
  const key = draft.keys[draft.provider].trim()
  if (key !== '') body.apiKey = key
  return body
}

/** The draft can be tested: valid model and a valid (or no) typed key for the draft's provider. */
export function canTestAiDraft(draft: AiDraft): boolean {
  const errors = validateAiDraft(draft)
  return errors.model === undefined && errors.keys[draft.provider] === undefined
}

// ---------------------------------------------------------------------------------------------
// Audit formatting

/** Shown for a `null` provider/model: no DB value, the `.env` value or the default applies. */
export const AI_AUDIT_FALLBACK = '.env / default'

function keyProvider(field: string): AiProvider | undefined {
  if (!field.startsWith('key.')) return undefined
  const provider = field.slice(4)
  return (AI_PROVIDERS as readonly string[]).includes(provider) ? (provider as AiProvider) : undefined
}

export function aiAuditFieldLabel(field: string): string {
  if (field === 'provider') return 'Provider'
  if (field === 'model') return 'Model'
  const provider = keyProvider(field)
  // A field added to the backend later still shows up, just not prettified.
  return provider ? `${aiProviderLabels[provider]} API key` : field
}

export function formatAiAuditValue(field: string, value: string | null): string {
  if (keyProvider(field)) {
    if (value === 'set') return 'Set'
    if (value === 'cleared') return 'Cleared'
    return value === null ? 'Not set' : value
  }
  if (value === null) return AI_AUDIT_FALLBACK
  if (field === 'provider' && (AI_PROVIDERS as readonly string[]).includes(value))
    return aiProviderLabels[value as AiProvider]
  return value
}
