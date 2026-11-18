import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import {
  dataDeletionFailure,
  dataDeletionStatusPath,
  formatDhakaDateTime,
  lookupFromBody,
  parseDataDeletionStatus,
  toBanglaDigits,
  validateDataDeletionSearch,
} from '@/lib/data-deletion'

const CODE = 'Ab3_-xYz0123456789_-QW'

describe('validateDataDeletionSearch', () => {
  it('keeps a 22-character base64url code', () => {
    expect(CODE).toHaveLength(22)
    expect(validateDataDeletionSearch({ code: CODE })).toEqual({ code: CODE })
  })

  it.each([
    ['missing', {}],
    ['empty', { code: '' }],
    ['21 characters', { code: CODE.slice(1) }],
    ['23 characters', { code: `${CODE}a` }],
    ['padding', { code: `${CODE.slice(2)}==` }],
    ['standard base64 characters', { code: `${CODE.slice(2)}+/` }],
    ['a path', { code: `../${CODE.slice(3)}` }],
    ['spaces', { code: ` ${CODE.slice(1)}` }],
    ['a number (router JSON-parses search values)', { code: 1.2345678901234568e21 }],
    ['an array', { code: [CODE] }],
  ])('drops a malformed code: %s', (_name, search) => {
    expect(validateDataDeletionSearch(search)).toEqual({ code: undefined })
  })

  it('always returns the key, so the raw value cannot leak through the router merge', () => {
    expect(Object.keys(validateDataDeletionSearch({ code: 'bad' }))).toEqual(['code'])
  })
})

describe('dataDeletionStatusPath', () => {
  it('builds the backend path with the code URL-encoded', () => {
    expect(dataDeletionStatusPath(CODE)).toBe(`/api/meta/data-deletion/${CODE}`)
    expect(dataDeletionStatusPath('a/b?c')).toBe('/api/meta/data-deletion/a%2Fb%3Fc')
  })
})

describe('parseDataDeletionStatus / lookupFromBody', () => {
  const pending = { status: 'PENDING', requestedAt: '2026-11-19T04:05:00.000Z', completedAt: null }
  const completed = { status: 'COMPLETED', requestedAt: '2026-11-19T04:05:00.000Z', completedAt: '2026-11-19T04:06:00.000Z' }

  it('accepts both statuses', () => {
    expect(parseDataDeletionStatus(pending)).toEqual(pending)
    expect(parseDataDeletionStatus(completed)).toEqual(completed)
    expect(lookupFromBody(completed)).toEqual({ kind: 'found', request: completed })
  })

  it.each([
    ['null', null],
    ['a string', 'PENDING'],
    ['unknown status', { ...pending, status: 'FAILED' }],
    ['bad requestedAt', { ...pending, requestedAt: 'yesterday' }],
    ['missing completedAt', { status: 'PENDING', requestedAt: pending.requestedAt }],
    ['bad completedAt', { ...completed, completedAt: 5 }],
  ])('rejects %s', (_name, body) => {
    expect(parseDataDeletionStatus(body)).toBeNull()
    expect(() => lookupFromBody(body)).toThrow(expect.objectContaining({ status: 502 }))
  })
})

describe('dataDeletionFailure', () => {
  it('maps 429, network and the rest', () => {
    expect(dataDeletionFailure(new ApiError(429, 'Too Many Requests'))).toBe('rate-limited')
    expect(dataDeletionFailure(new ApiError(0, 'Network error'))).toBe('network')
    expect(dataDeletionFailure(new TypeError('boom'))).toBe('network')
    expect(dataDeletionFailure(new ApiError(500, 'oops'))).toBe('unavailable')
    expect(dataDeletionFailure(new ApiError(502, 'Unexpected response body'))).toBe('unavailable')
  })
})

describe('formatDhakaDateTime', () => {
  it('shows the Dhaka wall clock (UTC+6), also across midnight and the year end', () => {
    expect(formatDhakaDateTime('2026-11-19T09:05:00.000Z', 'en')).toBe('19 Nov 2026, 15:05 (Bangladesh time)')
    expect(formatDhakaDateTime('2026-12-31T18:30:00.000Z', 'en')).toBe('1 Jan 2027, 00:30 (Bangladesh time)')
  })

  it('uses Bangla month names and digits (no grouping) in bn', () => {
    expect(formatDhakaDateTime('2026-11-19T09:05:00.000Z', 'bn')).toBe('১৯ নভেম্বর ২০২৬, ১৫:০৫ (বাংলাদেশ সময়)')
  })

  it('returns an unparsable value unchanged', () => {
    expect(formatDhakaDateTime('soon', 'en')).toBe('soon')
  })

  it('toBanglaDigits converts digits only', () => {
    expect(toBanglaDigits('2026-11, 09:05')).toBe('২০২৬-১১, ০৯:০৫')
  })
})
