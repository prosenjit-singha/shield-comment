import { QueryClientProvider, type QueryClient } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { render } from '@testing-library/react'
import { vi } from 'vitest'
import type { Analytics, AnalyticsBucket, AnalyticsCounts, Granularity } from '@/lib/analytics'
import type { BillingSummary } from '@/lib/billing-summary'
import type { CommentFeedItem, CommentStatus, OverrideAction } from '@/lib/comments-feed'
import type { DashboardSummary, SummaryRange } from '@/lib/dashboard-summary'
import type { Language } from '@/lib/language'
import type { WorkspaceMetaConnection, WorkspacePage } from '@/lib/meta-pages'
import type { AiContextLevel, ModerationPolicy, PolicyPatch } from '@/lib/moderation-policy'
import type { PlaygroundResult, PlaygroundUsage } from '@/lib/playground'
import { createQueryClient } from '@/lib/query-client'
import { Route as AppRoute } from '@/routes/_app'
import { Route as AnalyticsRoute } from '@/routes/_app/analytics'
import { Route as CommentsRoute } from '@/routes/_app/comments'
import { Route as DashboardRoute } from '@/routes/_app/dashboard'
import { Route as OnboardingRoute } from '@/routes/_app/onboarding'
import { Route as PagesRoute } from '@/routes/_app/pages'
import { Route as PlansRoute } from '@/routes/_app/plans'
import { Route as PlaygroundRoute } from '@/routes/_app/playground'
import { Route as RulesRoute } from '@/routes/_app/rules'
import { createLanguageStore, LanguageStoreContext } from '@/stores/language-store'
import { useUiStore } from '@/stores/ui-store'
import { json } from './auth-routes'

/**
 * Harness for the logged-in screens (`/onboarding` M3-T10, `/pages` M3-T11, `/plans` PR-T6): the real `_app`
 * layout + `/onboarding` + `/pages` + `/dashboard` + `/comments` + `/plans` + `/rules` + `/playground` + `/analytics` route files under a bare root (the generated tree pulls
 * in the Start server functions), with a stub /login. Test files must still
 * `vi.mock('@/server/session', …)` themselves (vi.mock is hoisted per file).
 */
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet })
const appRoute = AppRoute.update({ id: '/_app', getParentRoute: () => rootRoute } as never)
const childOptions = (path: string) => ({ id: path, path, getParentRoute: () => appRoute }) as never
const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/login', component: () => <p>Login stub</p> })
const routeTree = rootRoute.addChildren([
  appRoute.addChildren([
    OnboardingRoute.update(childOptions('/onboarding')),
    PagesRoute.update(childOptions('/pages')),
    DashboardRoute.update(childOptions('/dashboard')),
    CommentsRoute.update(childOptions('/comments')),
    PlansRoute.update(childOptions('/plans')),
    RulesRoute.update(childOptions('/rules')),
    PlaygroundRoute.update(childOptions('/playground')),
    AnalyticsRoute.update(childOptions('/analytics')),
  ]),
  loginRoute,
])

export const USER = { id: 'u1', email: 'owner@shop.bd', name: 'Rahim', emailVerified: false }
export const SESSION = { session: { id: 's1', userId: 'u1', impersonatedBy: null, activeOrganizationId: 'w1' }, user: USER }
export const IMPERSONATED = { session: { ...SESSION.session, id: 's2', impersonatedBy: 'admin-1' }, user: USER }

export const PAGES = '/api/workspaces/w1/pages'
export const OAUTH_URL = '/api/workspaces/w1/meta/oauth/url'
export const toggleUrl = (id: string) => `${PAGES}/${id}/toggle`
export const DISCONNECT = '/api/workspaces/w1/meta/connection'
export const POLICY = '/api/workspaces/w1/moderation/policy'
export const SUMMARY = '/api/workspaces/w1/billing/summary'
export const DASHBOARD = '/api/workspaces/w1/dashboard/summary'
export const COMMENTS = '/api/workspaces/w1/comments'
export const overrideUrl = (id: string) => `${COMMENTS}/${id}/override`
export const PLAYGROUND_TEST = '/api/workspaces/w1/playground/test'
export const PLAYGROUND_USAGE = '/api/workspaces/w1/playground/usage'
export const ANALYTICS = '/api/workspaces/w1/analytics'
export const ANALYTICS_DAILY_CSV = `${ANALYTICS}/export.csv`
export const ANALYTICS_COMMENTS_CSV = `${ANALYTICS}/comments.csv`
export const META_DIALOG = 'https://www.facebook.com/v26.0/dialog/oauth?client_id=1&state=abc'

export function page(overrides: Partial<WorkspacePage> = {}): WorkspacePage {
  return {
    id: 'p1',
    pageId: '1001',
    pageName: 'Rahim Fashion',
    igBusinessId: '17841',
    igUsername: 'rahimfashion',
    isActive: false,
    hasToken: true,
    createdAt: '2026-11-18T00:00:00.000Z',
    updatedAt: '2026-11-18T00:00:00.000Z',
    ...overrides,
  }
}

export const SECOND = page({ id: 'p2', pageId: '1002', pageName: 'Shop Two', igBusinessId: null, igUsername: null })

export const connection = (status: WorkspaceMetaConnection['status'] = 'ACTIVE'): WorkspaceMetaConnection => ({
  status,
  statusChangedAt: '2026-11-19T00:00:00.000Z',
  tokenExpiresAt: status === 'REVOKED' ? null : '2027-01-18T00:00:00.000Z',
})

export interface PagesApiOptions {
  /** The list's `connection` (M4-T9); default ACTIVE. */
  connection?: WorkspaceMetaConnection | null
  /**
   * Adds `DELETE …/meta/connection`: answers with this; a 2xx answer empties the list and sets
   * `connection: null` for the next GET (as the backend does).
   */
  onDisconnect?: () => Response | Promise<Response>
}

/**
 * A stateful pages API: GET lists `items`; PATCH …/toggle flips the Page (or answers with `onToggle`,
 * which gets the stored row) and the next GET reflects it.
 */
export function pagesApi(
  items: WorkspacePage[],
  limit = 3,
  onToggle?: (item: WorkspacePage) => Response | Promise<Response>,
  options: PagesApiOptions = {},
) {
  const state = items.map((item) => ({ ...item }))
  let current = options.connection === undefined ? connection() : options.connection
  const list = () =>
    json(200, {
      items: state,
      pageLimit: { limit, activeCount: state.filter((item) => item.isActive).length },
      connection: current,
    })
  // `/pages` also loads the moderation policy once the list loaded (M5-T15 "AI analysis" card), and the
  // `_app` shell the billing summary (PW-T8 banner; a paid plan = no banner).
  const handlers: Record<string, (init?: RequestInit, url?: URL) => Response | Promise<Response>> = {
    [PAGES]: list,
    ...policyApi(),
    ...summaryApi(),
    ...dashboardApi(),
  }
  const { onDisconnect } = options
  if (onDisconnect) {
    handlers[DISCONNECT] = async () => {
      const response = await onDisconnect()
      if (response.ok) {
        state.length = 0
        current = null
      }
      return response
    }
  }
  for (const item of state) {
    handlers[toggleUrl(item.id)] = () => {
      if (onToggle) return onToggle(item)
      item.isActive = !item.isActive
      return json(200, { page: item, changed: true })
    }
  }
  return handlers
}

export function policy(overrides: Partial<ModerationPolicy> = {}): ModerationPolicy {
  const rule = (action: 'NONE' | 'HIDE') => ({ action, autoReply: false, replyEn: null, replyBn: null })
  return {
    workspaceId: 'w1',
    mode: 'AUTO',
    confidenceThreshold: 0.7,
    aiContextLevel: 'comment_only',
    categories: {
      SAFE_INQUIRY: rule('NONE'),
      COMPETITOR_POACH: rule('HIDE'),
      SCAM_PHISHING: rule('HIDE'),
      SPAM_IRRELEVANT: rule('HIDE'),
      ABUSIVE_TOXIC: rule('HIDE'),
    },
    autoReplyAvailable: false,
    rules: { blockedKeywords: [], blockUrls: false, blockPhoneNumbers: false, allowedDomains: [], actions: { keyword: 'HIDE', url: 'HIDE', phone: 'HIDE' } },
    keywordRulesAvailable: false,
    urlPhoneRulesAvailable: true,
    updatedAt: '2026-11-19T00:00:00.000Z',
    ...overrides,
  }
}

export interface PolicyApiOptions {
  /** Answers the GET instead of the stored policy. */
  onGet?: () => Response | Promise<Response>
  /** Answers the PATCH (gets the parsed body) instead of storing it. */
  onPatch?: (body: unknown) => Response | Promise<Response>
  /** Starting policy fields (`/rules`, M6-T10). */
  initial?: Partial<ModerationPolicy>
}

/**
 * A stateful moderation policy API (M5-T8 + M6-T1 contract): GET returns the policy; PATCH merges the
 * partial body (categories and rules per field) and answers `{ ...policy, changed }`. Any other method
 * fails the test.
 */
export function policyApi(level: AiContextLevel = 'comment_only', options: PolicyApiOptions = {}) {
  let current = policy({ aiContextLevel: level, ...options.initial })
  return {
    [POLICY]: async (init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') return options.onGet ? options.onGet() : json(200, current)
      if (method !== 'PATCH') throw new Error(`Unexpected ${method} ${POLICY}`)
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      if (options.onPatch) return options.onPatch(body)
      const patch = body as PolicyPatch & { aiContextLevel?: AiContextLevel }
      const categories = { ...current.categories }
      for (const [category, change] of Object.entries(patch.categories ?? {}) as [keyof typeof categories, object][]) {
        categories[category] = { ...categories[category], ...change }
      }
      const { actions, ...rules } = patch.rules ?? {}
      const next: ModerationPolicy = {
        ...current,
        ...patch,
        categories,
        rules: { ...current.rules, ...rules, actions: { ...current.rules.actions, ...actions } },
      }
      const changed = JSON.stringify(next) !== JSON.stringify(current)
      current = { ...next, updatedAt: changed ? '2026-11-19T10:00:00.000Z' : current.updatedAt }
      return json(200, { ...current, changed })
    },
  }
}

/** A billing summary (PW-T6 contract); default = a paid Starter month with comments left (no banner). */
export function billingSummary(overrides: Partial<BillingSummary> = {}): BillingSummary {
  return {
    plan: { slug: 'starter', name: 'Starter' },
    interval: 'month',
    status: 'ACTIVE',
    trialEndsAt: null,
    termEndsAt: '2026-12-15T18:00:00.000Z',
    comments: { used: 120, limit: 2500, resetsAt: '2026-12-15T18:00:00.000Z' },
    workspaces: { used: 1, limit: 1 },
    pages: { used: 1, limit: 1 },
    trialEligible: false,
    ...overrides,
  }
}

/** `GET …/billing/summary` (the `_app` shell banner, PW-T8): answers `respond` (default: `billingSummary()`). */
export function summaryApi(respond: () => Response | Promise<Response> = () => json(200, billingSummary())) {
  return {
    [SUMMARY]: (init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new Error(`Unexpected ${method} ${SUMMARY}`)
      return respond()
    },
  }
}

/** A zero-filled dashboard summary (M6-T5 contract) for `range`; `fill` sets day i's counts. */
export function dashboardSummary(
  range: SummaryRange = '30d',
  fill: (i: number) => { scanned: number; autoHidden: number } = () => ({ scanned: 0, autoHidden: 0 }),
): DashboardSummary {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const end = Date.parse('2026-11-20T00:00:00Z')
  const daily = Array.from({ length: days }, (_, i) => ({
    day: new Date(end - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    ...fill(i),
  }))
  const zero = (category: DashboardSummary['intents'][number]['category']) => ({ category, count: 0 })
  return {
    range,
    kpis: {
      scanned: daily.reduce((sum, d) => sum + d.scanned, 0),
      autoHidden: daily.reduce((sum, d) => sum + d.autoHidden, 0),
      needsReview: 0,
      scamsBlocked: 0,
    },
    daily,
    intents: (['SAFE_INQUIRY', 'COMPETITOR_POACH', 'SCAM_PHISHING', 'SPAM_IRRELEVANT', 'ABUSIVE_TOXIC'] as const).map(zero),
    flagged: (['COMPETITOR_POACH', 'SCAM_PHISHING', 'SPAM_IRRELEVANT', 'ABUSIVE_TOXIC'] as const).map(zero),
  }
}

/**
 * `GET …/dashboard/summary?range=` (`/dashboard`, M6-T8): answers `respond(range)` (default: an empty summary
 * for the requested range). Any other method or range fails the test.
 */
export function dashboardApi(respond: (range: SummaryRange) => Response | Promise<Response> = (range) => json(200, dashboardSummary(range))) {
  return {
    [DASHBOARD]: (init?: RequestInit, url?: URL) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new Error(`Unexpected ${method} ${DASHBOARD}`)
      const range = url?.searchParams.get('range')
      if (range !== '7d' && range !== '30d' && range !== '90d') throw new Error(`Unexpected range ${String(range)}`)
      return respond(range)
    },
  }
}

/** A feed item (M6-T3 contract); default = a scam comment waiting for review. */
export function comment(overrides: Partial<CommentFeedItem> = {}): CommentFeedItem {
  return {
    id: 'c1',
    platform: 'FACEBOOK',
    page: { id: '6f1c2a3b-0000-4000-8000-000000000001', name: 'Shop One' },
    postId: '1001_2001',
    authorName: 'Karim',
    message: 'bKash e taka pathan 01712345678',
    status: 'NEEDS_REVIEW',
    statusReason: 'below_threshold',
    category: 'SCAM_PHISHING',
    confidence: 0.72,
    language: 'banglish',
    reasoning: 'Asks for a bKash payment to a personal number.',
    ruleMatch: null,
    overriddenAt: null,
    editedAt: null,
    createdAt: '2026-11-20T08:00:00.000Z',
    lastAction: null,
    ...overrides,
  }
}

const STATUS_AFTER: Partial<Record<OverrideAction, CommentStatus>> = { HIDE: 'HIDDEN', UNHIDE: 'VISIBLE', DELETE: 'DELETED', KEEP: 'VISIBLE' }

export interface CommentsApiOptions {
  /** Answers `GET …/comments` (gets the URL: filters, `cursor`, `since`). Default: `items`, or none for `since`. */
  onList?: (url: URL) => Response | Promise<Response>
  /** Answers `POST …/override` instead of the default (apply the action, return the item). */
  onOverride?: (item: CommentFeedItem, body: { action: OverrideAction; replyText?: string }) => Response | Promise<Response>
}

/** `/comments` (M6-T9): a stateful feed + `POST …/:id/override` per item. Any other method fails the test. */
export function commentsApi(items: CommentFeedItem[] = [], options: CommentsApiOptions = {}) {
  const state = items.map((item) => ({ ...item }))
  const handlers: Record<string, (init?: RequestInit, url?: URL) => Response | Promise<Response>> = {
    [COMMENTS]: (init, url) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET' || !url) throw new Error(`Unexpected ${method} ${COMMENTS}`)
      if (options.onList) return options.onList(url)
      return json(200, { items: url.searchParams.has('since') ? [] : state, nextCursor: null })
    },
  }
  for (const item of state) {
    handlers[overrideUrl(item.id)] = (init) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'POST' || typeof init?.body !== 'string') throw new Error(`Unexpected ${method} ${overrideUrl(item.id)}`)
      const body = JSON.parse(init.body) as { action: OverrideAction; replyText?: string }
      if (options.onOverride) return options.onOverride(item, body)
      item.status = STATUS_AFTER[body.action] ?? item.status
      item.overriddenAt = '2026-11-20T09:00:00.000Z'
      item.lastAction = { action: body.action, source: 'USER', state: 'SUCCEEDED', at: item.overriddenAt }
      return json(200, item)
    }
  }
  return handlers
}

/** A playground answer (M6-T7 contract); default = an AI result that would hide a scam. */
export function playgroundResult(overrides: Partial<PlaygroundResult> = {}): PlaygroundResult {
  return {
    ruleMatch: null,
    classification: { category: 'SCAM_PHISHING', confidence: 0.93, reasoning: 'Asks for a bKash payment.', language: 'banglish' },
    decision: { action: 'HIDE', status: 'HIDDEN', reason: 'policy' },
    latencyMs: 324,
    testsLeft: 7,
    ...overrides,
  }
}

export interface PlaygroundApiOptions {
  /** Answers `GET …/playground/usage` (default: 8 of 10 left). */
  onUsage?: () => Response | Promise<Response>
}

/**
 * `/playground` (M6-T11): `POST …/playground/test` answers `respond(body)`; `GET …/usage` answers `onUsage`.
 * Any other method fails the test.
 */
export function playgroundApi(
  respond: (body: { text: string; platform?: string }) => Response | Promise<Response> = () => json(200, playgroundResult()),
  options: PlaygroundApiOptions = {},
) {
  const usage: PlaygroundUsage = { limit: 10, used: 2, testsLeft: 8, resetsAt: '2026-11-20T18:00:00.000Z' }
  return {
    [PLAYGROUND_USAGE]: (init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') throw new Error(`Unexpected ${method} ${PLAYGROUND_USAGE}`)
      return options.onUsage ? options.onUsage() : json(200, usage)
    },
    [PLAYGROUND_TEST]: (init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'POST' || typeof init?.body !== 'string') throw new Error(`Unexpected ${method} ${PLAYGROUND_TEST}`)
      return respond(JSON.parse(init.body) as { text: string; platform?: string })
    },
  }
}

const COUNTERS = [
  'received',
  'edited',
  'removed',
  'classified',
  'safeInquiry',
  'competitorPoach',
  'scamPhishing',
  'spamIrrelevant',
  'abusiveToxic',
  'ruleMatched',
  'hidden',
  'unhidden',
  'deleted',
  'replied',
  'skipped',
  'failed',
] as const

/** Zero counts with `overrides`; `scanned` / `autoHidden` derived like the backend. */
export function analyticsCounts(overrides: Partial<AnalyticsCounts> = {}): AnalyticsCounts {
  const c = { ...Object.fromEntries(COUNTERS.map((k) => [k, 0])), ...overrides } as AnalyticsCounts
  return { ...c, scanned: c.classified + c.ruleMatched, autoHidden: c.hidden + c.deleted }
}

/**
 * An analytics answer (M6-T6 contract): `buckets` keys (`YYYY-MM-DD` or `YYYY-MM`) with `fill(i)` counts;
 * totals = their sum. Default = 3 empty days.
 */
export function analytics(
  overrides: Partial<Omit<Analytics, 'series' | 'totals'>> = {},
  buckets: string[] = ['2026-11-18', '2026-11-19', '2026-11-20'],
  fill: (i: number) => Partial<AnalyticsCounts> = () => ({}),
): Analytics {
  const granularity: Granularity = overrides.granularity ?? (buckets[0]?.length === 7 ? 'month' : 'day')
  const series: AnalyticsBucket[] = buckets.map((bucket, i) => ({ bucket, ...analyticsCounts(fill(i)) }))
  const sum = Object.fromEntries(COUNTERS.map((k) => [k, series.reduce((total, b) => total + b[k], 0)]))
  const zero = (category: Analytics['intents'][number]['category']) => ({ category, count: 0 })
  return {
    from: '2026-11-18',
    to: '2026-11-20',
    granularity,
    page: null,
    totals: analyticsCounts(sum),
    series,
    intents: (['SAFE_INQUIRY', 'COMPETITOR_POACH', 'SCAM_PHISHING', 'SPAM_IRRELEVANT', 'ABUSIVE_TOXIC'] as const).map(zero),
    flagged: (['COMPETITOR_POACH', 'SCAM_PHISHING', 'SPAM_IRRELEVANT', 'ABUSIVE_TOXIC'] as const).map(zero),
    ...overrides,
  }
}

/** Pages with real UUID ids (the analytics `pageId` filter drops anything else). */
export const ANALYTICS_PAGES = [
  page({ id: '0b8f3c1e-1111-4a2b-9c3d-000000000001' }),
  { ...SECOND, id: '0b8f3c1e-2222-4a2b-9c3d-000000000002' },
]

export interface AnalyticsApiOptions {
  /** `GET …/pages` items for the Page filter (default: Shop One + Shop Two). */
  pages?: WorkspacePage[]
  /** `GET …/analytics/export.csv` / `comments.csv` answers (default: a small CSV). */
  onCsv?: (kind: 'daily' | 'comments', url: URL) => Response | Promise<Response>
}

const csvResponse = (filename: string) =>
  new Response('\uFEFFday,received\r\n', {
    status: 200,
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename}"` },
  })

/**
 * `/analytics` (M6-T12): `GET …/analytics` answers `respond(url)` (default: `analytics()`), the CSVs `onCsv`,
 * `GET …/pages` the Page list. Any other method fails the test.
 */
export function analyticsApi(
  respond: (url: URL) => Response | Promise<Response> = () => json(200, analytics()),
  options: AnalyticsApiOptions = {},
) {
  const get =
    (path: string, answer: (url: URL) => Response | Promise<Response>) =>
    (init?: RequestInit, url?: URL) => {
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET' || !url) throw new Error(`Unexpected ${method} ${path}`)
      return answer(url)
    }
  const items = options.pages ?? ANALYTICS_PAGES
  const csv = (kind: 'daily' | 'comments') => (url: URL) =>
    options.onCsv ? options.onCsv(kind, url) : csvResponse(`shieldcomment-${kind}-2026-11-18-to-2026-11-20.csv`)
  return {
    [ANALYTICS]: get(ANALYTICS, respond),
    [ANALYTICS_DAILY_CSV]: get(ANALYTICS_DAILY_CSV, csv('daily')),
    [ANALYTICS_COMMENTS_CSV]: get(ANALYTICS_COMMENTS_CSV, csv('comments')),
    [PAGES]: get(PAGES, () => json(200, { items, pageLimit: { limit: 3, activeCount: items.length }, connection: connection() })),
  }
}

/** jsdom gaps the `_app` shell needs (top-bar theme toggle reads matchMedia; the router scrolls; Recharts observes size). */
export function stubAppGlobals(): void {
  vi.stubGlobal('scrollTo', () => {})
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  useUiStore.setState({ theme: 'light' })
}

export function renderAppRoute(path: string, language: Language = 'en') {
  const queryClient = createQueryClient()
  const defaults = queryClient.getDefaultOptions()
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } })
  const history = createMemoryHistory({ initialEntries: [path] })
  const router = createRouter({ routeTree, history, context: { queryClient } })
  render(
    <LanguageStoreContext value={createLanguageStore(language)}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LanguageStoreContext>,
  )
  return { router, history, queryClient }
}
