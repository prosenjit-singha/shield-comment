import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { formatUsd } from '@/lib/admin-system'
import {
  analysisNote,
  commentPreview,
  decisionLabels,
  formatConfidence,
  formatTokenCount,
  formatTokenPair,
  topupAmountError,
  topupDateError,
  topupErrorMessage,
  topupNoteError,
} from './admin-ai'

describe('formatTokenCount (D25 context length)', () => {
  it.each([
    [null, 'n/a'],
    [0, '0'],
    [40, '40'],
    [400, '0.4k'],
    [1000, '1k'],
    [1234, '1.2k'],
    [9_949, '9.9k'],
    [9_950, '10k'],
    [12_345, '12k'],
    [999_400, '999k'],
    [999_600, '1M'],
    [1_500_000, '1.5M'],
  ])('%s → %s', (value, text) => {
    expect(formatTokenCount(value)).toBe(text)
  })

  it('pairs input and output', () => {
    expect(formatTokenPair(412, 96)).toBe('0.4k in / 96 out')
    expect(formatTokenPair(null, 120)).toBe('n/a in / 0.1k out')
    expect(formatTokenPair(null, null)).toBe('n/a')
  })
})

describe('decision, cost and notes', () => {
  it('labels the decisions as the user named them', () => {
    expect(decisionLabels).toEqual({ NONE: 'Allowed', HIDE: 'Hidden', DELETE: 'Deleted' })
  })

  it('shows an unknown cost as n/a and small costs with more decimals', () => {
    expect(formatUsd(null)).toBe('n/a')
    expect(formatUsd(0.000123)).toBe('$0.000123')
    expect(formatUsd(-3.5)).toBe('-$3.50')
  })

  it('formats confidence', () => {
    expect(formatConfidence(0.925)).toBe('93%')
  })

  it('notes failed actions and problem states', () => {
    expect(analysisNote({ actionState: 'SUCCEEDED', status: 'HIDDEN', statusReason: null })).toBeNull()
    expect(analysisNote({ actionState: 'FAILED', status: 'FAILED', statusReason: 'token_invalid' })).toBe(
      'Action failed · Failed: token invalid',
    )
    expect(analysisNote({ actionState: null, status: 'NEEDS_REVIEW', statusReason: 'below_threshold' })).toBe(
      'Needs review: below threshold',
    )
    expect(analysisNote({ actionState: 'PENDING', status: 'VISIBLE', statusReason: null })).toBe('Action pending')
    expect(analysisNote({ actionState: null, status: 'SKIPPED', statusReason: null })).toBe('Skipped')
  })

  it('truncates long comments only', () => {
    expect(commentPreview('short')).toBe('short')
    const long = 'আ'.repeat(100)
    expect(commentPreview(long)).toBe(`${'আ'.repeat(80)}…`)
  })
})

describe('top-up validation', () => {
  it('checks the amount', () => {
    expect(topupAmountError('25')).toBeNull()
    expect(topupAmountError('12.50')).toBeNull()
    expect(topupAmountError('1000000')).toBeNull()
    expect(topupAmountError('')).toMatch(/Enter/)
    expect(topupAmountError('0')).toMatch(/more than \$0/)
    expect(topupAmountError('0.00')).toMatch(/more than \$0/)
    expect(topupAmountError('-5')).toMatch(/at most 2 decimals/)
    expect(topupAmountError('1.234')).toMatch(/at most 2 decimals/)
    expect(topupAmountError('1e3')).toMatch(/at most 2 decimals/)
    expect(topupAmountError('1000000.01')).toMatch(/at most \$1,000,000/)
  })

  it('checks the date against today in Dhaka', () => {
    // 23:30 UTC on 17 Nov = 05:30 on 18 Nov in Dhaka.
    const now = new Date('2026-11-17T23:30:00Z')
    expect(topupDateError('2026-11-18', now)).toBeNull()
    expect(topupDateError('2026-11-19', now)).toMatch(/future/)
    expect(topupDateError('', now)).toMatch(/Pick/)
  })

  it('checks the note length after trimming', () => {
    expect(topupNoteError(`  ${'x'.repeat(200)}  `)).toBeNull()
    expect(topupNoteError('x'.repeat(201))).toMatch(/at most 200/)
  })

  it('maps API errors', () => {
    expect(topupErrorMessage(new ApiError(400, 'raw', 'TOPUP_DATE_IN_FUTURE'))).toMatch(/can’t be after today/)
    expect(topupErrorMessage(new ApiError(400, 'amountUsd must not be less than 0.01'))).toBe(
      'amountUsd must not be less than 0.01',
    )
  })
})
