/** Only same-app paths are allowed as a post-login target (no `//evil.com` or absolute URLs). */
export function safeRedirect(target: unknown, fallback = '/dashboard'): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return fallback
  // Auth pages bounce a signed-in user anyway; landing there after sign-in would loop.
  if (/^\/(login|register)(?:[/?#]|$)/.test(target)) return fallback
  return target
}
