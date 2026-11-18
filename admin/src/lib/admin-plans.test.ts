import { describe, expect, it } from 'vitest'
import {
  type AdminPlan,
  draftFromPlan,
  formatCount,
  formatPlanPrice,
  hasDraftErrors,
  isDraftDirty,
  offerDiscountPercent,
  parseWholeNumber,
  type PlanDraft,
  planPatch,
  pricePreview,
  replacePlanInList,
  validatePlanDraft,
} from './admin-plans'

// Starter as 0007 seeded it, before the 0008 launch offer (a plain, offer-free fixture).
const starter: AdminPlan = {
  id: '019a0000-0000-7000-8000-000000000002',
  slug: 'starter',
  name: 'Starter',
  sortOrder: 1,
  isActive: true,
  originalPriceBdt: 499,
  offerPriceBdt: null,
  offerBadge: null,
  featureConfig: {
    limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1 },
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
  it('turns numbers into strings and null offer/badge into empty strings', () => {
    expect(draftFromPlan(starter)).toEqual({
      originalPriceBdt: '499',
      offerPriceBdt: '',
      offerBadge: '',
      limits: { connectedPages: '1', monthlyComments: '2500', teamSeats: '1' },
      features: starter.featureConfig.features,
    })
    const promo = draftFromPlan({ ...starter, originalPriceBdt: 999, offerPriceBdt: 499, offerBadge: '50% Launch Offer' })
    expect([promo.originalPriceBdt, promo.offerPriceBdt, promo.offerBadge]).toEqual(['999', '499', '50% Launch Offer'])
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
    expect(validatePlanDraft(draft({ originalPriceBdt: '' })).originalPriceBdt).toBe('Enter a price.')
    expect(validatePlanDraft(draft({ originalPriceBdt: '49.5' })).originalPriceBdt).toBe('Use a whole number (digits only).')
    expect(validatePlanDraft(draft({ originalPriceBdt: '-1' })).originalPriceBdt).toBe('Use a whole number (digits only).')
    expect(validatePlanDraft(draft({ originalPriceBdt: '1000001' })).originalPriceBdt).toBe(
      `Must be ${formatCount(1_000_000)} or less.`,
    )
    expect(validatePlanDraft(draft({ originalPriceBdt: '1000000' })).originalPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ originalPriceBdt: '0' })).originalPriceBdt).toBeUndefined()
  })

  it('allows an empty offer and checks a set one against the original', () => {
    expect(validatePlanDraft(draft({ offerPriceBdt: '  ' })).offerPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ offerPriceBdt: '499' })).offerPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ offerPriceBdt: '0' })).offerPriceBdt).toBeUndefined()
    expect(validatePlanDraft(draft({ offerPriceBdt: '500' })).offerPriceBdt).toBe(
      "The offer can't be more than the original price.",
    )
    expect(validatePlanDraft(draft({ offerPriceBdt: '1.5' })).offerPriceBdt).toBe('Use a whole number (digits only).')
    expect(validatePlanDraft(draft({ offerPriceBdt: '2000000' })).offerPriceBdt).toBe(
      `Must be ${formatCount(1_000_000)} or less.`,
    )
    // With an invalid original only the original is flagged.
    expect(validatePlanDraft(draft({ originalPriceBdt: '', offerPriceBdt: '100' })).offerPriceBdt).toBeUndefined()
  })

  it('limits the trimmed badge to 40 characters', () => {
    expect(validatePlanDraft(draft({ offerBadge: `  ${'x'.repeat(40)}  ` })).offerBadge).toBeUndefined()
    expect(validatePlanDraft(draft({ offerBadge: 'x'.repeat(41) })).offerBadge).toBe('Up to 40 characters.')
  })

  it('checks each limit against its own maximum', () => {
    const errors = validatePlanDraft(
      draft({ limits: { connectedPages: '1001', monthlyComments: '10000000', teamSeats: 'two' } }),
    )
    expect(errors.limits).toEqual({
      connectedPages: `Must be ${formatCount(1000)} or less.`,
      teamSeats: 'Use a whole number (digits only).',
    })
    expect(validatePlanDraft(draft({ limits: { connectedPages: '', monthlyComments: '1', teamSeats: '1' } })).limits)
      .toEqual({ connectedPages: 'Enter a limit.' })
    expect(hasDraftErrors({ limits: { teamSeats: 'x' } })).toBe(true)
  })
})

describe('planPatch (minimal PATCH body)', () => {
  it('is empty when nothing changed, including equivalent spellings', () => {
    expect(planPatch(starter, draft())).toEqual({})
    expect(planPatch(starter, draft({ originalPriceBdt: ' 0499 ', offerBadge: '   ' }))).toEqual({})
  })

  it('sends only the changed top-level fields', () => {
    expect(planPatch(starter, draft({ originalPriceBdt: '999', offerPriceBdt: '499', offerBadge: ' 50% Launch Offer ' }))).toEqual({
      originalPriceBdt: 999,
      offerPriceBdt: 499,
      offerBadge: '50% Launch Offer',
    })
  })

  it('sends null to clear an offer and a badge', () => {
    const promo = { ...starter, originalPriceBdt: 999, offerPriceBdt: 499, offerBadge: 'Sale' }
    expect(planPatch(promo, draft({ offerPriceBdt: '', offerBadge: ' ' }, promo))).toEqual({
      offerPriceBdt: null,
      offerBadge: null,
    })
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
    expect(isDraftDirty(starter, draft({ originalPriceBdt: '0499' }))).toBe(false)
  })

  it('is true for a change and for any invalid draft', () => {
    expect(isDraftDirty(starter, draft({ originalPriceBdt: '599' }))).toBe(true)
    expect(isDraftDirty(starter, draft({ originalPriceBdt: '' }))).toBe(true)
  })
})

describe('replacePlanInList', () => {
  it('swaps the saved plan in place and leaves an empty cache alone', () => {
    const other = { ...starter, id: 'other', slug: 'growth', name: 'Growth' }
    const saved = { ...starter, originalPriceBdt: 599 }
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

  it('computes the whole-percent discount', () => {
    expect(offerDiscountPercent(999, 499)).toBe(50)
    expect(offerDiscountPercent(2499, 1499)).toBe(40)
    expect(offerDiscountPercent(5999, 3999)).toBe(33)
    expect(offerDiscountPercent(999, 0)).toBe(100)
    expect(offerDiscountPercent(999, null)).toBeNull()
    expect(offerDiscountPercent(999, 999)).toBeNull()
    expect(offerDiscountPercent(0, 0)).toBeNull()
  })

  it('previews the price, strikethrough and badge of a draft', () => {
    expect(pricePreview(draft())).toEqual({ price: 499, struck: null, badge: null, discountPercent: null })
    expect(pricePreview(draft({ originalPriceBdt: '999', offerPriceBdt: '499', offerBadge: ' 50% Launch Offer ' }))).toEqual({
      price: 499,
      struck: 999,
      badge: '50% Launch Offer',
      discountPercent: 50,
    })
    // An offer equal to the original is not a discount: nothing struck through.
    expect(pricePreview(draft({ offerPriceBdt: '499' }))).toEqual({ price: 499, struck: null, badge: null, discountPercent: null })
    expect(pricePreview(draft({ offerPriceBdt: '600' })).price).toBeNull()
    expect(pricePreview(draft({ originalPriceBdt: 'x', offerBadge: 'Hot' }))).toEqual({
      price: null,
      struck: null,
      badge: 'Hot',
      discountPercent: null,
    })
  })

  it('previews the seeded launch offers (0008) from the stored plans', () => {
    const seeded = (originalPriceBdt: number, offerPriceBdt: number | null, offerBadge: string | null) =>
      pricePreview(draftFromPlan({ ...starter, originalPriceBdt, offerPriceBdt, offerBadge }))
    expect(seeded(0, null, null)).toEqual({ price: 0, struck: null, badge: null, discountPercent: null })
    expect(seeded(999, 499, '50% Launch Offer')).toEqual({
      price: 499,
      struck: 999,
      badge: '50% Launch Offer',
      discountPercent: 50,
    })
    expect(seeded(2499, 1499, '40% Off')).toEqual({ price: 1499, struck: 2499, badge: '40% Off', discountPercent: 40 })
    expect(seeded(5999, 3999, '33% Off')).toEqual({ price: 3999, struck: 5999, badge: '33% Off', discountPercent: 33 })
  })
})
