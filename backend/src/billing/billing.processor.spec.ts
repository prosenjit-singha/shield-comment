import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  BILLING_SCHEDULED_JOBS,
  SUBSCRIPTION_EXPIRY_JOB_NAME,
} from './billing-scheduled.jobs.js';
import {
  type BillingJobOutcome,
  BillingProcessor,
} from './billing.processor.js';
import type { CheckoutService } from './checkout.service.js';
import type { RenewalReminderService } from './renewal-reminder.service.js';
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
  }) as unknown as Job<unknown, BillingJobOutcome>;

const pgError = (code: string) =>
  Object.assign(new Error('Failed query'), {
    cause: Object.assign(new Error('x'), { code }),
  });

describe('BillingProcessor (PW-T3, M8-T6)', () => {
  const expireDue = vi.fn<ExpireDue>();
  const switchScheduled = vi.fn<SubscriptionService['switchScheduled']>();
  const run = vi.fn<RenewalReminderService['run']>();
  const expirePendingPayments =
    vi.fn<CheckoutService['expirePendingPayments']>();
  let logs: string[];
  const processor = () =>
    new BillingProcessor(
      { expireDue, switchScheduled } as unknown as SubscriptionService,
      { run } as unknown as RenewalReminderService,
      { expirePendingPayments } as unknown as CheckoutService,
    );

  beforeEach(() => {
    expireDue.mockReset();
    switchScheduled.mockReset().mockResolvedValue(0);
    run.mockReset();
    expirePendingPayments.mockReset();
    logs = [];
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('job contract: three schedulers on the billing queue, stable ids, no colon in the names', () => {
    expect(QUEUE_NAMES.billing).toBe('billing');
    expect(BILLING_SCHEDULED_JOBS).toEqual([
      {
        schedulerId: 'subscription-expiry-15min',
        name: 'subscription-expiry',
        pattern: '*/15 * * * *',
      },
      {
        schedulerId: 'renewal-reminders-daily',
        name: 'renewal-reminders',
        pattern: '0 10 * * *',
      },
      {
        schedulerId: 'pending-payment-expiry-15min',
        name: 'pending-payment-expiry',
        pattern: '*/15 * * * *',
      },
    ]);
  });

  it('subscription-expiry → switchScheduled() then expireDue(), returns both counts', async () => {
    const order: string[] = [];
    switchScheduled.mockImplementation(async () => {
      order.push('switch');
      return 1;
    });
    expireDue.mockImplementation(async () => {
      order.push('expire');
      return 3;
    });
    await expect(processor().process(job())).resolves.toEqual({
      kind: 'subscription_expiry',
      switched: 1,
      expired: 3,
    });
    expect(order).toEqual(['switch', 'expire']);
    expect(expireDue).toHaveBeenCalledWith();
  });

  it('renewal-reminders → RenewalReminderService.run(); pending-payment-expiry → expirePendingPayments()', async () => {
    run.mockResolvedValue({
      kind: 'renewal_reminders',
      sent: 2,
      skipped: 0,
      failed: 0,
    });
    await expect(
      processor().process(job({ name: 'renewal-reminders' })),
    ).resolves.toEqual({
      kind: 'renewal_reminders',
      sent: 2,
      skipped: 0,
      failed: 0,
    });
    expirePendingPayments.mockResolvedValue(4);
    await expect(
      processor().process(job({ name: 'pending-payment-expiry' })),
    ).resolves.toEqual({ kind: 'pending_payment_expiry', cancelled: 4 });
    expect(expireDue).not.toHaveBeenCalled();
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
