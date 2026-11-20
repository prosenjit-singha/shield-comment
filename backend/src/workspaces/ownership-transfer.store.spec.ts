import type { RedisService } from '../redis/redis.service.js';
import { RedisOwnershipTransferStore } from './ownership-transfer.store.js';

function fakeRedis(
  status = 'ready',
  incr: [Error | null, unknown] = [null, 3],
) {
  const multi = {
    set: vi.fn().mockReturnThis(),
    incr: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([[null, 'OK'], incr]),
  };
  const client = {
    status,
    connect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue('hash'),
    del: vi.fn().mockResolvedValue(1),
    multi: vi.fn(() => multi),
  };
  const store = new RedisOwnershipTransferStore({
    client,
  } as unknown as RedisService);
  return { client, multi, store };
}

describe('RedisOwnershipTransferStore', () => {
  it('put = SET EX, get = GET, del skips an empty list; connects a lazy client', async () => {
    const { client, store } = fakeRedis('wait');
    await store.put('k', 'v', 600);
    expect(client.connect).toHaveBeenCalled();
    expect(client.set).toHaveBeenCalledWith('k', 'v', 'EX', 600);
    expect(await store.get('k')).toBe('hash');
    await store.del();
    expect(client.del).not.toHaveBeenCalled();
    await store.del('a', 'b');
    expect(client.del).toHaveBeenCalledWith('a', 'b');
  });

  it('hit: SET NX EX starts the fixed window, INCR returns the count', async () => {
    const { multi, store } = fakeRedis();
    expect(await store.hit('tries', 600)).toBe(3);
    expect(multi.set).toHaveBeenCalledWith('tries', 0, 'EX', 600, 'NX');
    expect(multi.incr).toHaveBeenCalledWith('tries');
  });

  it('hit: a failed INCR throws', async () => {
    const { store } = fakeRedis('ready', [new Error('boom'), null]);
    await expect(store.hit('tries', 60)).rejects.toThrow('boom');
  });
});
