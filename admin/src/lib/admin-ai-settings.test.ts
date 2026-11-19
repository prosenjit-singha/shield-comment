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
  canTestAiDraft,
  draftFromAiSettings,
  formatAiAuditValue,
  hasAiDraftErrors,
  isAiDraftDirty,
  keyStatusText,
  modelSuggestions,
  validateAiDraft,
  withProvider,
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

const settings: AiSettingsResponse = {
  provider: 'openai',
  providerSource: 'db',
  model: 'gpt-4.1-nano',
  modelSource: 'db',
  configured: true,
  cipherConfigured: true,
  providers: {
    neon: status('gpt-oss-20b', { baseUrlConfigured: false }),
    openai: status('gpt-4.1-mini', {
      model: 'gpt-4.1-nano',
      modelSource: 'db',
      key: { configured: true, source: 'db', last4: '1234', unreadable: false, updatedAt: '2026-11-19T04:00:00.000Z' },
    }),
    anthropic: status('claude-haiku-4-5', {
      model: 'claude-sonnet-4-5',
      modelSource: 'env',
      key: { configured: true, source: 'env', last4: '9876', unreadable: false, updatedAt: null },
    }),
    google: status('gemini-2.5-flash-lite', {
      key: { configured: false, source: 'none', last4: null, unreadable: true, updatedAt: '2026-11-18T00:00:00.000Z' },
    }),
  },
  updatedAt: null,
  updatedBy: null,
}

const pristine = (): AiDraft => draftFromAiSettings(settings)
const KEY = 'sk-test-abcdefgh1234'

describe('validateAiDraft', () => {
  it('accepts the saved settings and empty key fields', () => {
    expect(hasAiDraftErrors(validateAiDraft(pristine()))).toBe(false)
  })

  it('applies the backend model rule (1–100 printable, no spaces, trimmed)', () => {
    const check = (model: string) => validateAiDraft({ ...pristine(), model }).model
    expect(check('  gpt-4o-mini  ')).toBeUndefined()
    expect(check('models/gemini-2.5-flash')).toBeUndefined()
    expect(check('a'.repeat(100))).toBeUndefined()
    expect(check('')).toBe('Enter a model id.')
    expect(check('   ')).toBe('Enter a model id.')
    expect(check('a'.repeat(101))).toBe('Up to 100 characters.')
    expect(check('gpt 4')).toBe('Use printable characters without spaces.')
    expect(check('gpt-৪')).toBe('Use printable characters without spaces.')
  })

  it('applies the backend key rule (8–500 printable, no spaces, trimmed) per provider', () => {
    const check = (key: string) => validateAiDraft({ ...pristine(), keys: { ...pristine().keys, anthropic: key } }).keys
    expect(check(` ${KEY} `)).toEqual({})
    expect(check('x'.repeat(8))).toEqual({})
    expect(check('x'.repeat(500))).toEqual({})
    expect(check('x'.repeat(7))).toEqual({ anthropic: 'A key is 8–500 characters.' })
    expect(check('x'.repeat(501))).toEqual({ anthropic: 'A key is 8–500 characters.' })
    expect(check('sk-test abcdefgh')).toEqual({ anthropic: 'Use printable characters without spaces.' })
  })
})

describe('aiSettingsPatch', () => {
  it('is empty for the pristine draft and for whitespace-only edits', () => {
    expect(aiSettingsPatch(pristine(), settings)).toEqual({})
    expect(aiSettingsPatch({ ...pristine(), model: ' gpt-4.1-nano ', keys: { ...pristine().keys, neon: '   ' } }, settings)).toEqual({})
  })

  it('sends a changed model trimmed', () => {
    expect(aiSettingsPatch({ ...pristine(), model: ' gpt-4o-mini ' }, settings)).toEqual({ model: 'gpt-4o-mini' })
  })

  it("provider switch: only the provider when the model is that provider's own", () => {
    const draft = withProvider(pristine(), settings, 'anthropic')
    expect(draft.model).toBe('claude-sonnet-4-5')
    expect(aiSettingsPatch(draft, settings)).toEqual({ provider: 'anthropic' })
    expect(aiSettingsPatch({ ...draft, model: 'claude-haiku-4-5' }, settings)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
    })
  })

  it('switching back to the saved provider restores its model and sends nothing', () => {
    const back = withProvider(withProvider(pristine(), settings, 'google'), settings, 'openai')
    expect(back.model).toBe('gpt-4.1-nano')
    expect(aiSettingsPatch(back, settings)).toEqual({})
  })

  it('sends typed keys trimmed and confirmed clears of DB keys as null', () => {
    const draft: AiDraft = {
      ...pristine(),
      keys: { ...pristine().keys, anthropic: ` ${KEY} ` },
      clearKeys: { ...pristine().clearKeys, openai: true, google: true, neon: true },
    }
    // Neon has no DB key: nothing to clear. Google's DB key is unreadable but can be cleared.
    expect(aiSettingsPatch(draft, settings)).toEqual({ keys: { openai: null, anthropic: KEY, google: null } })
  })

  it('a typed key wins over a pending clear', () => {
    const draft: AiDraft = {
      ...pristine(),
      keys: { ...pristine().keys, openai: KEY },
      clearKeys: { ...pristine().clearKeys, openai: true },
    }
    expect(aiSettingsPatch(draft, settings)).toEqual({ keys: { openai: KEY } })
  })
})

describe('isAiDraftDirty', () => {
  it('false without a draft or settings, or for an unchanged draft', () => {
    expect(isAiDraftDirty(undefined, settings)).toBe(false)
    expect(isAiDraftDirty(pristine(), undefined)).toBe(false)
    expect(isAiDraftDirty(pristine(), settings)).toBe(false)
  })

  it('true for a typed key, a clear, a provider switch or an invalid draft', () => {
    expect(isAiDraftDirty({ ...pristine(), keys: { ...pristine().keys, google: KEY } }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), clearKeys: { ...pristine().clearKeys, openai: true } }, settings)).toBe(true)
    expect(isAiDraftDirty(withProvider(pristine(), settings, 'neon'), settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), keys: { ...pristine().keys, google: 'short' } }, settings)).toBe(true)
    expect(isAiDraftDirty({ ...pristine(), model: '' }, settings)).toBe(true)
  })
})

describe('aiTestBody / canTestAiDraft', () => {
  it('tests the saved config with {}', () => {
    expect(aiTestBody(pristine(), settings)).toEqual({})
  })

  it("sends the draft's provider, a differing model and the typed key of that provider only", () => {
    const draft: AiDraft = {
      ...withProvider(pristine(), settings, 'google'),
      model: 'gemini-2.5-flash',
      keys: { ...pristine().keys, google: KEY, openai: 'sk-other-key-0000' },
    }
    expect(aiTestBody(draft, settings)).toEqual({ provider: 'google', model: 'gemini-2.5-flash', apiKey: KEY })
    expect(aiTestBody({ ...pristine(), keys: { ...pristine().keys, openai: ` ${KEY}` } }, settings)).toEqual({ apiKey: KEY })
  })

  it('needs a valid model and a valid (or no) key for the tested provider', () => {
    expect(canTestAiDraft(pristine())).toBe(true)
    expect(canTestAiDraft({ ...pristine(), model: 'a b' })).toBe(false)
    expect(canTestAiDraft({ ...pristine(), keys: { ...pristine().keys, openai: 'short' } })).toBe(false)
    // Another provider's half-typed key doesn't block the test.
    expect(canTestAiDraft({ ...pristine(), keys: { ...pristine().keys, google: 'short' } })).toBe(true)
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
    expect(keyStatusText(settings.providers.openai.key)).toBe('Saved ••••1234 · database')
    expect(keyStatusText(settings.providers.anthropic.key)).toBe('Saved ••••9876 · .env')
    expect(keyStatusText(settings.providers.neon.key)).toBe('Not set')
    expect(keyStatusText({ ...settings.providers.anthropic.key, last4: null })).toBe('Saved · .env')
  })

  it('suggests the default model first without duplicates', () => {
    expect(modelSuggestions('openai', settings.providers.openai)).toEqual(['gpt-4.1-mini', 'gpt-4.1-nano', 'gpt-4o-mini'])
    expect(modelSuggestions('neon', status('new-default'))).toEqual(['new-default', 'gpt-oss-20b', 'gpt-oss-120b'])
  })
})

describe('audit formatting', () => {
  it('labels fields', () => {
    expect(aiAuditFieldLabel('provider')).toBe('Provider')
    expect(aiAuditFieldLabel('model')).toBe('Model')
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
