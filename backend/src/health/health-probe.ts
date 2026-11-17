const HEALTH_PROBE = /^\/api\/health(\/live)?\/?(\?.*)?$/;

/** True for `/api/health` and `/api/health/live` (any query string): skipped by HTTP auto-logging. */
export function isHealthProbe(url: string | undefined): boolean {
  return url !== undefined && HEALTH_PROBE.test(url);
}
