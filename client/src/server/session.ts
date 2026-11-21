import { createServerFn } from '@tanstack/react-start'
import { appendResponseHeader, getRequest, getRequestIP } from '@tanstack/react-start/server'
import { adminClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import type { AuthSession } from '@/lib/auth-client'
import { apiUpstream, buildForwardHeaders } from '@/server/api-proxy'

/**
 * Session check for server renders (`_app` guard during SSR). The browser's cookie only reaches this
 * server, so forward it to Better Auth on the backend, and pass any refreshed cookie back.
 */
export const getServerSession = createServerFn({ method: 'GET' }).handler(
  async (): Promise<AuthSession | null> => {
    const request = getRequest()
    if (!request.headers.get('cookie')) return null // signed out: skip the backend round trip

    const url = new URL(request.url)
    const headers = buildForwardHeaders(request.headers, {
      clientIp: getRequestIP(),
      host: url.host,
      proto: url.protocol.replace(/:$/, ''),
    })
    // Only what get-session needs; never forward the page request's body headers.
    const forward = new Headers()
    // fly-client-ip: the visitor's IP from the Fly edge, the backend's client IP on Fly (M9-T14a).
    for (const name of ['cookie', 'user-agent', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'fly-client-ip']) {
      const value = headers.get(name)
      if (value) forward.set(name, value)
    }

    const serverAuthClient = createAuthClient({
      baseURL: `${apiUpstream()}/api/auth`,
      plugins: [organizationClient(), adminClient()],
    })
    const { data, error } = await serverAuthClient.getSession({
      fetchOptions: {
        headers: forward,
        onResponse: ({ response }) => {
          for (const cookie of response.headers.getSetCookie()) appendResponseHeader('set-cookie', cookie)
        },
      },
    })
    if (error) throw new Error(error.message ?? `Session check failed (${error.status})`)
    return data
  },
)
