import { Logger } from '@nestjs/common';
import {
  parseMaxmemoryPolicy,
  type RedisService,
} from '../redis/redis.service.js';
import { RedisEvictionCheck } from './redis-eviction-check.js';

function makeCheck(evictionPolicy: () => Promise<string | null>) {
  const redis = {
    evictionPolicy: vi.fn<() => Promise<string | null>>(evictionPolicy),
  };
  const warn = vi
    .spyOn(Logger.prototype, 'warn')
    .mockImplementation(() => undefined);
  return {
    check: new RedisEvictionCheck(redis as unknown as RedisService),
    redis,
    warn,
  };
}

describe('RedisEvictionCheck', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('noeviction → ok, no warning', async () => {
    const { check, warn } = makeCheck(async () => 'noeviction');
    await expect(check.check()).resolves.toBe('ok');
    expect(warn).not.toHaveBeenCalled();
  });

  it('another policy → warning naming it', async () => {
    const { check, warn } = makeCheck(async () => 'allkeys-lru');
    await expect(check.check()).resolves.toBe('wrong-policy');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"allkeys-lru"');
    expect(warn.mock.calls[0]?.[0]).toContain('noeviction');
  });

  it('policy not reported → unknown + warning', async () => {
    const { check, warn } = makeCheck(async () => null);
    await expect(check.check()).resolves.toBe('unknown');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('Redis error → unknown + warning, never throws', async () => {
    const { check, warn } = makeCheck(async () => {
      throw new Error('connect ECONNREFUSED');
    });
    await expect(check.check()).resolves.toBe('unknown');
    expect(warn.mock.calls[0]?.[0]).toContain('connect ECONNREFUSED');
  });

  it('a hanging Redis times out after 5 s', async () => {
    vi.useFakeTimers();
    const { check, warn } = makeCheck(() => new Promise(() => undefined));
    const result = check.check();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(result).resolves.toBe('unknown');
    expect(warn.mock.calls[0]?.[0]).toContain('timeout');
  });

  it('onApplicationBootstrap runs the check in the background (startup never waits or fails)', async () => {
    let finish: (policy: string) => void = () => undefined;
    const { check, redis, warn } = makeCheck(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    expect(check.onApplicationBootstrap()).toBeUndefined();
    expect(redis.evictionPolicy).toHaveBeenCalledTimes(1);
    finish('volatile-lru');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
  });
});

describe('parseMaxmemoryPolicy', () => {
  it('reads the field from INFO memory text (CRLF lines)', () => {
    const info =
      '# Memory\r\nused_memory:1024\r\nmaxmemory:0\r\nmaxmemory_policy:noeviction\r\nmem_fragmentation_ratio:1.2\r\n';
    expect(parseMaxmemoryPolicy(info)).toBe('noeviction');
    expect(parseMaxmemoryPolicy('maxmemory_policy:allkeys-lru\n')).toBe(
      'allkeys-lru',
    );
  });

  it('null when the field is missing or empty', () => {
    expect(parseMaxmemoryPolicy('# Memory\r\nused_memory:1\r\n')).toBeNull();
    expect(parseMaxmemoryPolicy('maxmemory_policy:\r\n')).toBeNull();
    expect(parseMaxmemoryPolicy('')).toBeNull();
  });
});
