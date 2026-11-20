import type { AlertSettings, AlertSettingsPatch } from '@/lib/alerts'
import type { Team } from '@/lib/team'
import { team, teamApi } from './app-routes'
import { json } from './auth-routes'

export const ALERTS = '/api/workspaces/w1/alerts'
export const ALERT_SETTINGS = `${ALERTS}/settings`
export const TELEGRAM_LINK = `${ALERTS}/telegram/link`
export const telegramChatUrl = (id: string) => `${ALERTS}/telegram/chats/${id}`
export const TEST_ALERT = `${ALERTS}/test`

/** M7-T7 defaults for the `team()` workspace: email on to the owner, Telegram on Growth (available, configured, no chats). */
export function alertSettings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return {
    workspaceId: 'w1',
    spikeThreshold: 10,
    email: {
      enabled: true,
      available: true,
      recipients: [{ memberId: 'm-owner', userId: 'u1', name: 'Rahim', email: 'owner@shop.bd', role: 'owner' }],
    },
    telegram: { enabled: false, available: true, configured: true, chats: [] },
    whatsapp: { enabled: false, available: false, comingSoon: true },
    lastAlerts: [],
    updatedAt: null,
    ...overrides,
  }
}

type Respond = () => Response | Promise<Response>

export interface AlertsApiOptions {
  onGet?: Respond
  /** Answers the PATCH (parsed body) instead of applying it. */
  onPatch?: (body: AlertSettingsPatch) => Response | Promise<Response>
  /** Default: a link that expires 2026-11-20 10:15 UTC (16:15 Dhaka). */
  onLink?: Respond
  /** Default: removes the chat and answers 204. */
  onRemove?: (chatId: string) => Response | Promise<Response>
  /** Default: every enabled channel SENT. */
  onTest?: Respond
}

/**
 * `/settings/alerts` (M7-T15): a stateful alerts API (settings GET/PATCH, Telegram link + chat DELETE, test
 * POST) plus the team list the screen reads for roles and recipients. Other methods fail the test.
 */
export function alertsApi(initial: AlertSettings = alertSettings(), options: AlertsApiOptions = {}, teamState: Team = team()) {
  const state = structuredClone(initial)
  const method = (init?: RequestInit) => (init?.method ?? 'GET').toUpperCase()
  const only = (path: string, expected: string, init: RequestInit | undefined) => {
    if (method(init) !== expected) throw new Error(`Unexpected ${method(init)} ${path}`)
  }
  return {
    ...teamApi(teamState),
    [ALERT_SETTINGS]: (init?: RequestInit) => {
      if (method(init) === 'GET') return options.onGet ? options.onGet() : json(200, state)
      only(ALERT_SETTINGS, 'PATCH', init)
      const body = JSON.parse(String(init?.body)) as AlertSettingsPatch
      if (options.onPatch) return options.onPatch(body)
      if (body.spikeThreshold !== undefined) state.spikeThreshold = body.spikeThreshold
      if (body.emailEnabled !== undefined) state.email.enabled = body.emailEnabled
      if (body.telegramEnabled !== undefined) state.telegram.enabled = body.telegramEnabled
      if (body.emailRecipientMemberIds)
        state.email.recipients = teamState.members
          .filter((item) => body.emailRecipientMemberIds!.includes(item.memberId))
          .map(({ memberId, userId, name, email, role }) => ({ memberId, userId, name, email, role }))
      state.updatedAt = '2026-11-20T10:00:00.000Z'
      return json(200, state)
    },
    [TELEGRAM_LINK]: (init?: RequestInit) => {
      only(TELEGRAM_LINK, 'POST', init)
      if (options.onLink) return options.onLink()
      return json(201, {
        url: 'https://t.me/ShieldBot?start=abc123',
        groupUrl: 'https://t.me/ShieldBot?startgroup=abc123',
        expiresAt: '2026-11-20T10:15:00.000Z',
      })
    },
    ...Object.fromEntries(
      state.telegram.chats.map((chat) => [
        telegramChatUrl(chat.id),
        (init?: RequestInit) => {
          only(telegramChatUrl(chat.id), 'DELETE', init)
          if (options.onRemove) return options.onRemove(chat.id)
          state.telegram.chats = state.telegram.chats.filter((item) => item.id !== chat.id)
          return new Response(null, { status: 204 })
        },
      ]),
    ),
    [TEST_ALERT]: (init?: RequestInit) => {
      only(TEST_ALERT, 'POST', init)
      if (options.onTest) return options.onTest()
      const deliveries = [
        ...(state.email.enabled ? [{ channel: 'EMAIL', status: 'SENT', errorKind: null }] : []),
        ...(state.telegram.enabled && state.telegram.chats.length > 0 ? [{ channel: 'TELEGRAM', status: 'SENT', errorKind: null }] : []),
      ]
      return json(200, { deliveries })
    },
  }
}
