import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';
import { BillingJobSchedulers } from './billing-job-schedulers.js';

type Upsert = Queue['upsertJobScheduler'];

describe('BillingJobSchedulers (PW-T3)', () => {
  const upsert = vi.fn<Upsert>();
  let logs: string[];
  const create = () =>
    new BillingJobSchedulers({
      upsertJobScheduler: upsert,
    } as unknown as Queue);

  beforeEach(() => {
    upsert.mockReset();
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('upserts subscription-expiry every 15 min in Asia/Dhaka with the D3 job options', async () => {
    upsert.mockResolvedValue(undefined as never);
    await create().register();
    expect(upsert.mock.calls).toEqual([
      [
        'subscription-expiry-15min',
        { pattern: '*/15 * * * *', tz: 'Asia/Dhaka' },
        {
          name: 'subscription-expiry',
          data: {},
          opts: { ...DEFAULT_JOB_OPTIONS },
        },
      ],
    ]);
    expect(logs).toEqual([
      'log: Job schedulers registered: subscription-expiry-15min',
    ]);
  });

  it('boot does not wait: onApplicationBootstrap returns before Redis answers', () => {
    upsert.mockReturnValue(new Promise<never>(() => {}));
    const registrar = create();
    expect(registrar.onApplicationBootstrap()).toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('Redis down: one warning after the timeout, late success logged', async () => {
    vi.useFakeTimers();
    let resolve!: () => void;
    const pending = new Promise<void>((r) => (resolve = r));
    upsert.mockReturnValue(pending as never);
    const registrar = create();
    registrar.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(5_000);
    await registrar.ready;
    expect(logs).toEqual([
      'warn: Job schedulers not registered yet (Redis did not answer within 5000 ms; still trying in the background)',
    ]);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(logs[1]).toBe(
      'log: Job schedulers registered late: subscription-expiry-15min',
    );
  });

  it('an upsert error is a warning, never a throw', async () => {
    upsert.mockRejectedValue(new Error('READONLY'));
    await expect(create().register()).resolves.toBeUndefined();
    expect(logs).toEqual([
      'warn: Job schedulers not registered yet (READONLY)',
    ]);
  });
});
