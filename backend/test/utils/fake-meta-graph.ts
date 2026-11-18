import type { MetaGraphClient } from '../../src/meta/meta-graph.client.js';

type Fn<K extends keyof MetaGraphClient> = MetaGraphClient[K] extends (
  ...args: infer A
) => infer R
  ? (...args: A) => R
  : never;

const unexpected = (name: string) => () => {
  throw new Error(`Unexpected MetaGraphClient.${name} call in this spec`);
};

/**
 * Stand-in for `MetaGraphClient` in specs that only toggle Pages (M4-T8): `subscribePageApp` /
 * `unsubscribePageApp` answer like Meta's `{ success: true }` by default; every other Graph method
 * throws, so a spec fails on any call it did not expect. Flip `enabled` to test "Meta unset".
 */
export function fakePageSubscriptionGraph() {
  return {
    enabled: true,
    graphApiVersion: 'v26.0',
    subscribePageApp: vi.fn<Fn<'subscribePageApp'>>(async () => undefined),
    unsubscribePageApp: vi.fn<Fn<'unsubscribePageApp'>>(async () => undefined),
    buildLoginUrl: vi.fn(unexpected('buildLoginUrl')),
    exchangeCode: vi.fn(unexpected('exchangeCode')),
    exchangeForLongLivedToken: vi.fn(unexpected('exchangeForLongLivedToken')),
    getMe: vi.fn(unexpected('getMe')),
    getPages: vi.fn(unexpected('getPages')),
    getPermissions: vi.fn(unexpected('getPermissions')),
    debugToken: vi.fn(unexpected('debugToken')),
  };
}

export type FakePageSubscriptionGraph = ReturnType<
  typeof fakePageSubscriptionGraph
>;
