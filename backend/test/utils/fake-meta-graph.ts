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
 * `unsubscribePageApp` (and `revokePermissions`, M4-T9 disconnect) answer like Meta's
 * `{ success: true }` by default; every other Graph method
 * throws, so a spec fails on any call it did not expect. Flip `enabled` to test "Meta unset".
 */
export function fakePageSubscriptionGraph() {
  return {
    enabled: true,
    graphApiVersion: 'v26.0',
    subscribePageApp: vi.fn<Fn<'subscribePageApp'>>(async () => undefined),
    unsubscribePageApp: vi.fn<Fn<'unsubscribePageApp'>>(async () => undefined),
    revokePermissions: vi.fn<Fn<'revokePermissions'>>(async () => undefined),
    buildLoginUrl: vi.fn<Fn<'buildLoginUrl'>>(unexpected('buildLoginUrl')),
    exchangeCode: vi.fn<Fn<'exchangeCode'>>(unexpected('exchangeCode')),
    exchangeForLongLivedToken: vi.fn<Fn<'exchangeForLongLivedToken'>>(
      unexpected('exchangeForLongLivedToken'),
    ),
    getMe: vi.fn<Fn<'getMe'>>(unexpected('getMe')),
    getPages: vi.fn<Fn<'getPages'>>(unexpected('getPages')),
    getPermissions: vi.fn<Fn<'getPermissions'>>(unexpected('getPermissions')),
    debugToken: vi.fn<Fn<'debugToken'>>(unexpected('debugToken')),
  };
}

export type FakePageSubscriptionGraph = ReturnType<
  typeof fakePageSubscriptionGraph
>;
