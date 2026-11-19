import { describe, expect, it } from 'vitest'
import {
  formatPlanAuditValue,
  PLAN_AUDIT_PAGE_SIZE,
  planAuditFieldLabel,
  planAuditKey,
  planAuditParams,
  planAuditQueryOptions,
} from './admin-plan-audit'

const group = (n: number) => new Intl.NumberFormat('en-BD').format(n)

describe('planAuditFieldLabel', () => {
  it('labels prices and the badge like the editor', () => {
    expect(planAuditFieldLabel('originalPriceBdt')).toBe('Original price')
    expect(planAuditFieldLabel('offerPriceBdt')).toBe('Offer price')
    expect(planAuditFieldLabel('offerBadge')).toBe('Offer badge')
  })

  it('uses the client.md §7 matrix labels for limits and features', () => {
    expect(planAuditFieldLabel('featureConfig.limits.connectedPages')).toBe('Connected FB & IG Pages')
    expect(planAuditFieldLabel('featureConfig.limits.monthlyComments')).toBe('Monthly comments')
    expect(planAuditFieldLabel('featureConfig.limits.workspaces')).toBe('Workspaces')
    // Renamed back in PW-T1b: M5-T11 rows keep their field name and old label.
    expect(planAuditFieldLabel('featureConfig.limits.monthlyAiCredits')).toBe('Monthly AI credits')
    expect(planAuditFieldLabel('featureConfig.limits.teamSeats')).toBe('Team / Moderator Seats')
    expect(planAuditFieldLabel('featureConfig.features.customBlocklist')).toBe('Custom Keyword & BD Phone Blocklist')
    expect(planAuditFieldLabel('featureConfig.features.prioritySupportApi')).toBe(
      'Priority Support & API Webhook Access',
    )
  })

  it('labels the PW-T7 yearly and trial fields', () => {
    expect(planAuditFieldLabel('yearlyMonthlyPriceBdt')).toBe('Yearly price per month')
    expect(planAuditFieldLabel('trialDays')).toBe('Trial length')
    expect(planAuditFieldLabel('trialCommentLimit')).toBe('Trial comment limit')
  })

  it('labels the PR-T5 card fields and keeps the legacy keys readable', () => {
    expect(planAuditFieldLabel('monthlyPriceBdt')).toBe('Monthly price')
    expect(planAuditFieldLabel('badgeEn')).toBe('Badge (English)')
    expect(planAuditFieldLabel('badgeBn')).toBe('Badge (Bangla)')
    expect(planAuditFieldLabel('descriptionEn')).toBe('Description (English)')
    expect(planAuditFieldLabel('descriptionBn')).toBe('Description (Bangla)')
    expect(planAuditFieldLabel('isHighlighted')).toBe('Highlighted')
    // Legacy (PR-T4 `LEGACY_PLAN_AUDIT_FIELDS`): old rows still read.
    expect(planAuditFieldLabel('originalPriceBdt')).toBe('Original price')
    expect(planAuditFieldLabel('offerBadge')).toBe('Offer badge')
    expect(planAuditFieldLabel('trialDays')).toBe('Trial length')
  })

  it('falls back to the raw field for anything unknown', () => {
    expect(planAuditFieldLabel('featureConfig.limits.storageGb')).toBe('featureConfig.limits.storageGb')
    expect(planAuditFieldLabel('featureConfig.features.toString')).toBe('featureConfig.features.toString')
    expect(planAuditFieldLabel('isActive')).toBe('isActive')
  })
})

describe('formatPlanAuditValue', () => {
  it('formats prices as ৳ with grouping', () => {
    expect(formatPlanAuditValue('originalPriceBdt', 2499)).toBe('৳2,499')
    expect(formatPlanAuditValue('offerPriceBdt', 0)).toBe('৳0')
    expect(formatPlanAuditValue('originalPriceBdt', 1_000_000)).toBe(`৳${group(1_000_000)}`)
  })

  it('shows null (cleared offer / badge) as None', () => {
    expect(formatPlanAuditValue('offerPriceBdt', null)).toBe('None')
    expect(formatPlanAuditValue('offerBadge', null)).toBe('None')
    expect(formatPlanAuditValue('offerBadge', undefined)).toBe('None')
  })

  it('formats the yearly price, trial length and trial limit, with their own null wording', () => {
    expect(formatPlanAuditValue('yearlyMonthlyPriceBdt', 449)).toBe('৳449')
    expect(formatPlanAuditValue('yearlyMonthlyPriceBdt', null)).toBe('No yearly option')
    expect(formatPlanAuditValue('trialDays', 7)).toBe('7 days')
    expect(formatPlanAuditValue('trialDays', null)).toBe('No trial')
    expect(formatPlanAuditValue('trialCommentLimit', 1500)).toBe(group(1500))
    expect(formatPlanAuditValue('trialCommentLimit', null)).toBe('Monthly comments')
  })

  it('quotes badges, groups limits and maps flags to On/Off', () => {
    expect(formatPlanAuditValue('offerBadge', '40% Off')).toBe('“40% Off”')
    expect(formatPlanAuditValue('featureConfig.limits.monthlyAiCredits', 15000)).toBe(group(15000))
    expect(formatPlanAuditValue('featureConfig.limits.monthlyComments', 15000)).toBe(group(15000))
    expect(formatPlanAuditValue('featureConfig.limits.teamSeats', 3)).toBe('3')
    expect(formatPlanAuditValue('featureConfig.features.messengerAlerts', true)).toBe('On')
    expect(formatPlanAuditValue('featureConfig.features.messengerAlerts', false)).toBe('Off')
  })

  it('quotes card text, shows Yes/No for the highlight and None for cleared text', () => {
    expect(formatPlanAuditValue('badgeEn', 'Popular')).toBe('“Popular”')
    expect(formatPlanAuditValue('descriptionBn', 'ছোট দোকানের জন্য')).toBe('“ছোট দোকানের জন্য”')
    expect(formatPlanAuditValue('badgeBn', null)).toBe('None')
    expect(formatPlanAuditValue('isHighlighted', true)).toBe('Yes')
    expect(formatPlanAuditValue('isHighlighted', false)).toBe('No')
    expect(formatPlanAuditValue('monthlyPriceBdt', 999)).toBe('৳999')
    expect(formatPlanAuditValue('trialDays', 1)).toBe('1 day')
  })

  it('prints unknown fields plainly', () => {
    expect(formatPlanAuditValue('isActive', false)).toBe('false')
    expect(formatPlanAuditValue('somethingNew', 1200)).toBe(group(1200))
    expect(formatPlanAuditValue('somethingNew', 'x')).toBe('x')
  })
})

describe('planAuditParams / planAuditQueryOptions', () => {
  it('turns page + planId into skip/take/planId', () => {
    expect(planAuditParams({ page: 1 }).toString()).toBe(`skip=0&take=${PLAN_AUDIT_PAGE_SIZE}`)
    expect(planAuditParams({ page: 3 }).toString()).toBe('skip=40&take=20')
    expect(planAuditParams({ page: 0 }).get('skip')).toBe('0')
    expect(planAuditParams({ page: 2, planId: 'p-1' }).toString()).toBe('skip=20&take=20&planId=p-1')
  })

  it('keys every page under [admin, plans, audit]', () => {
    expect(planAuditKey).toEqual(['admin', 'plans', 'audit'])
    expect(planAuditQueryOptions({ page: 2, planId: 'p-1' }).queryKey).toEqual([
      'admin',
      'plans',
      'audit',
      { skip: 20, take: 20, planId: 'p-1' },
    ])
    expect(planAuditQueryOptions({ page: 1 }).queryKey).toEqual([
      'admin',
      'plans',
      'audit',
      { skip: 0, take: 20, planId: null },
    ])
  })
})
