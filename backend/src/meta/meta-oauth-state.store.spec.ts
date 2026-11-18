import type { RedisService } from '../redis/redis.service.js';
import { metaOAuthStateKey } from './meta-oauth-state.js';
import { RedisMetaOAuthStateStore } from './meta-oauth-state.store.js';

const STATE = 'a'.repeat(43);
const DATA = {
  userId: 'user-1',
  workspaceId: '0192f5a4-7c3e-7a10-8b2c-3d4e5f6a7b8c',
  returnTo: '/onboarding' as const,
};

function fakeRedis(status = 'ready') {
  const client = {
    status,
    connect: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue('OK'),
    getdel: vi.fn().mockResolvedValue(null),
  };
  const store = new RedisMetaOAuthStateStore({
    client,
  } as unknown as RedisService);
  return { client, store };
}

describe('RedisMetaOAuthStateStore', () => {
  it('SETs the JSON under the hashed key with EX ttl + NX', async () => {
    const { client, store } = fakeRedis();
    await store.save(STATE, DATA, 600);
    expect(client.set).toHaveBeenCalledWith(
      metaOAuthStateKey(STATE),
      JSON.stringify(DATA),
      'EX',
      600,
      'NX',
    );
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('connects a lazy client first', async () => {
    const { client, store } = fakeRedis('wait');
    await store.save(STATE, DATA, 600);
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it('throws when the key already exists (NX refused)', async () => {
    const { client, store } = fakeRedis();
    client.set.mockResolvedValue(null);
    await expect(store.save(STATE, DATA, 600)).rejects.toThrow(
      'already exists',
    );
  });

  it('takes with GETDEL (single use) and parses the value', async () => {
    const { client, store } = fakeRedis();
    client.getdel.mockResolvedValueOnce(JSON.stringify(DATA));
    await expect(store.take(STATE)).resolves.toEqual(DATA);
    expect(client.getdel).toHaveBeenCalledWith(metaOAuthStateKey(STATE));
    await expect(store.take(STATE)).resolves.toBeNull();
  });

  it('returns null for a corrupt stored value', async () => {
    const { client, store } = fakeRedis();
    client.getdel.mockResolvedValueOnce('{"userId":1}');
    await expect(store.take(STATE)).resolves.toBeNull();
  });
});
