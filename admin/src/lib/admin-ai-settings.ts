import { keepPreviousData, queryOptions } from '@tanstack/react-query'
import { formatUsd } from '@/lib/admin-system'
import { apiFetch } from '@/lib/api'

/**
 * A7 "AI provider" section (M5-T3 API, M5-T4 screen, decision D16). Mirrors the backend's
 * `src/admin/dto/ai-settings.dto.ts`, `AiConnectionTestResult` and `AiErrorKind`.
 *
 * - `GET /api/admin/settings/ai` → `AiSettingsResponse` (never a key: only `last4`).
 * - `PATCH /api/admin/settings/ai` `{ provider?, model?, textImageModel?, textImageEnabled?, keys?: { <p>: key | null } }`
 *   → same shape. 400 = invalid / nothing to update (`UNKNOWN_AI_MODEL`, `MODEL_NOT_IMAGE_CAPABLE` with
 *   provider neon); 503 `KEY_ENCRYPTION_NOT_CONFIGURED` = key save without cipher.
 * - `POST /api/admin/settings/ai/test` `{ provider?, model?, apiKey? }` (a draft over the saved
 *   config, never saved) → `AiConnectionTestResult`.
 * - `GET /api/admin/settings/ai/audit?skip&take` → `{ items, total, skip, take }`, newest first.
 *
 * The card shows the Neon AI gateway only (M5-T15c, D17): a Text model and a Text + Image model
 * (+ its switch, D22/D23) from `catalog`; the API keeps the direct providers.
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

export const NEON_MODEL_INPUTS = ['text', 'image', 'video', 'audio', 'file'] as const
export type NeonModelInput = (typeof NEON_MODEL_INPUTS)[number]

/** Mirror of the backend's `NeonModel` (`src/ai-gateway/neon-model-catalog.ts`). */
export interface NeonModel {
  code: string
  name: string
  lab: string
  inputs: readonly NeonModelInput[]
  /** Tokens. */
  contextWindow: number
  /** USD per 1M tokens; `null` = not published (n/a). */
  inputUsdPer1M: number | null
  outputUsdPer1M: number | null
  /** The model page says "Free" (prices 0). */
  free: boolean
  dialect: 'chat' | 'systemone'
}

export interface AiSettingsResponse {
  provider: AiProvider
  providerSource: AiSettingSource
  /** Text model. */
  model: string
  modelSource: AiSettingSource
  /** Text + Image model (stored only; images are judged in a later update, D23). */
  textImageModel: string
  textImageModelSource: AiSettingSource
  textImageEnabled: boolean
  /** Neon AI gateway models for the dropdowns. */
  catalog: readonly NeonModel[]
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
  textImageModel?: string | null
  textImageEnabled?: boolean
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

export type AiSettingsAuditField = 'provider' | 'model' | 'text_image_model' | 'text_image_enabled' | `key.${AiProvider}`

/**
 * One changed field. `provider`/`model`/`text_image_model`: DB values (`null` = `.env`/default
 * fallback); `text_image_enabled`: `true` | `false`;
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

/** Same as the backend: key 8–500 printable ASCII characters without spaces, trimmed. */
export const AI_KEY_MIN_LENGTH = 8
export const AI_KEY_MAX_LENGTH = 500
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
// Neon model dropdowns (M5-T15c, D17/D22): the admin shows the Neon AI gateway only.

const compactTokens = new Intl.NumberFormat('en-US', { notation: 'compact' })

/** `in $0.07 / out $0.30 per 1M` (`n/a` = not published), `Free`. */
export function neonPriceLabel(model: NeonModel): string {
  if (model.free) return 'Free'
  return `in ${formatUsd(model.inputUsdPer1M)} / out ${formatUsd(model.outputUsdPer1M)} per 1M`
}

/** `Jev 1.14 · TypeSafe AI · in $0.042 / out $0.00 per 1M · 66K context`. */
export function neonModelLabel(model: NeonModel): string {
  return `${model.name} · ${model.lab} · ${neonPriceLabel(model)} · ${compactTokens.format(model.contextWindow)} context`
}

export function supportsImages(model: NeonModel): boolean {
  return model.inputs.includes('image')
}

export interface ModelOption {
  value: string
  label: string
}

/**
 * Dropdown options from the API catalog (image-capable only for Text + Image). A saved value
 * outside that list (e.g. an `.env` model) stays selectable so the select shows the truth.
 */
export function neonModelOptions(catalog: readonly NeonModel[], current: string, imageOnly = false): ModelOption[] {
  const options = catalog
    .filter((m) => !imageOnly || supportsImages(m))
    .map((m) => ({ value: m.code, label: neonModelLabel(m) }))
  if (!options.some((o) => o.value === current)) options.push({ value: current, label: `${current} · not in the list` })
  return options
}

// ---------------------------------------------------------------------------------------------
// Draft. Only the Neon key can be typed; typed keys are write-only.

export interface AiDraft {
  /** Text model (catalog code). */
  model: string
  textImageModel: string
  textImageEnabled: boolean
  /** Typed (unsaved) Neon key; `''` = keep the saved one. */
  key: string
  /** Confirmed "Clear" of the Neon DB key, sent as `null` on save. */
  clearKey: boolean
}

/** The Text model Neon uses once it is (or becomes) the active provider. */
export function neonTextModel(settings: AiSettingsResponse): string {
  return settings.provider === 'neon' ? settings.model : settings.providers.neon.model
}

export function draftFromAiSettings(settings: AiSettingsResponse): AiDraft {
  return {
    model: neonTextModel(settings),
    textImageModel: settings.textImageModel,
    textImageEnabled: settings.textImageEnabled,
    key: '',
    clearKey: false,
  }
}

/** Same rule as the backend's key DTO (after trimming). An empty field is "unchanged". */
export function validateAiKey(key: string): string | undefined {
  const value = key.trim()
  if (value === '') return undefined
  if (value.length < AI_KEY_MIN_LENGTH || value.length > AI_KEY_MAX_LENGTH)
    return `A key is ${AI_KEY_MIN_LENGTH}–${AI_KEY_MAX_LENGTH} characters.`
  if (!AI_KEY_PATTERN.test(value)) return 'Use printable characters without spaces.'
  return undefined
}

/**
 * Minimal `PATCH` body for a valid draft; `{}` = nothing to save. Every save sends
 * `provider: 'neon'`, so a saved direct provider (D17: hidden) can be switched with Save alone.
 * `model` is sent only when it differs from what the backend would pick for Neon.
 */
export function aiSettingsPatch(draft: AiDraft, settings: AiSettingsResponse): UpdateAiSettingsBody {
  const body: UpdateAiSettingsBody = {}
  if (draft.model !== neonTextModel(settings)) body.model = draft.model
  if (draft.textImageModel !== settings.textImageModel) body.textImageModel = draft.textImageModel
  if (draft.textImageEnabled !== settings.textImageEnabled) body.textImageEnabled = draft.textImageEnabled
  const key = draft.key.trim()
  if (key !== '') body.keys = { neon: key }
  else if (draft.clearKey && hasDbKey(settings.providers.neon.key)) body.keys = { neon: null }
  if (Object.keys(body).length === 0 && settings.provider === 'neon') return body
  return { provider: 'neon', ...body }
}

/**
 * Unsaved edits: an invalid key, or a PATCH with more than the provider (a saved direct provider
 * alone doesn't block leaving the page; the card says Save switches it).
 */
export function isAiDraftDirty(draft: AiDraft | undefined, settings: AiSettingsResponse | undefined): boolean {
  if (!draft || !settings) return false
  if (validateAiKey(draft.key) !== undefined) return true
  const { provider: _provider, ...changes } = aiSettingsPatch(draft, settings)
  return Object.keys(changes).length > 0
}

/** "Test connection" body: Neon + the draft's Text model / typed key where they differ from the saved config. */
export function aiTestBody(draft: AiDraft, settings: AiSettingsResponse): TestAiConnectionBody {
  const body: TestAiConnectionBody = {}
  if (settings.provider !== 'neon') body.provider = 'neon'
  if (draft.model !== neonTextModel(settings)) body.model = draft.model
  const key = draft.key.trim()
  if (key !== '') body.apiKey = key
  return body
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
  if (field === 'model') return 'Text model'
  if (field === 'text_image_model') return 'Text + Image model'
  if (field === 'text_image_enabled') return 'Text + Image switch'
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
  if (field === 'text_image_enabled') return value === 'true' ? 'On' : value === 'false' ? 'Off' : String(value)
  // The Text + Image model has no .env value: null = the built-in default.
  if (value === null) return field === 'text_image_model' ? 'default' : AI_AUDIT_FALLBACK
  if (field === 'provider' && (AI_PROVIDERS as readonly string[]).includes(value))
    return aiProviderLabels[value as AiProvider]
  return value
}
