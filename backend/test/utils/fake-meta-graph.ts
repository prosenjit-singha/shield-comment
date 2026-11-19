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
 * `{ success: true }` by default; every other Graph method (incl. the M5-T9 comment actions and
 * the M5-T10 `getPostCaption`) throws, so a spec fails on any call it did not expect. Flip `enabled` to test "Meta unset".
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
    hideComment: vi.fn<Fn<'hideComment'>>(unexpected('hideComment')),
    unhideComment: vi.fn<Fn<'unhideComment'>>(unexpected('unhideComment')),
    deleteComment: vi.fn<Fn<'deleteComment'>>(unexpected('deleteComment')),
    replyToComment: vi.fn<Fn<'replyToComment'>>(unexpected('replyToComment')),
    getPostCaption: vi.fn<Fn<'getPostCaption'>>(unexpected('getPostCaption')),
  };
}

export type FakePageSubscriptionGraph = ReturnType<
  typeof fakePageSubscriptionGraph
>;

/** Reply id the fake answers by default (FB-style `<commentId>_<replyId>`). */
export const FAKE_REPLY_ID = '2020000000000002_3030000000000003';

/**
 * Stand-in for `MetaGraphClient` in specs of the Meta action executor (M5-T9): `hideComment` /
 * `unhideComment` / `deleteComment` answer like Meta's `{ success: true }` and `replyToComment`
 * returns `{ id: FAKE_REPLY_ID }`; every other Graph method (OAuth, Pages, `subscribed_apps`, …)
 * throws, so a spec fails on any call it did not expect. Assert the exact arguments (platform,
 * Meta comment id, message, Page token) on the mocks.
 */
export function fakeCommentActionGraph() {
  const graph = fakePageSubscriptionGraph();
  graph.subscribePageApp.mockImplementation(unexpected('subscribePageApp'));
  graph.unsubscribePageApp.mockImplementation(unexpected('unsubscribePageApp'));
  graph.revokePermissions.mockImplementation(unexpected('revokePermissions'));
  graph.hideComment.mockImplementation(async () => undefined);
  graph.unhideComment.mockImplementation(async () => undefined);
  graph.deleteComment.mockImplementation(async () => undefined);
  graph.replyToComment.mockImplementation(async () => ({ id: FAKE_REPLY_ID }));
  return graph;
}

export type FakeCommentActionGraph = ReturnType<typeof fakeCommentActionGraph>;

/** Caption the post-context fake answers by default. */
export const FAKE_POST_CAPTION =
  'ঈদ অফার! Premium cotton panjabi, 1,250 taka. Inbox korun.';

/**
 * Stand-in for `MetaGraphClient` in specs of `PostContextService` (M5-T10): only `getPostCaption`
 * answers (`FAKE_POST_CAPTION` by default); every other Graph method throws, so a spec fails on
 * any call it did not expect. Assert the exact arguments (platform, post id, Page token).
 */
export function fakePostContextGraph() {
  const graph = fakePageSubscriptionGraph();
  graph.subscribePageApp.mockImplementation(unexpected('subscribePageApp'));
  graph.unsubscribePageApp.mockImplementation(unexpected('unsubscribePageApp'));
  graph.revokePermissions.mockImplementation(unexpected('revokePermissions'));
  graph.getPostCaption.mockImplementation(async () => FAKE_POST_CAPTION);
  return graph;
}

export type FakePostContextGraph = ReturnType<typeof fakePostContextGraph>;
