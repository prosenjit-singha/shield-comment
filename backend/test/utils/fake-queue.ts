import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { JobsOptions } from 'bullmq';
import {
  ALL_QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  type QueueName,
} from '../../src/queue/queue.constants.js';

export interface FakeJob {
  id: string;
  name: string;
  data: unknown;
  opts: JobsOptions;
}

/**
 * In-memory stand-in for a BullMQ `Queue` in e2e (no Redis). Records added jobs (a duplicate
 * `jobId` is ignored, like BullMQ), answers `getJobCounts` (`waiting` = recorded jobs + any
 * `setCounts` extra) and can be told to fail counts or adds (`failAdds`). Only the members the app uses exist; add more
 * when a row needs them.
 */
export class FakeQueue {
  readonly jobs: FakeJob[] = [];
  closed = false;
  private extraCounts: Record<string, number> = {};
  private countsError: Error | null = null;
  private addFailure: Error | 'hang' | null = null;
  private nextId = 1;

  constructor(readonly name: QueueName) {}

  add(name: string, data: unknown, opts: JobsOptions = {}): Promise<FakeJob> {
    if (this.addFailure === 'hang') return new Promise<never>(() => {});
    if (this.addFailure) return Promise.reject(this.addFailure);
    const merged: JobsOptions = { ...DEFAULT_JOB_OPTIONS, ...opts };
    const existing = merged.jobId
      ? this.jobs.find((job) => job.id === merged.jobId)
      : undefined;
    if (existing) return Promise.resolve(existing);
    const job: FakeJob = {
      id: merged.jobId ?? String(this.nextId++),
      name,
      data,
      opts: merged,
    };
    this.jobs.push(job);
    return Promise.resolve(job);
  }

  /** Like BullMQ: all or nothing (one MULTI); duplicate ids return the existing job. */
  addBulk(
    jobs: { name: string; data: unknown; opts?: JobsOptions }[],
  ): Promise<FakeJob[]> {
    if (this.addFailure === 'hang') return new Promise<never>(() => {});
    if (this.addFailure) return Promise.reject(this.addFailure);
    return Promise.all(
      jobs.map((job) => this.add(job.name, job.data, job.opts)),
    );
  }

  /** Makes `add`/`addBulk` reject with `error`, or never settle (`'hang'`, Redis down); `null` restores. */
  failAdds(failure: Error | 'hang' | null): void {
    this.addFailure = failure;
  }

  getJobCounts(...types: string[]): Promise<Record<string, number>> {
    if (this.countsError) return Promise.reject(this.countsError);
    const counts: Record<string, number> = {};
    for (const type of types) {
      counts[type] =
        (type === 'waiting' ? this.jobs.length : 0) +
        (this.extraCounts[type] ?? 0);
    }
    return Promise.resolve(counts);
  }

  /** Extra counts on top of the recorded jobs (e.g. `{ active: 2, failed: 1 }`). */
  setCounts(counts: Record<string, number>): void {
    this.extraCounts = { ...counts };
  }

  /** Makes `getJobCounts` reject (Redis down); `null` restores it. */
  failCounts(error: Error | null): void {
    this.countsError = error;
  }

  reset(): void {
    this.jobs.length = 0;
    this.extraCounts = {};
    this.countsError = null;
    this.addFailure = null;
  }

  on(): this {
    return this;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Replaces every registered BullMQ queue with a `FakeQueue` (the Bull factory never runs). */
export function overrideQueues(
  builder: TestingModuleBuilder,
): TestingModuleBuilder {
  for (const name of ALL_QUEUE_NAMES) {
    builder = builder
      .overrideProvider(getQueueToken(name))
      .useValue(new FakeQueue(name));
  }
  return builder;
}

/** The fake behind a queue of a `createTestApp()` app. */
export function fakeQueue(app: INestApplication, name: QueueName): FakeQueue {
  const queue: unknown = app.get(getQueueToken(name));
  if (!(queue instanceof FakeQueue)) {
    throw new Error(`Queue ${name} is not a FakeQueue`);
  }
  return queue;
}
