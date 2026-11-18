import { describe, expect, it } from 'vitest'
import { formatQueueTime, replyError, ticketListParams, validateTicketsSearch } from '@/lib/admin-tickets'

describe('validateTicketsSearch', () => {
  it('keeps valid params and drops malformed ones', () => {
    const id = '0199b000-0000-7000-8000-000000000001'
    expect(
      validateTicketsSearch({ status: 'IN_PROGRESS', priority: 'HIGH', category: 'OTHER', q: '  bkash ', page: '3', ticket: id }),
    ).toEqual({ status: 'IN_PROGRESS', priority: 'HIGH', category: 'OTHER', q: 'bkash', page: 3, ticket: id })
    expect(
      validateTicketsSearch({ status: 'CLOSED', priority: 'urgent', category: 'billing', q: '   ', page: 1, ticket: 'nope' }),
    ).toEqual({})
    expect(validateTicketsSearch({ q: 'x'.repeat(150) }).q).toHaveLength(100)
  })

  it('returns every key, undefined when missing (router merges raw search under the result)', () => {
    const search = validateTicketsSearch({})
    expect(Object.keys(search).sort()).toEqual(['category', 'page', 'priority', 'q', 'status', 'ticket'])
    expect(Object.values(search).every((v) => v === undefined)).toBe(true)
  })

  it.each([
    ['page', 'abc'],
    ['page', -1],
    ['page', 0],
    ['page', 1],
    ['page', 2.5],
    ['page', 'Infinity'],
    ['page', ''],
    ['page', null],
    ['status', 'BOGUS'],
    ['status', 'open'],
    ['status', 1],
    ['priority', 'URGENT'],
    ['category', ['BILLING']],
    ['q', '   '],
    ['q', { a: 1 }],
    ['ticket', 'not-a-uuid'],
    ['ticket', `${'0199b000-0000-7000-8000-000000000001'}x`],
    ['ticket', 42],
  ])('maps a malformed %s=%j to undefined (key kept)', (key, value) => {
    const search = validateTicketsSearch({ [key]: value })
    expect(search).toHaveProperty(key, undefined)
    expect(ticketListParams(search).toString()).toBe('skip=0&take=20')
  })

  it('reads a numeric ?q= (router JSON-parses the URL) as text', () => {
    expect(validateTicketsSearch({ q: 123 }).q).toBe('123')
    expect(validateTicketsSearch({ q: Number.NaN }).q).toBeUndefined()
  })
})

describe('ticketListParams', () => {
  it('maps filters and page to the API query; the open ticket is not a filter', () => {
    expect(
      ticketListParams({ status: 'OPEN', priority: 'LOW', q: 'meta', page: 2, ticket: 'x' }).toString(),
    ).toBe('status=OPEN&priority=LOW&q=meta&skip=20&take=20')
    expect(ticketListParams({}).toString()).toBe('skip=0&take=20')
  })
})

describe('replyError', () => {
  it('requires 1–5000 characters after trimming', () => {
    expect(replyError('  ')).toBe('Write a message first.')
    expect(replyError(` ${'x'.repeat(5000)} `)).toBeNull()
    expect(replyError('x'.repeat(5001))).toMatch(/5000/)
  })
})

describe('formatQueueTime', () => {
  const now = new Date('2026-11-18T10:00:00.000Z') // 4 pm in Dhaka
  it('shows the time for today, the day for this year, the full date before (Dhaka days)', () => {
    expect(formatQueueTime('2026-11-17T19:30:00.000Z', now)).toBe('1:30 am') // 18 Nov in Dhaka
    expect(formatQueueTime('2026-11-17T17:59:00.000Z', now)).toBe('17 Nov')
    expect(formatQueueTime('2025-12-31T12:00:00.000Z', now)).toBe('31 Dec 2025')
  })
})
