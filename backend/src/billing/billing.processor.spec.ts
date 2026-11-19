import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  BILLING_SCHEDULED_JOBS,
  SUBSCRIPTION_EXPIRY_JOB_NAME,
} from './billing-scheduled.jobs.js';
import {
  BillingProcessor,
  type SubscriptionExpiryOutcome,
} from './billing.processor.js';
import type { SubscriptionService } from './subscription.service.js';

type ExpireDue = SubscriptionService['expireDue'];

const job = (overrides: Partial<Job> = {}) =>
  ({
    id: 'repeat:subscription-expiry-15min:1',
    name: SUBSCRIPTION_EXPIRY_JOB_NAME,
    data: {},
    opts: { attempts: 5 },
    attemptsMade: 0,
    ...overrides,
  }) as unknown as Job<unknown, SubscriptionExpiryOutcome>;

const pgError = (code: string) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('BillingProcessor (PW-T3)', () => {
  const expireDue = vi.fn<ExpireDue>();
  let logs: string[];
  const processor = () =>
    new BillingProcessor({ expireDue } as unknown as SubscriptionService);

  beforeEach(() => {
    expireDue.mockReset();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('job contract: one scheduler on the billing queue, stable id, no colon in the name', () => {
    expect(QUEUE_NAMES.billing).toBe('billing');
    expect(BILLING_SCHEDULED_JOBS).toEqual([
      {
        schedulerId: 'subscription-expiry-15min',
        name: 'subscription-expiry',
        pattern: '*/15 * * * *',
      },
    ]);
  });

  it('subscription-expiry → expireDue(), returns the count', async () => {
    expireDue.mockResolvedValue(3);
    await expect(processor().process(job())).resolves.toEqual({
      kind: 'subscription_expiry',
      expired: 3,
    });
    expect(expireDue).toHaveBeenCalledTimes(1);
    expect(expireDue).toHaveBeenCalledWith();
  });

  it('accepts null / missing data (scheduler ticks carry none)', async () => {
    expireDue.mockResolvedValue(0);
    await processor().process(job({ data: null }));
    await processor().process(job({ data: undefined }));
    expect(expireDue).toHaveBeenCalledTimes(2);
  });

  it('unknown name → UnrecoverableError, nothing run', async () => {
    await expect(
      processor().process(job({ name: 'nope' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(expireDue).not.toHaveBeenCalled();
    expect(logs).toContain(
      'warn: Job repeat:subscription-expiry-15min:1 rejected: unknown name',
    );
  });

  it('invalid data → UnrecoverableError', async () => {
    await expect(
      processor().process(job({ data: [1] })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(expireDue).not.toHaveBeenCalled();
  });

  it('a permanent DB error is not retried; a transient one is', async () => {
    expireDue.mockRejectedValueOnce(pgError('23514'));
    await expect(processor().process(job())).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(logs).toContain(
      'error: subscription-expiry rejected by the database (23514); not retried',
    );
    const transient = new Error('connection terminated');
    expireDue.mockRejectedValueOnce(transient);
    await expect(processor().process(job())).rejects.toBe(transient);
  });

  it('failed: warn while attempts remain, error on the last one', () => {
    const p = processor();
    p.onFailed(job({ attemptsMade: 1 }), new Error('boom'));
    p.onFailed(job({ attemptsMade: 5 }), new Error('boom'));
    expect(logs[0]).toMatch(
      /^warn: Job subscription-expiry .* \(attempt 1\/5\)/,
    );
    expect(logs[1]).toMatch(
      /^error: Job subscription-expiry .* \(attempt 5\/5\)/,
    );
  });

  it('worker errors are logged once per message per 5 min', () => {
    const p = processor();
    p.onError(new Error('ECONNREFUSED'));
    p.onError(new Error('ECONNREFUSED'));
    expect(logs).toEqual(['warn: Worker billing: ECONNREFUSED']);
  });
});
