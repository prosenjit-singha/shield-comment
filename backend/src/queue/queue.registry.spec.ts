import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { QueueRegistry } from './queue.registry.js';

function fakeQueue(name: string): Queue {
  return Object.assign(new EventEmitter(), { name }) as unknown as Queue;
}

describe('QueueRegistry', () => {
  const ingest = fakeQueue('comment-ingest');
  const moderation = fakeQueue('comment-moderation');
  const tokenCheck = fakeQueue('meta-token-check');
  const billing = fakeQueue('billing');
  const alerts = fakeQueue('alerts');

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns each queue by name and all of them in D3 order', () => {
    const registry = new QueueRegistry(
      ingest,
      moderation,
      tokenCheck,
      billing,
      alerts,
    );
    expect(registry.get('comment-ingest')).toBe(ingest);
    expect(registry.get('comment-moderation')).toBe(moderation);
    expect(registry.get('meta-token-check')).toBe(tokenCheck);
    expect(registry.get('billing')).toBe(billing);
    expect(registry.get('alerts')).toBe(alerts);
    expect(registry.all()).toEqual([
      { name: 'comment-ingest', queue: ingest },
      { name: 'comment-moderation', queue: moderation },
      { name: 'meta-token-check', queue: tokenCheck },
      { name: 'billing', queue: billing },
      { name: 'alerts', queue: alerts },
    ]);
  });

  it('throws for an unknown queue name', () => {
    const registry = new QueueRegistry(
      ingest,
      moderation,
      tokenCheck,
      billing,
      alerts,
    );
    expect(() => registry.get('nope' as never)).toThrow('Unknown queue nope');
  });

  it('logs queue errors once per message per 5 min instead of crashing', () => {
    vi.useFakeTimers();
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const queues = [
      fakeQueue('comment-ingest'),
      fakeQueue('comment-moderation'),
      fakeQueue('meta-token-check'),
      fakeQueue('billing'),
      fakeQueue('alerts'),
    ] as const;
    const registry = new QueueRegistry(...queues);
    registry.onModuleInit();

    const refused = new Error('connect ECONNREFUSED 127.0.0.1:6379');
    // With a listener attached, emit('error') no longer throws.
    expect(() => queues[0].emit('error', refused)).not.toThrow();
    queues[0].emit('error', refused);
    queues[0].emit('error', refused);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(
      'Queue comment-ingest: connect ECONNREFUSED 127.0.0.1:6379',
    );

    // Another queue and another message each log.
    queues[2].emit('error', refused);
    queues[0].emit('error', new Error('READONLY'));
    expect(warn).toHaveBeenCalledTimes(3);

    // The same message again after 5 min logs again.
    vi.advanceTimersByTime(5 * 60 * 1000);
    queues[0].emit('error', new Error('READONLY'));
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
