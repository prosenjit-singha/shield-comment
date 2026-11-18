import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { metaReturnNotices } from '@/lib/meta-messages'
import { META_OAUTH_ERROR_REASONS, pageToggleFailure, validateMetaReturnSearch } from '@/lib/meta-pages'

const en = (english: string) => english
const bn = (_: string, bangla: string) => bangla

describe('validateMetaReturnSearch', () => {
  it('keeps valid values', () => {
    expect(validateMetaReturnSearch({ meta: 'connected', skipped: 2 })).toEqual({
      meta: 'connected',
      reason: undefined,
      skipped: 2,
    })
    expect(validateMetaReturnSearch({ meta: 'error', reason: 'meta_unavailable' })).toEqual({
      meta: 'error',
      reason: 'meta_unavailable',
      skipped: undefined,
    })
    expect(validateMetaReturnSearch({ skipped: '3' }).skipped).toBe(3)
  })

  it('returns every key, undefined when invalid', () => {
    expect(validateMetaReturnSearch({ meta: 'nope', reason: 'toString', skipped: -1 })).toEqual({
      meta: undefined,
      reason: undefined,
      skipped: undefined,
    })
    for (const skipped of [0, 1.5, 'abc', '2e3', null, Number.MAX_VALUE]) {
      expect(validateMetaReturnSearch({ skipped }).skipped).toBeUndefined()
    }
  })
})

describe('metaReturnNotices', () => {
  it('has distinct en + bn copy for every backend reason', () => {
    for (const content of [en, bn]) {
      const texts = META_OAUTH_ERROR_REASONS.map((reason) => metaReturnNotices({ meta: 'error', reason }, content)[0]!.text)
      expect(new Set(texts).size).toBe(META_OAUTH_ERROR_REASONS.length)
    }
  })

  it('uses the singular for one skipped Page and Bangla digits', () => {
    expect(metaReturnNotices({ meta: 'connected', skipped: 1 }, en)[1]!.text).toMatch(/^1 Page was skipped because it is/)
    expect(metaReturnNotices({ meta: 'connected', skipped: 12 }, bn)[1]!.text).toMatch(/^১২টি পেজ/)
  })

  it('shows nothing without ?meta', () => {
    expect(metaReturnNotices({ reason: 'meta_error', skipped: 2 }, en)).toEqual([])
  })
})

describe('pageToggleFailure', () => {
  it('reads PAGE_LIMIT_REACHED details and PAGE_TOKEN_MISSING', () => {
    expect(
      pageToggleFailure(new ApiError(409, 'x', { code: 'PAGE_LIMIT_REACHED', details: { limit: 3, activeCount: 3 } })),
    ).toEqual({ kind: 'limit-reached', limit: 3, activeCount: 3 })
    expect(pageToggleFailure(new ApiError(409, 'x', { code: 'PAGE_LIMIT_REACHED', details: { limit: '3' } }))).toEqual({
      kind: 'limit-reached',
      limit: undefined,
      activeCount: undefined,
    })
    expect(pageToggleFailure(new ApiError(409, 'x', { code: 'PAGE_TOKEN_MISSING' }))).toEqual({ kind: 'token-missing' })
    const other = new ApiError(409, 'x', { code: 'SOMETHING_ELSE' })
    expect(pageToggleFailure(other)).toEqual({ kind: 'other', error: other })
  })
})
