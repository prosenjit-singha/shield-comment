import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  ALL_QUEUE_NAMES,
  QUEUE_NAMES,
  type QueueName,
} from './queue.constants.js';

const ERROR_LOG_INTERVAL_MS = 5 * 60 * 1000;

export interface RegisteredQueue {
  name: QueueName;
  queue: Queue;
}

/**
 * Every registered BullMQ queue in one place (admin counts, later: a queue by name). Producers can
 * also inject a single queue with `@InjectQueue(name)`. `@nestjs/bullmq` closes the queues (and
 * any `@Processor` workers) on app shutdown; `main.ts` enables the shutdown hooks.
 */
@Injectable()
export class QueueRegistry implements OnModuleInit {
  private readonly logger = new Logger('Queues');
  private readonly queues: ReadonlyMap<QueueName, Queue>;
  /** Last error logged per queue: a Redis outage logs once per 5 min, not on every reconnect. */
  private readonly lastError = new Map<
    QueueName,
    { message: string; at: number }
  >();

  constructor(
    @InjectQueue(QUEUE_NAMES.commentIngest) commentIngest: Queue,
    @InjectQueue(QUEUE_NAMES.commentModeration) commentModeration: Queue,
    @InjectQueue(QUEUE_NAMES.metaTokenCheck) metaTokenCheck: Queue,
  ) {
    this.queues = new Map<QueueName, Queue>([
      [QUEUE_NAMES.commentIngest, commentIngest],
      [QUEUE_NAMES.commentModeration, commentModeration],
      [QUEUE_NAMES.metaTokenCheck, metaTokenCheck],
    ]);
  }

  onModuleInit(): void {
    // Without a listener BullMQ prints every connection error with console.error.
    for (const { name, queue } of this.all()) {
      queue.on('error', (error: Error) => {
        const last = this.lastError.get(name);
        const now = Date.now();
        if (
          last?.message === error.message &&
          now - last.at < ERROR_LOG_INTERVAL_MS
        ) {
          return;
        }
        this.lastError.set(name, { message: error.message, at: now });
        this.logger.warn(`Queue ${name}: ${error.message}`);
      });
    }
  }

  get(name: QueueName): Queue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`Unknown queue ${name}`);
    return queue;
  }

  all(): RegisteredQueue[] {
    return ALL_QUEUE_NAMES.map((name) => ({ name, queue: this.get(name) }));
  }
}
