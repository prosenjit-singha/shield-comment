import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

/**
 * Platform settings shown to clients (PR-T4 API, PR-T5 screen; PR-D18). Mirrors the backend's
 * `src/admin/dto/platform-settings.dto.ts`: `GET` / `PATCH /api/admin/settings/platform`.
 */
export interface PlatformSettings {
  /** WhatsApp number behind the client "Contact us" button; `null` = the button is hidden. */
  supportWhatsappNumber: string | null
  /** Last save; `null` = never saved. */
  updatedAt: string | null
}

/** BD mobile with the country code, digits only (backend `SUPPORT_WHATSAPP_PATTERN`). */
export const SUPPORT_WHATSAPP_PATTERN = /^8801[3-9][0-9]{8}$/

export const platformSettingsKey = ['admin', 'settings', 'platform'] as const

export function platformSettingsQueryOptions() {
  return queryOptions({
    queryKey: platformSettingsKey,
    queryFn: ({ signal }) => apiFetch<PlatformSettings>('/admin/settings/platform', { signal }),
  })
}

/** `null` (or blank, trimmed by the backend) clears the number. */
export function updatePlatformSettings(body: { supportWhatsappNumber: string | null }) {
  return apiFetch<PlatformSettings>('/admin/settings/platform', { method: 'PATCH', body: JSON.stringify(body) })
}

/** Error text for the typed number, or `null` when it is valid or empty (empty = clear). */
export function whatsappNumberError(value: string): string | null {
  const trimmed = value.trim()
  if (trimmed === '' || SUPPORT_WHATSAPP_PATTERN.test(trimmed)) return null
  return 'Use 13 digits with the country code, e.g. 8801712345678.'
}
