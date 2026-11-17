import { adminClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

/**
 * Browser Better Auth client. No baseURL: it uses the page origin + `/api/auth`, which the dev server
 * and the Start server route (`src/routes/api/$.ts`) proxy to the backend (tech-stack.md §4).
 * The session is an httpOnly cookie. Server code uses `src/server/session.ts` instead.
 */
export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [organizationClient(), adminClient()],
})

export type AuthSession = typeof authClient.$Infer.Session
