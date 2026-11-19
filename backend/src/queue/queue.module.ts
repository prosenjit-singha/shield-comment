import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { ALL_QUEUE_NAMES, bullRootOptions } from './queue.constants.js';
import { QueueRegistry } from './queue.registry.js';
import { RedisEvictionCheck } from './redis-eviction-check.js';

/**
 * BullMQ foundation (M4-T1, D3): root connection from `REDIS_URL`, the three D3 queues + `billing` (PW-T3) with the
 * default job options, `QueueRegistry` and the startup eviction-policy warning. Global, so any
 * module can `@InjectQueue(QUEUE_NAMES.x)` or declare a `@Processor(QUEUE_NAMES.x)` worker.
 * E2E replaces every queue with an in-memory fake (`test/utils/fake-queue.ts`).
 */
@Global()
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) =>
        bullRootOptions(config.get('REDIS_URL', { infer: true })),
    }),
    BullModule.registerQueue(...ALL_QUEUE_NAMES.map((name) => ({ name }))),
  ],
  providers: [QueueRegistry, RedisEvictionCheck],
  exports: [BullModule, QueueRegistry],
})
export class QueueModule {}
