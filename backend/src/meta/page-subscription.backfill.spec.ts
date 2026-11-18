import { backfillPageSubscriptions } from './page-subscription.backfill.js';
import type { Database } from '../db/database.js';
import * as queries from './page-subscription.queries.js';
import type { PageTokenRow } from './page-subscription.queries.js';
import type {
  PageSubscribeResult,
  PageSubscriptionService,
} from './page-subscription.service.js';

vi.mock('./page-subscription.queries.js', () => ({
  listActivePagesWithToken: vi.fn(),
}));

const q = vi.mocked(queries);
const db = { tag: 'db' } as unknown as Database;

const row = (n: number, token: string | null = `v1:k:${n}`): PageTokenRow => ({
  id: `019a0000-0000-7000-8000-00000000000${n}`,
  workspaceId: `019a0000-0000-7000-8000-0000000000${n}0`,
  pageId: `100${n}`,
  isActive: true,
  encryptedPageAccessToken: token,
});

function subs(results: PageSubscribeResult[], configured = true) {
  const subscribe = vi.fn<PageSubscriptionService['subscribe']>();
  for (const result of results) subscribe.mockResolvedValueOnce(result);
  return {
    subscribe,
    service: { configured, subscribe } as unknown as PageSubscriptionService,
  };
}

/** Serves `rows` page by page like the keyset query. */
function serve(rows: PageTokenRow[]) {
  q.listActivePagesWithToken.mockImplementation(async (_db, afterId, limit) => {
    const start =
      afterId === null ? 0 : rows.findIndex((r) => r.id === afterId) + 1;
    return rows.slice(start, start + limit);
  });
}

beforeEach(() => vi.resetAllMocks());

describe('backfillPageSubscriptions', () => {
  it('skips when Meta or the cipher is not configured (no DB read)', async () => {
    const { service } = subs([], false);
    await expect(backfillPageSubscriptions(db, service)).resolves.toEqual({
      kind: 'skipped',
      reason: 'not_configured',
    });
    expect(q.listActivePagesWithToken).not.toHaveBeenCalled();
  });

  it('subscribes every active Page across keyset pages, sequentially with a delay, and counts', async () => {
    const rows = [1, 2, 3, 4, 5].map((n) => row(n));
    serve(rows);
    const { service, subscribe } = subs([
      { kind: 'subscribed' },
      { kind: 'undecryptable' },
      {
        kind: 'graph_failed',
        errorKind: 'token_invalid',
        connectionMarked: true,
      },
      {
        kind: 'graph_failed',
        errorKind: 'token_invalid',
        connectionMarked: false,
      },
      { kind: 'subscribed' },
    ]);
    const wait = vi.fn(async () => undefined);
    const result = await backfillPageSubscriptions(db, service, {
      pageSize: 2,
      delayMs: 50,
      wait,
    });
    expect(result).toEqual({
      kind: 'done',
      counts: {
        pages: 5,
        subscribed: 2,
        failed: 2,
        undecryptable: 1,
        connectionsMarkedNeedsReauth: 1,
        notAttempted: 0,
      },
    });
    expect(subscribe.mock.calls.map(([page]) => page.id)).toEqual(
      rows.map((r) => r.id),
    );
    expect(subscribe).toHaveBeenCalledWith(rows[0]);
    // A pause between calls, none before the first.
    expect(wait).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledWith(50);
    expect(q.listActivePagesWithToken).toHaveBeenNthCalledWith(1, db, null, 2);
    expect(q.listActivePagesWithToken).toHaveBeenNthCalledWith(
      2,
      db,
      rows[1]!.id,
      2,
    );
    expect(q.listActivePagesWithToken).toHaveBeenCalledTimes(3);
  });

  it('a rate limit stops Graph calls; the rest is notAttempted', async () => {
    serve([1, 2, 3].map((n) => row(n)));
    const { service, subscribe } = subs([
      {
        kind: 'graph_failed',
        errorKind: 'rate_limited',
        connectionMarked: false,
      },
    ]);
    const result = await backfillPageSubscriptions(db, service, {
      wait: async () => undefined,
    });
    expect(result).toMatchObject({
      counts: { pages: 3, failed: 1, notAttempted: 2, subscribed: 0 },
    });
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('no active Pages → zero counts, no Graph call', async () => {
    serve([]);
    const { service, subscribe } = subs([]);
    await expect(backfillPageSubscriptions(db, service)).resolves.toEqual({
      kind: 'done',
      counts: {
        pages: 0,
        subscribed: 0,
        failed: 0,
        undecryptable: 0,
        connectionsMarkedNeedsReauth: 0,
        notAttempted: 0,
      },
    });
    expect(subscribe).not.toHaveBeenCalled();
  });
});
