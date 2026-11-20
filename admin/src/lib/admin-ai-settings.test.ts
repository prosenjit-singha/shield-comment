import { describe, expect, it } from 'vitest'
import {
  AI_ERROR_KINDS,
  type AiDraft,
  type AiProviderStatus,
  type AiSettingsResponse,
  aiAuditFieldLabel,
  aiAuditParams,
  aiAuditQueryOptions,
  aiErrorKindMessage,
  aiErrorKindMessages,
  aiSettingsPatch,
  aiSettingsQueryOptions,
  aiTestBody,
  draftFromAiSettings,
  formatAiAuditValue,
  isAiDraftDirty,
  keyStatusText,
  type NeonModel,
  neonModelLabel,
  neonModelOptions,
  validateAiKey,
} from './admin-ai-settings'

function status(defaultModel: string, patch: Partial<AiProviderStatus> = {}): AiProviderStatus {
  return {
    defaultModel,
    model: defaultModel,
    modelSource: 'default',
    baseUrlConfigured: true,
    key: { configured: false, source: 'none', last4: null, unreadable: false, updatedAt: null },
    ...patch,
  }
}

/** Same facts as the backend's `NEON_MODEL_CATALOG` (M5-T15b) + one model without an output price. */
const catalog: NeonModel[] = [
  { code: 'gemini-4-carbon', name: 'Gemini 4 Carbon', lab: 'Google', inputs: ['text', 'image', 'video', 'audio', 'file'], contextWindow: 1_048_576, inputUsdPer1M: 0, outputUsdPer1M: 0, free: true, dialect: 'chat' },
  { code: 'typesafeai-jev-1-14-0', name: 'Jev 1.14', lab: 'TypeSafe AI', inputs: ['text', 'image'], contextWindow: 65_536, inputUsdPer1M: 0.042, outputUsdPer1M: 0, free: false, dialect: 'systemone' },
  { code: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', lab: 'Anthropic', inputs: ['text', 'image', 'file'], contextWindow: 200_000, inputUsdPer1M: 0.1, outputUsdPer1M: 0.5, free: false, dialect: 'chat' },
  { code: 'gpt-oss-20b', name: 'GPT OSS 20B', lab: 'OpenAI', inputs: ['text'], contextWindow: 131_072, inputUsdPer1M: 0.07, outputUsdPer1M: null, free: false, dialect: 'chat' },
]

/** Neon active from the DB (jev), a Neon DB key. */
const settings: AiSettingsResponse = {
  provider: 'neon',
  providerSource: 'db',
  model: 'typesafeai-jev-1-14-0',
  modelSource: 'db',
  textImageModel: 'claude-haiku-5-5',
  textImageModelSource: 'default',
  textImageEnabled: false,
  catalog,
  configured: true,
  cipherConfigured: true,
  providers: {
    neon: status('typesafeai-jev-1-14-0', {
      model: 'typesafeai-jev-1-14-0',
      modelSource: 'db',
      key: { configured: true, source: 'db', last4: '1234', unreadable: false, updatedAt: '2026-11-19T04:00:00.000Z' },
    }),
    openai: status('gpt-4.1-mini'),
    anthropic: status('claude-haiku-4-5', {
      key: { configured: true, source: 'env', last4: '9876', unreadable: false, updatedAt: null },
    }),
    google: status('gemini-2.5-flash-lite'),
  },
  updatedAt: null,
  updatedBy: null,
}

/** OpenAI saved as the provider; Neon would use its env model. */
const direct: AiSettingsResponse = {
  ...settings,
  provider: 'openai',
  model: 'gpt-4.1-mini',
  providers: { ...settings.providers, neon: status('typesafeai-jev-1-14-0', { model: 'gpt-oss-20b', modelSource: 'env' }) },
}

const pristine = (s: AiSettingsResponse = settings): AiDraft => draftFromAiSettings(s)
const KEY = 'sk-test-abcdefgh1234'

describe('model options', () => {
  it('labels name, lab, price per 1M (Free, n/a) and context window (66K, 1M)', () => {
    expect(catalog.map(neonModelLabel)).toEqual([
      'Gemini 4 Carbon · Google · Free · 1M context',
      'Jev 1.14 · TypeSafe AI · in $0.042 / out $0.00 per 1M · 66K context',
      'Claude Haiku 5.5 · Anthropic · in $0.10 / out $0.50 per 1M · 200K context',
      'GPT OSS 20B · OpenAI · in $0.07 / out n/a per 1M · 131K context',
    ])
  })

  it('Text + Image lists only image-capable models', () => {
    expect(neonModelOptions(catalog, 'typesafeai-jev-1-14-0').map((o) => o.value)).toEqual(catalog.map((m) => m.code))
    expect(neonModelOptions(catalog, 'claude-haiku-5-5', true).map((o) => o.value)).toEqual([
      'gemini-4-carbon',
      'typesafeai-jev-1-14-0',
      'claude-haiku-5-5',
    ])
  })

  it('keeps a saved value that is outside the list', () => {
    expect(neonModelOptions(catalog, 'gpt-oss-20b', true).at(-1)).toEqual({ value: 'gpt-oss-20b', label: 'gpt-oss-20b · not in the list' })
  })
})

describe('validateAiKey', () => {
  it('applies the backend key rule (8–500 printable, no spaces, trimmed); empty = unchanged', () => {
    expect(validateAiKey('')).toBeUndefined()
    expect(validateAiKey(` ${KEY} `)).toBeUndefined()
    expect(validateAiKey('x'.repeat(8))).toBeUndefined()
    expect(validateAiKey('x'.repeat(500))).toBeUndefined()
    expect(validateAiKey('x'.repeat(7))).toBe('A key is 8–500 characters.')
    expect(validateAiKey('x'.repeat(501))).toBe('A key is 8–500 characters.')
    expect(validateAiKey('sk-test abcdefgh')).toBe('Use printable characters without spaces.')
  })
})

describe('aiSettingsPatch', () => {
  it('is empty for the pristine draft (Neon saved) and whitespace-only keys', () => {
    expect(aiSettingsPatch(pristine(), settings)).toEqual({})
    expect(aiSettingsPatch({ ...pristine(), key: '   ' }, settings)).toEqual({})
  })

  it('sends provider neon with every change', () => {
    const draft: AiDraft = { ...pristine(), model: 'gpt-oss-20b', textImageModel: 'gemini-4-carbon', textImageEnabled: true, key: ` ${KEY} ` }
    expect(aiSettingsPatch(draft, settings)).toEqual({
      provider: 'neon',
      model: 'gpt-oss-20b',
      textImageModel: 'gemini-4-carbon',
      textImageEnabled: true,
      keys: { neon: KEY },
    })
  })

  it('a saved direct provider: the pristine draft switches to Neon with its own model', () => {
    expect(pristine(direct).model).toBe('gpt-oss-20b')
    expect(aiSettingsPatch(pristine(direct), direct)).toEqual({ provider: 'neon' })
    expect(aiSettingsPatch({ ...pristine(direct), model: 'claude-haiku-5-5' }, direct)).toEqual({ provider: 'neon', model: 'claude-haiku-5-5' })
  })

  it('a confirmed clear of the DB key is null; a typed key wins; no DB key = nothing to clear', () => {
    expect(aiSettingsPatch({ ...pristine(), clearKey: true }, settings)).toEqual({ provider: 'neon', keys: { neon: null } })
    expect(aiSettingsPatch({ ...pristine(), clearKey: true, key: KEY }, settings)).toEqual({ provider: 'neon', keys: { neon: KEY } })
    expect(aiSettingsPatch({ ...pristine(direct), clearKey: true }, direct)).toEqual({ provider: 'neon' })
  })
})

describe('isAiDraftDirty', () => {
  it('false without a draft or settings, or for an unchanged draft (even with a direct provider saved)', () => {
    expect(isAiDraftDirty(undefined, settings)).toBe(false)
    expect(isAiDraftDirty(pristine(), undefined)).toBe(false)
    expect(isAiDraftDirty(pristine(), settings)).toBe(false)
    expect(isAiDraftDirty(pristine(direct), direct)).toBe(false)
  })

  it('true for a model, the switch, a typed key, a clear or an invalid key', () => {
    expect(isAiDraftDirty({ ...pristine(), model: 'gpt-oss-20b' }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), textImageModel: 'gemini-4-carbon' }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), textImageEnabled: true }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), key: KEY }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), clearKey: true }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), key: 'short' }, settings)).toBe(true)
  })
})

describe('aiTestBody', () => {
  it('tests the saved config with {}', () => {
    expect(aiTestBody(pristine(), settings)).toEqual({})
  })

  it('sends Neon when a direct provider is saved, a differing Text model and the typed key', () => {
    expect(aiTestBody(pristine(direct), direct)).toEqual({ provider: 'neon' })
    expect(aiTestBody({ ...pristine(), model: 'gemini-4-carbon', key: ` ${KEY}`, textImageEnabled: true }, settings)).toEqual({
      model: 'gemini-4-carbon',
      apiKey: KEY,
    })
  })
})

describe('labels and messages', () => {
  it('has a message for every AiErrorKind and a fallback for unknown kinds', () => {
    for (const kind of AI_ERROR_KINDS) expect(aiErrorKindMessages[kind]).toMatch(/\.$/)
    expect(aiErrorKindMessage('not_configured')).toContain('no API key')
    expect(aiErrorKindMessage('payment_required')).toContain('credits')
    expect(aiErrorKindMessage('auth')).toContain('rejected')
    expect(aiErrorKindMessage('quota_melted')).toBe('Connection failed (quota_melted).')
  })

  it('masks key status as last4 + source', () => {
    expect(keyStatusText(settings.providers.neon.key)).toBe('Saved ••••1234 · database')
    expect(keyStatusText(settings.providers.anthropic.key)).toBe('Saved ••••9876 · .env')
    expect(keyStatusText(settings.providers.openai.key)).toBe('Not set')
    expect(keyStatusText({ ...settings.providers.anthropic.key, last4: null })).toBe('Saved · .env')
  })
})

describe('audit formatting', () => {
  it('labels fields', () => {
    expect(aiAuditFieldLabel('provider')).toBe('Provider')
    expect(aiAuditFieldLabel('model')).toBe('Text model')
    expect(aiAuditFieldLabel('text_image_model')).toBe('Text + Image model')
    expect(aiAuditFieldLabel('text_image_enabled')).toBe('Text + Image switch')
    expect(aiAuditFieldLabel('key.neon')).toBe('Neon AI gateway API key')
    expect(aiAuditFieldLabel('key.google')).toBe('Google API key')
    expect(aiAuditFieldLabel('key.mistral')).toBe('key.mistral')
    expect(aiAuditFieldLabel('baseUrl')).toBe('baseUrl')
  })

  it('formats values: null provider/model = .env / default, keys only set/cleared', () => {
    expect(formatAiAuditValue('provider', null)).toBe('.env / default')
    expect(formatAiAuditValue('provider', 'anthropic')).toBe('Anthropic')
    expect(formatAiAuditValue('model', null)).toBe('.env / default')
    expect(formatAiAuditValue('model', 'gpt-4.1-mini')).toBe('gpt-4.1-mini')
    expect(formatAiAuditValue('key.openai', null)).toBe('Not set')
    expect(formatAiAuditValue('key.openai', 'set')).toBe('Set')
    expect(formatAiAuditValue('key.openai', 'cleared')).toBe('Cleared')
    expect(formatAiAuditValue('text_image_model', null)).toBe('default')
    expect(formatAiAuditValue('text_image_model', 'gemini-4-carbon')).toBe('gemini-4-carbon')
    expect(formatAiAuditValue('text_image_enabled', 'true')).toBe('On')
    expect(formatAiAuditValue('text_image_enabled', 'false')).toBe('Off')
  })
})

describe('queries', () => {
  it('keys live under [admin, ai-settings]', () => {
    expect(aiSettingsQueryOptions().queryKey).toEqual(['admin', 'ai-settings', 'settings'])
    expect(aiAuditQueryOptions(3).queryKey).toEqual(['admin', 'ai-settings', 'audit', { skip: 40, take: 20 }])
    expect(Object.fromEntries(aiAuditParams(1))).toEqual({ skip: '0', take: '20' })
    expect(Object.fromEntries(aiAuditParams(0))).toEqual({ skip: '0', take: '20' })
  })
})
