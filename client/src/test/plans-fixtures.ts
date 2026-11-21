import type { PublicPlan, PublicPlansResponse } from '@/lib/plans'

/** `GET /api/plans` fixtures shared by the `/plans` and landing tests. */
const NUMBER = '8801712345678'

const features = (on: number): PublicPlan['features'] => ({
  banglaAiFilter: true,
  autoHideScams: true,
  customBlocklist: on > 2,
  autoReplyTemplates: on > 3,
  messengerAlerts: on > 4,
  whiteLabelReports: on > 5,
  prioritySupportApi: on > 6,
})

export const STARTER: PublicPlan = {
  id: 'plan-starter',
  slug: 'starter',
  name: 'Starter',
  badge: null,
  description: { en: 'For one shop page', bn: 'একটি দোকানের পেজের জন্য' },
  highlighted: false,
  monthly: {
    listPerMonthBdt: 999,
    listChargedBdt: 999,
    perMonthBdt: 499,
    chargedBdt: 499,
    saving: { promotionId: 'pr1', label: '৳500 off', labelBn: '৳৫০০ ছাড়', amountBdt: 500 },
  },
  yearly: {
    listPerMonthBdt: 949,
    listChargedBdt: 11388,
    perMonthBdt: 449,
    chargedBdt: 5388,
    saving: { promotionId: 'pr1', label: '৳500 off', labelBn: '৳৫০০ ছাড়', amountBdt: 6000 },
  },
  limits: { connectedPages: 1, monthlyComments: 2500, teamSeats: 1, workspaces: 1 },
  features: features(2),
  trial: { promotionId: 'pt1', days: 7, commentLimit: 300, endsAt: null },
}

export const GROWTH: PublicPlan = {
  id: 'plan-growth',
  slug: 'growth',
  name: 'Growth',
  badge: { en: 'Popular', bn: 'জনপ্রিয়' },
  description: { en: 'For growing brands', bn: 'বাড়তে থাকা ব্র্যান্ডের জন্য' },
  highlighted: true,
  monthly: {
    listPerMonthBdt: 2499,
    listChargedBdt: 2499,
    perMonthBdt: 1249,
    chargedBdt: 1249,
    saving: { promotionId: 'pr2', label: '50% off', labelBn: '৫০% ছাড়', amountBdt: 1250 },
  },
  yearly: { listPerMonthBdt: 2249, listChargedBdt: 26988, perMonthBdt: 2249, chargedBdt: 26988, saving: null },
  limits: { connectedPages: 5, monthlyComments: 15000, teamSeats: 3, workspaces: 3 },
  features: features(5),
  trial: null,
}

export const PRO: PublicPlan = {
  id: 'plan-pro',
  slug: 'pro',
  name: 'Pro',
  badge: null,
  description: null,
  highlighted: false,
  monthly: { listPerMonthBdt: 5999, listChargedBdt: 5999, perMonthBdt: 5999, chargedBdt: 5999, saving: null },
  yearly: null,
  limits: { connectedPages: 25, monthlyComments: 75000, teamSeats: 10, workspaces: 10 },
  features: features(7),
  trial: null,
}

export const plansResponse = (overrides: Partial<PublicPlansResponse> = {}): PublicPlansResponse => ({
  items: [STARTER, GROWTH, PRO],
  yearlySaveUpToPercent: 10,
  contactWhatsapp: NUMBER,
  ...overrides,
})
