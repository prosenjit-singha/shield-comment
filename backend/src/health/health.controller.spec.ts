import { HealthController } from './health.controller.js';
import { isHealthProbe } from './health-probe.js';
import type { HealthService } from './health.service.js';

describe('HealthController.live', () => {
  it('returns ok without touching DB or Redis', () => {
    const check = vi.fn();
    const controller = new HealthController({
      check,
    } as unknown as HealthService);

    const report = controller.live();

    expect(report.status).toBe('ok');
    expect(report.uptimeSeconds).toBeTypeOf('number');
    expect(Date.parse(report.timestamp)).not.toBeNaN();
    expect(check).not.toHaveBeenCalled();
  });
});

describe('isHealthProbe', () => {
  it.each(['/api/health', '/api/health/live', '/api/health/live?x=1'])(
    'skips %s',
    (url) => expect(isHealthProbe(url)).toBe(true),
  );

  it.each(['/api/healthz', '/api/health/livex', '/api/me', undefined])(
    'logs %s',
    (url) => expect(isHealthProbe(url)).toBe(false),
  );
});
