import { adminClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Better Auth client. No baseURL: it uses the page origin + `/api/auth`, which the Vite dev server
 * and nginx proxy to the backend (same-origin API, tech-stack.md §4). The session is an httpOnly cookie.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient(), adminClient()],
})

export type AuthSession = typeof authClient.$Infer.Session
