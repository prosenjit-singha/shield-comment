import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { RedisModule } from '../redis/redis.module.js';
import { RedisService } from '../redis/redis.service.js';
import {
  ALL_QUEUE_NAMES,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from './queue.constants.js';
import { QueueModule } from './queue.module.js';
import { QueueRegistry } from './queue.registry.js';

/**
 * Real BullMQ wiring with no Redis behind it: port 1 refuses connections, so nothing is written
 * anywhere. Checks registration + options, and that closing the app closes every queue.
 */
describe('QueueModule wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers the D3 queues + billing with the default job options and closes them on shutdown', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ REDIS_URL: 'redis://127.0.0.1:1' })],
        }),
        RedisModule,
        QueueModule,
      ],
    })
      .overrideProvider(RedisService)
      .useValue({
        evictionPolicy: vi.fn().mockResolvedValue('noeviction'),
        onModuleDestroy: vi.fn(),
      })
      .compile();
    const app = moduleRef.createNestApplication();
    await app.init();

    const registry = app.get(QueueRegistry);
    const queues = ALL_QUEUE_NAMES.map((name) =>
      app.get<Queue>(getQueueToken(name)),
    );
    expect(registry.all().map(({ name }) => name)).toEqual([
      ...ALL_QUEUE_NAMES,
    ]);
    for (const [i, queue] of queues.entries()) {
      expect(queue).toBeInstanceOf(Queue);
      expect(queue.name).toBe(ALL_QUEUE_NAMES[i]);
      expect(queue.defaultJobOptions).toMatchObject(DEFAULT_JOB_OPTIONS);
      expect(queue.opts.connection).toMatchObject({
        url: 'redis://127.0.0.1:1',
        maxRetriesPerRequest: null,
      });
    }
    expect(registry.get(QUEUE_NAMES.commentIngest)).toBe(queues[0]);

    const closes = queues.map((queue) => vi.spyOn(queue, 'close'));
    await app.close();
    for (const close of closes) expect(close).toHaveBeenCalledTimes(1);
  });
});
