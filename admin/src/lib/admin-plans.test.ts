import { describe, expect, it } from 'vitest'
import {
  type AdminPlan,
  draftFromPlan,
  formatCount,
  formatPlanPrice,
  hasDraftErrors,
  isDraftDirty,
  PLAN_LIMIT_KEYS,
  parseWholeNumber,
  planLimitLabels,
  type PlanDraft,
  planPatch,
  replacePlanInList,
  textOrNull,
  validatePlanDraft,
  yearlyBilledHint,
  yearlyChargeBdt,
} from './admin-plans'

// A plain Starter fixture (no card text, not highlighted, no yearly option).
const starter: AdminPlan = {
  id: '019a0000-0000-7000-8000-000000000002',
  slug: 'starter',
  name: 'Starter',
  sortOrder: 1,
  isActive: true,
  monthlyPriceBdt: 499,
  badgeEn: null,
  badgeBn: null,
  descriptionEn: null,
  descriptionBn: null,
  isHighlighted: false,
  yearlyMonthlyPriceBdt: null,
  featureConfig: {
    limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1, workspaces: 1 },
    features: {
      banglaAiFilter: true,
      autoHideScams: true,
      customBlocklist: false,
      autoReplyTemplates: false,
      messengerAlerts: false,
      whiteLabelReports: false,
      prioritySupportApi: false,
    },
  },
  createdAt: '2026-11-18T00:00:00.000Z',
  updatedAt: '2026-11-18T00:00:00.000Z',
}

function draft(patch: Partial<PlanDraft> = {}, plan: AdminPlan = starter): PlanDraft {
  return { ...draftFromPlan(plan), ...patch }
}

describe('draftFromPlan', () => {
  it('turns numbers into strings and null text into empty strings (legacy offer/trial fields ignored)', () => {
    expect(draftFromPlan(starter)).toEqual({
      monthlyPriceBdt: '499',
      yearlyMonthlyPriceBdt: '',
      badgeEn: '',
      badgeBn: '',
      descriptionEn: '',
      descriptionBn: '',
      isHighlighted: false,
      limits: { connectedPages: '1', monthlyComments: '2500', teamSeats: '1', workspaces: '1' },
      features: starter.featureConfig.features,
    })
    const card = draftFromPlan({ ...starter, badgeEn: 'Popular', descriptionBn: 'ছোট দোকান', isHighlighted: true })
    expect([card.badgeEn, card.descriptionBn, card.isHighlighted]).toEqual(['Popular', 'ছোট দোকান', true])
  })

  it('copies the feature flags (editing the draft never mutates the plan)', () => {
    const d = draftFromPlan(starter)
    d.features.customBlocklist = true
    expect(starter.featureConfig.features.customBlocklist).toBe(false)
  })
})

describe('parseWholeNumber', () => {
  it.each([
    ['0', 0],
    ['1499', 1499],
    [' 42 ', 42],
    ['0499', 499],
  ])('%j → %j', (input, expected) => expect(parseWholeNumber(input)).toBe(expected))

  it.each(['', ' ', '1.5', '-1', '+1', '1e3', '1,499', 'abc', '99999999999999999999'])('%j → null', (input) =>
    expect(parseWholeNumber(input)).toBeNull(),
  )
})

describe('validatePlanDraft', () => {
  it('accepts the stored plan as it is', () => {
    expect(hasDraftErrors(validatePlanDraft(draft()))).toBe(false)
  })

  it('requires a whole original price within 0–1,000,000', () => {
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '' })).monthlyPriceBdt).toBe('Enter a price.')
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '49.5' })).monthlyPriceBdt).toBe('Use a whole number (digits only).')
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '-1' })).monthlyPriceBdt).toBe('Use a whole number (digits only).')
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '1000001' })).monthlyPriceBdt).toBe(
      `Must be ${formatCount(1_000_000)} or less.`,
    )
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '1000000' })).monthlyPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '0' })).monthlyPriceBdt).toBeUndefined()
  })

  it('limits the trimmed badges to 24 and descriptions to 160 characters', () => {
    for (const key of ['badgeEn', 'badgeBn'] as const) {
      expect(validatePlanDraft(draft({ [key]: `  ${'x'.repeat(24)}  ` }))[key]).toBeUndefined()
      expect(validatePlanDraft(draft({ [key]: 'x'.repeat(25) }))[key]).toBe('Up to 24 characters.')
    }
    for (const key of ['descriptionEn', 'descriptionBn'] as const) {
      expect(validatePlanDraft(draft({ [key]: 'ক'.repeat(160) }))[key]).toBeUndefined()
      expect(validatePlanDraft(draft({ [key]: 'ক'.repeat(161) }))[key]).toBe('Up to 160 characters.')
    }
    expect(hasDraftErrors(validatePlanDraft(draft({ descriptionBn: 'x'.repeat(161) })))).toBe(true)
  })

  it('checks each limit against its own maximum', () => {
    const errors = validatePlanDraft(
      draft({ limits: { connectedPages: '1001', monthlyComments: '10000000', teamSeats: 'two', workspaces: '1001' } }),
    )
    expect(errors.limits).toEqual({
      connectedPages: `Must be ${formatCount(1000)} or less.`,
      teamSeats: 'Use a whole number (digits only).',
      workspaces: `Must be ${formatCount(1000)} or less.`,
    })
    expect(validatePlanDraft(draft({ limits: { connectedPages: '', monthlyComments: '1', teamSeats: '1', workspaces: '1' } })).limits)
      .toEqual({ connectedPages: 'Enter a limit.' })
    expect(hasDraftErrors({ limits: { teamSeats: 'x' } })).toBe(true)
  })
})

describe('yearly price (PW-T7)', () => {
  it('maps a stored yearly price to the input and back', () => {
    expect(draftFromPlan({ ...starter, yearlyMonthlyPriceBdt: 449 }).yearlyMonthlyPriceBdt).toBe('449')
  })

  it('checks the yearly per-month price against the monthly list price', () => {
    expect(validatePlanDraft(draft({ yearlyMonthlyPriceBdt: '' })).yearlyMonthlyPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ yearlyMonthlyPriceBdt: '499' })).yearlyMonthlyPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ yearlyMonthlyPriceBdt: '500' })).yearlyMonthlyPriceBdt).toBe(
      "Can't be more than the monthly price (৳499).",
    )
    expect(validatePlanDraft(draft({ yearlyMonthlyPriceBdt: '4.5' })).yearlyMonthlyPriceBdt).toBe(
      'Use a whole number (digits only).',
    )
    // An invalid monthly price flags only that field.
    expect(validatePlanDraft(draft({ monthlyPriceBdt: '', yearlyMonthlyPriceBdt: '100' })).yearlyMonthlyPriceBdt).toBeUndefined()
    expect(hasDraftErrors(validatePlanDraft(draft({ yearlyMonthlyPriceBdt: '500' })))).toBe(true)
  })

  it('sends null for a cleared yearly price', () => {
    const stored = { ...starter, yearlyMonthlyPriceBdt: 449 }
    expect(planPatch(stored, draft({}, stored))).toEqual({})
    expect(planPatch(stored, draft({ yearlyMonthlyPriceBdt: '' }, stored))).toEqual({ yearlyMonthlyPriceBdt: null })
    expect(planPatch(starter, draft({ yearlyMonthlyPriceBdt: '0449' }))).toEqual({ yearlyMonthlyPriceBdt: 449 })
  })

  it('hints the yearly charge (per-month × 12)', () => {
    expect(yearlyChargeBdt(449)).toBe(5388)
    expect(yearlyBilledHint(draft({ yearlyMonthlyPriceBdt: '449' }))).toBe('Billed ৳5,388 yearly.')
    expect(yearlyBilledHint(draft({ yearlyMonthlyPriceBdt: '3599' }))).toBe(`Billed ৳${formatCount(43_188)} yearly.`)
    expect(yearlyBilledHint(draft({ yearlyMonthlyPriceBdt: '' }))).toBeNull()
    expect(yearlyBilledHint(draft({ yearlyMonthlyPriceBdt: 'x' }))).toBeNull()
  })
})

describe('planLimitLabels (PW-T1b)', () => {
  it('labels the renamed comment limit and the new workspace limit', () => {
    expect(PLAN_LIMIT_KEYS).toEqual(['connectedPages', 'monthlyComments', 'teamSeats', 'workspaces'])
    expect(planLimitLabels.monthlyComments).toBe('Monthly comments')
    expect(planLimitLabels.workspaces).toBe('Workspaces')
  })
})

describe('planPatch (minimal PATCH body)', () => {
  it('is empty when nothing changed, including equivalent spellings', () => {
    expect(planPatch(starter, draft())).toEqual({})
    expect(planPatch(starter, draft({ monthlyPriceBdt: ' 0499 ', badgeEn: '   ', descriptionBn: '\n' }))).toEqual({})
  })

  it('sends only the changed top-level fields, text trimmed', () => {
    expect(
      planPatch(
        starter,
        draft({ monthlyPriceBdt: '999', badgeEn: ' Popular ', descriptionBn: ' ছোট দোকানের জন্য ', isHighlighted: true }),
      ),
    ).toEqual({ monthlyPriceBdt: 999, badgeEn: 'Popular', descriptionBn: 'ছোট দোকানের জন্য', isHighlighted: true })
  })

  it('sends null to clear card text and false to un-highlight', () => {
    const card = { ...starter, badgeEn: 'Popular', badgeBn: 'জনপ্রিয়', descriptionEn: 'For shops', isHighlighted: true }
    expect(planPatch(card, draft({ badgeEn: ' ', badgeBn: '', descriptionEn: '', isHighlighted: false }, card))).toEqual({
      badgeEn: null,
      badgeBn: null,
      descriptionEn: null,
      isHighlighted: false,
    })
    expect(textOrNull('  a b ')).toBe('a b')
    expect(textOrNull(' \t ')).toBeNull()
  })

  it('sends only the changed limits and features, omitting empty groups', () => {
    const d = draft()
    expect(planPatch(starter, { ...d, limits: { ...d.limits, teamSeats: '2' } })).toEqual({
      featureConfig: { limits: { teamSeats: 2 } },
    })
    expect(planPatch(starter, { ...d, features: { ...d.features, customBlocklist: true } })).toEqual({
      featureConfig: { features: { customBlocklist: true } },
    })
    expect(
      planPatch(starter, {
        ...d,
        limits: { ...d.limits, monthlyComments: '3000' },
        features: { ...d.features, autoHideScams: false },
      }),
    ).toEqual({ featureConfig: { limits: { monthlyComments: 3000 }, features: { autoHideScams: false } } })
  })
})

describe('isDraftDirty', () => {
  it('is false without a draft or for an unchanged one', () => {
    expect(isDraftDirty(starter, undefined)).toBe(false)
    expect(isDraftDirty(starter, draft())).toBe(false)
    expect(isDraftDirty(starter, draft({ monthlyPriceBdt: '0499' }))).toBe(false)
  })

  it('is true for a change and for any invalid draft', () => {
    expect(isDraftDirty(starter, draft({ monthlyPriceBdt: '599' }))).toBe(true)
    expect(isDraftDirty(starter, draft({ monthlyPriceBdt: '' }))).toBe(true)
  })
})

describe('replacePlanInList', () => {
  it('swaps the saved plan in place and leaves an empty cache alone', () => {
    const other = { ...starter, id: 'other', slug: 'growth', name: 'Growth' }
    const saved = { ...starter, monthlyPriceBdt: 599 }
    expect(replacePlanInList({ items: [starter, other] }, saved)).toEqual({ items: [saved, other] })
    expect(replacePlanInList(undefined, saved)).toBeUndefined()
  })
})

describe('formatters', () => {
  it('formats taka with en-BD grouping', () => {
    expect(formatPlanPrice(0)).toBe('৳0')
    expect(formatPlanPrice(499)).toBe('৳499')
    expect(formatPlanPrice(1499)).toBe('৳1,499')
    expect(formatPlanPrice(1_000_000)).toBe(`৳${new Intl.NumberFormat('en-BD').format(1_000_000)}`)
  })
})
