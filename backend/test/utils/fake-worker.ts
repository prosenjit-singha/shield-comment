import { BullModule } from '@nestjs/bullmq';
import type { Type } from '@nestjs/common';

/**
 * Stand-in for BullMQ's `Worker` in e2e (M4-T5). `@nestjs/bullmq` builds one per `@Processor`
 * from the queue's connection; with `FakeQueue`s that would be BullMQ's default
 * `localhost:6379` (a dev Redis). `useFakeWorkers()` (called by `createTestApp()`) makes the
 * module build these instead: they record what they were given, never connect and never pull jobs.
 * Specs call the processor's `process(job)` directly.
 */
export class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  closed = false;
  readonly listeners = new Map<string, unknown[]>();

  constructor(
    readonly name: string,
    readonly processor: unknown,
    readonly opts: unknown,
  ) {
    FakeWorker.instances.push(this);
  }

  on(event: string, listener: unknown): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

/** Every `@Processor` built after this call gets a `FakeWorker` (process-wide static). */
export function useFakeWorkers(): void {
  BullModule.workerClass = FakeWorker as unknown as Type;
}
