import { Logger } from '@nestjs/common';
import {
  RedisThrottlerStorage,
  THROTTLE_KEY_PREFIX,
} from './redis-throttler-storage.js';

const TTL = 60_000;

describe('RedisThrottlerStorage', () => {
  let evalFn: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let now: number;
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    evalFn = vi.fn();
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    now = 1_000_000;
    storage = new RedisThrottlerStorage({ eval: evalFn } as never, () => now);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs one atomic INCR + PEXPIRE script on the prefixed key with the ttl in ms', async () => {
    evalFn.mockResolvedValue([1, TTL]);
    await storage.increment('global:ip:203.0.113.9', TTL, 60);
    expect(evalFn).toHaveBeenCalledTimes(1);
    const [script, numKeys, key, ttl] = evalFn.mock.calls[0] as unknown[];
    expect(script).toContain("redis.call('INCR', KEYS[1])");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], ARGV[1])");
    expect(numKeys).toBe(1);
    expect(key).toBe(`${THROTTLE_KEY_PREFIX}global:ip:203.0.113.9`);
    expect(ttl).toBe(TTL);
  });

  it('returns the hits and the TTL left in seconds (rounded up), not blocked up to the limit', async () => {
    evalFn.mockResolvedValue([60, 41_200]);
    await expect(storage.increment('k', TTL, 60)).resolves.toEqual({
      totalHits: 60,
      timeToExpire: 42,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });

  it('blocks the request past the limit until the window ends', async () => {
    evalFn.mockResolvedValue([61, 41_200]);
    await expect(storage.increment('k', TTL, 60)).resolves.toEqual({
      totalHits: 61,
      timeToExpire: 42,
      isBlocked: true,
      timeToBlockExpire: 42,
    });
  });

  it('never reports less than 1 s left', async () => {
    evalFn.mockResolvedValue([2, 3]);
    const record = await storage.increment('k', TTL, 1);
    expect(record.timeToBlockExpire).toBe(1);
  });

  it('Redis error → allows the request and warns once per window', async () => {
    evalFn.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const allow = {
      totalHits: 0,
      timeToExpire: 0,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
    await expect(storage.increment('k', TTL, 1)).resolves.toEqual(allow);
    now += TTL - 1;
    await expect(storage.increment('k', TTL, 1)).resolves.toEqual(allow);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('ECONNREFUSED');
    now += 1;
    await storage.increment('k', TTL, 1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('unexpected reply → allows', async () => {
    evalFn.mockResolvedValue('OK');
    const record = await storage.increment('k', TTL, 1);
    expect(record.isBlocked).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('hanging Redis → allows after the timeout', async () => {
    vi.useFakeTimers();
    evalFn.mockReturnValue(new Promise(() => {}));
    const pending = storage.increment('k', TTL, 1);
    await vi.advanceTimersByTimeAsync(500);
    await expect(pending).resolves.toMatchObject({ isBlocked: false });
    expect(warn.mock.calls[0]?.[0]).toContain('timeout');
  });
});
