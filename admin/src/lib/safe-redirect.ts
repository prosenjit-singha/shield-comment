/** Only same-app paths are allowed as a post-login target (no `//evil.com` or absolute URLs). */
export function safeRedirect(target: unknown, fallback = '/admin/dashboard'): string {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) return fallback
  if (target.startsWith('/admin/login')) return fallback
  return target
}
