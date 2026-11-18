import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';
import { MetaJobSchedulers } from './meta-job-schedulers.js';

type Upsert = Queue['upsertJobScheduler'];

describe('MetaJobSchedulers', () => {
  const upsert = vi.fn<Upsert>();
  let logs: string[];
  const create = () =>
    new MetaJobSchedulers({ upsertJobScheduler: upsert } as unknown as Queue);

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

  it('upserts both schedulers in Asia/Dhaka with the D3 job options', async () => {
    upsert.mockResolvedValue(undefined as never);
    await create().register();
    expect(upsert.mock.calls).toEqual([
      [
        'meta-debug-token-daily',
        { pattern: '0 3 * * *', tz: 'Asia/Dhaka' },
        { name: 'debug-token', data: {}, opts: { ...DEFAULT_JOB_OPTIONS } },
      ],
      [
        'raw-payload-purge-daily',
        { pattern: '30 3 * * *', tz: 'Asia/Dhaka' },
        {
          name: 'raw-payload-purge',
          data: {},
          opts: { ...DEFAULT_JOB_OPTIONS },
        },
      ],
    ]);
    expect(logs).toEqual([
      'log: Job schedulers registered: meta-debug-token-daily, raw-payload-purge-daily',
    ]);
  });

  it('boot does not wait: onApplicationBootstrap returns before Redis answers', () => {
    upsert.mockReturnValue(new Promise<never>(() => {}));
    const registrar = create();
    expect(registrar.onApplicationBootstrap()).toBeUndefined();
    expect(upsert).toHaveBeenCalledTimes(2);
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
      'log: Job schedulers registered late: meta-debug-token-daily, raw-payload-purge-daily',
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
