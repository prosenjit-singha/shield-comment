import {
  BadGatewayException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { Database } from '../db/database.js';
import * as liveQueries from '../wallet/live-subscription.queries.js';
import type { LiveSubscription } from '../wallet/live-subscription.queries.js';
import type {
  WorkspaceMetaConnection,
  WorkspacePage,
} from './dto/workspace-pages.dto.js';
import * as subscriptionQueries from './page-subscription.queries.js';
import type { PageSubscriptionService } from './page-subscription.service.js';
import * as queries from './social-pages.queries.js';
import {
  assertCanActivate,
  assertConnectionActive,
  assertLivePlan,
  connectedPagesLimit,
  SocialPagesService,
} from './social-pages.service.js';

vi.mock('./social-pages.queries.js', () => ({
  listWorkspacePages: vi.fn(),
  findWorkspacePage: vi.fn(),
  findWorkspaceBilling: vi.fn(),
  lockBillingAccount: vi.fn(),
  countPooledActivePages: vi.fn(),
  setPageActive: vi.fn(),
  findWorkspaceConnection: vi.fn(),
}));

vi.mock('../wallet/live-subscription.queries.js', () => ({
  findLiveSubscription: vi.fn(),
}));

vi.mock('./page-subscription.queries.js', () => ({
  findWorkspacePageToken: vi.fn(),
}));

const q = vi.mocked(queries);
const sq = vi.mocked(subscriptionQueries);
const lq = vi.mocked(liveQueries);
const WS = '019a0000-0000-7000-8000-000000000001';
const PAGE = '019a0000-0000-7000-8000-0000000000a1';
const PLAN = '019a0000-0000-7000-8000-0000000000c1';
const ACCOUNT = '019a0000-0000-7000-8000-0000000000b1';

const connection = (
  patch: Partial<WorkspaceMetaConnection> = {},
): WorkspaceMetaConnection => ({
  status: 'ACTIVE',
  statusChangedAt: new Date('2026-11-18T00:00:00.000Z'),
  tokenExpiresAt: new Date('2027-01-17T00:00:00.000Z'),
  ...patch,
});

const config = (connectedPages: unknown) => ({
  limits: { connectedPages, monthlyComments: 500, teamSeats: 1, workspaces: 1 },
  features: {},
});

/** The workspace's live subscription (PW-T5) with `connectedPages` normalised like the query. */
const live = (connectedPages: unknown): LiveSubscription => ({
  workspaceId: WS,
  billingAccountId: ACCOUNT,
  subscriptionId: '019a0000-0000-7000-8000-0000000000d1',
  status: 'TRIALING',
  interval: 'month',
  startedAt: new Date('2026-11-18T00:00:00.000Z'),
  trialEndsAt: new Date('2026-11-25T00:00:00.000Z'),
  currentTermStart: new Date('2026-11-18T00:00:00.000Z'),
  currentTermEnd: new Date('2026-11-25T00:00:00.000Z'),
  plan: {
    id: PLAN,
    slug: 'starter',
    featureConfig: normalizeFeatureConfig(config(connectedPages)),
    trialCommentLimit: 300,
  },
});

const page = (patch: Partial<WorkspacePage> = {}): WorkspacePage => ({
  id: PAGE,
  pageId: '1001',
  pageName: 'Shop',
  igBusinessId: null,
  igUsername: null,
  isActive: false,
  hasToken: true,
  createdAt: new Date('2026-11-18T00:00:00.000Z'),
  updatedAt: new Date('2026-11-18T00:00:00.000Z'),
  ...patch,
});

function setup(options: { configured?: boolean } = {}) {
  const tx = { tag: 'tx' };
  let transactions = 0;
  /** Order of Graph calls vs transactions, e.g. ['subscribe', 'tx']. */
  const order: string[] = [];
  const db = {
    tag: 'db',
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      transactions++;
      order.push('tx');
      return fn(tx);
    },
  };
  const subs = {
    configured: options.configured ?? true,
    subscribe: vi.fn<PageSubscriptionService['subscribe']>(async () => {
      order.push('subscribe');
      return { kind: 'subscribed' as const };
    }),
    unsubscribeBestEffort: vi.fn<
      PageSubscriptionService['unsubscribeBestEffort']
    >(async () => {
      order.push('unsubscribe');
      return true;
    }),
  };
  return {
    svc: new SocialPagesService(
      db as unknown as Database,
      subs as unknown as PageSubscriptionService,
    ),
    db,
    tx,
    subs,
    order,
    transactions: () => transactions,
  };
}

/** Error body as the AllExceptionsFilter would see it. */
async function conflictBody(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ConflictException);
  return (error as ConflictException).getResponse() as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('connectedPagesLimit (PW-T5)', () => {
  it('reads the live plan’s normalised limits.connectedPages', () => {
    expect(connectedPagesLimit(live(5))).toBe(5);
    expect(connectedPagesLimit(live(0))).toBe(0);
  });

  it('no live plan → 0 (no Free fallback); a malformed value is 0 (fail closed)', () => {
    expect(connectedPagesLimit(null)).toBe(0);
    expect(connectedPagesLimit(live(-1))).toBe(0);
    expect(connectedPagesLimit(live(1.5))).toBe(0);
    expect(connectedPagesLimit(live('3'))).toBe(0);
  });
});

describe('assertLivePlan (PW-T5)', () => {
  it('passes with a live plan', () => {
    expect(() => assertLivePlan(live(1))).not.toThrow();
  });

  it('no live plan → 409 NO_ACTIVE_PLAN without details', () => {
    let thrown: unknown;
    try {
      assertLivePlan(null);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    const body = (thrown as ConflictException).getResponse();
    expect(body).toMatchObject({ error: 'Conflict', code: 'NO_ACTIVE_PLAN' });
    expect(body).not.toHaveProperty('details');
    expect((body as { message: string }).message).toMatch(/plan/i);
  });
});

describe('assertCanActivate', () => {
  it('allows while active < limit', () => {
    expect(() => assertCanActivate({ limit: 1, activeCount: 0 })).not.toThrow();
    expect(() => assertCanActivate({ limit: 5, activeCount: 4 })).not.toThrow();
  });

  it('409 PAGE_LIMIT_REACHED with limit + activeCount at or over the limit', () => {
    for (const usage of [
      { limit: 1, activeCount: 1 },
      { limit: 5, activeCount: 7 },
      { limit: 0, activeCount: 0 },
    ]) {
      let thrown: unknown;
      try {
        assertCanActivate(usage);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getResponse()).toMatchObject({
        error: 'Conflict',
        code: 'PAGE_LIMIT_REACHED',
        details: usage,
      });
    }
  });
});

describe('assertConnectionActive (M4-T9, D9)', () => {
  it('passes only for an ACTIVE connection', () => {
    expect(() => assertConnectionActive(connection())).not.toThrow();
  });

  it.each([
    ['NEEDS_REAUTH', connection({ status: 'NEEDS_REAUTH' })],
    ['REVOKED', connection({ status: 'REVOKED' })],
    ['no connection', undefined],
  ])('%s → 409 CONNECTION_NEEDS_REAUTH', (_label, value) => {
    let thrown: unknown;
    try {
      assertConnectionActive(value);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    const body = (thrown as ConflictException).getResponse();
    expect(body).toMatchObject({
      error: 'Conflict',
      code: 'CONNECTION_NEEDS_REAUTH',
    });
    expect(body).not.toHaveProperty('details');
    expect((body as { message: string }).message).toMatch(/reconnect/i);
  });
});

describe('SocialPagesService.list', () => {
  it('returns the pages + the live plan limit and the pooled active count + the connection', async () => {
    const { svc, db } = setup();
    const items = [
      page({ isActive: true }),
      page({ id: 'b', isActive: false }),
      page({ id: 'c', isActive: true }),
    ];
    q.listWorkspacePages.mockResolvedValue(items);
    lq.findLiveSubscription.mockResolvedValue(live(5));
    // 2 on here + 1 in another workspace of the account.
    q.countPooledActivePages.mockResolvedValue(3);
    q.findWorkspaceConnection.mockResolvedValue(
      connection({ status: 'NEEDS_REAUTH', tokenExpiresAt: null }),
    );
    await expect(svc.list(WS)).resolves.toEqual({
      items,
      pageLimit: { limit: 5, activeCount: 3 },
      connection: {
        status: 'NEEDS_REAUTH',
        statusChangedAt: new Date('2026-11-18T00:00:00.000Z'),
        tokenExpiresAt: null,
      },
    });
    expect(q.findWorkspaceConnection).toHaveBeenCalledWith(db, WS);
    expect(q.listWorkspacePages).toHaveBeenCalledWith(db, WS);
    expect(lq.findLiveSubscription).toHaveBeenCalledWith(db, WS);
    expect(q.countPooledActivePages).toHaveBeenCalledWith(db, WS);
  });

  it('no live plan → limit 0 (pooled count still shown); no connection → connection null', async () => {
    const { svc } = setup();
    q.listWorkspacePages.mockResolvedValue([]);
    lq.findLiveSubscription.mockResolvedValue(null);
    q.countPooledActivePages.mockResolvedValue(2);
    q.findWorkspaceConnection.mockResolvedValue(undefined);
    await expect(svc.list(WS)).resolves.toEqual({
      items: [],
      pageLimit: { limit: 0, activeCount: 2 },
      connection: null,
    });
  });
});

describe('SocialPagesService.toggle', () => {
  const CIPHERTEXT = 'v1:k1:iv:tag:ct';

  function arm(options: {
    workspace?: { billingAccountId: string | null } | undefined;
    current?: WorkspacePage | undefined;
    /** `null` = no live plan. */
    limit?: unknown;
    activeCount?: number;
    connection?: WorkspaceMetaConnection | undefined;
  }) {
    q.findWorkspaceConnection.mockResolvedValue(
      'connection' in options ? options.connection : connection(),
    );
    q.findWorkspaceBilling.mockResolvedValue(
      'workspace' in options
        ? options.workspace
        : { billingAccountId: ACCOUNT },
    );
    q.lockBillingAccount.mockResolvedValue(true);
    q.findWorkspacePage.mockResolvedValue(
      'current' in options ? options.current : page(),
    );
    lq.findLiveSubscription.mockResolvedValue(
      options.limit === null ? null : live(options.limit ?? 1),
    );
    q.countPooledActivePages.mockResolvedValue(options.activeCount ?? 0);
    q.setPageActive.mockImplementation(async (_e, _w, _id, isActive) =>
      page({ isActive, updatedAt: new Date('2026-11-18T01:00:00.000Z') }),
    );
    sq.findWorkspacePageToken.mockResolvedValue({
      id: PAGE,
      workspaceId: WS,
      pageId: '1001',
      isActive: false,
      encryptedPageAccessToken: CIPHERTEXT,
    });
  }

  it('activates under the limit: pre-checks, subscribes, then locks workspace → page → account in one tx', async () => {
    const { svc, db, tx, subs, order, transactions } = setup();
    arm({ limit: 1, activeCount: 0 });
    const result = await svc.toggle(WS, PAGE, true);
    expect(result.changed).toBe(true);
    expect(result.page.isActive).toBe(true);
    expect(transactions()).toBe(1);
    // Pre-checks on the db (no locks), then Graph, then the tx.
    expect(q.findWorkspacePage).toHaveBeenNthCalledWith(1, db, WS, PAGE);
    expect(lq.findLiveSubscription).toHaveBeenNthCalledWith(1, db, WS);
    expect(q.countPooledActivePages).toHaveBeenNthCalledWith(1, db, WS);
    expect(sq.findWorkspacePageToken).toHaveBeenCalledWith(db, WS, PAGE);
    expect(subs.subscribe).toHaveBeenCalledWith({
      id: PAGE,
      workspaceId: WS,
      pageId: '1001',
      isActive: false,
      encryptedPageAccessToken: CIPHERTEXT,
    });
    expect(order).toEqual(['subscribe', 'tx']);
    expect(q.findWorkspaceBilling).toHaveBeenCalledWith(tx, WS, true);
    expect(q.findWorkspacePage).toHaveBeenCalledWith(tx, WS, PAGE, true);
    expect(q.lockBillingAccount).toHaveBeenCalledWith(tx, ACCOUNT);
    const txOrder = (mock: {
      mock: { calls: unknown[][]; invocationCallOrder: number[] };
    }) =>
      mock.mock.invocationCallOrder[
        mock.mock.calls.findIndex((args) => args[0] === tx)
      ]!;
    // Lock order workspace → page → account; plan + pooled count read under the account lock.
    expect(txOrder(q.findWorkspaceBilling)).toBeLessThan(
      txOrder(q.findWorkspacePage),
    );
    expect(txOrder(q.findWorkspacePage)).toBeLessThan(
      txOrder(q.lockBillingAccount),
    );
    expect(txOrder(q.lockBillingAccount)).toBeLessThan(
      txOrder(lq.findLiveSubscription),
    );
    expect(txOrder(q.lockBillingAccount)).toBeLessThan(
      txOrder(q.countPooledActivePages),
    );
    expect(lq.findLiveSubscription).toHaveBeenCalledWith(tx, WS);
    expect(q.countPooledActivePages).toHaveBeenCalledWith(tx, WS);
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, true);
    expect(subs.unsubscribeBestEffort).not.toHaveBeenCalled();
  });

  it('502 META_SUBSCRIBE_FAILED when Graph fails: no tx, no update', async () => {
    const { svc, subs, transactions } = setup();
    arm({});
    subs.subscribe.mockResolvedValue({
      kind: 'graph_failed',
      errorKind: 'transient',
      connectionMarked: false,
    });
    const error = await svc.toggle(WS, PAGE, true).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(BadGatewayException);
    expect((error as BadGatewayException).getStatus()).toBe(502);
    expect((error as BadGatewayException).getResponse()).toMatchObject({
      error: 'Bad Gateway',
      code: 'META_SUBSCRIBE_FAILED',
    });
    expect(transactions()).toBe(0);
    expect(q.setPageActive).not.toHaveBeenCalled();
    expect(subs.unsubscribeBestEffort).not.toHaveBeenCalled();
  });

  it('token_invalid is still a 502 (the subscription service marked the connection)', async () => {
    const { svc, subs, transactions } = setup();
    arm({});
    subs.subscribe.mockResolvedValue({
      kind: 'graph_failed',
      errorKind: 'token_invalid',
      connectionMarked: true,
    });
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(transactions()).toBe(0);
  });

  it('409 PAGE_TOKEN_MISSING when the stored token can’t be decrypted (reconnect), no tx', async () => {
    const { svc, subs, transactions } = setup();
    arm({});
    subs.subscribe.mockResolvedValue({ kind: 'undecryptable' });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'PAGE_TOKEN_MISSING' });
    expect(transactions()).toBe(0);
  });

  it('503 when Meta or the cipher is not configured, before any Graph call', async () => {
    const { svc, subs, transactions } = setup({ configured: false });
    arm({});
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(subs.subscribe).not.toHaveBeenCalled();
    expect(transactions()).toBe(0);
  });

  it('404 when the Page disappears between the pre-check and the token read', async () => {
    const { svc, subs } = setup();
    arm({});
    sq.findWorkspacePageToken.mockResolvedValue(undefined);
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(subs.subscribe).not.toHaveBeenCalled();
  });

  it('tx refuses after a successful subscribe (limit raced) → 409 + best-effort unsubscribe', async () => {
    const { svc, tx, subs, order } = setup();
    arm({ limit: 1 });
    // Pre-check sees 0 active; under the lock another Page is already on.
    q.countPooledActivePages.mockImplementation(async (executor) =>
      (executor as unknown) === tx ? 1 : 0,
    );
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'PAGE_LIMIT_REACHED' });
    expect(order).toEqual(['subscribe', 'tx', 'unsubscribe']);
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it.each([
    ['NEEDS_REAUTH', connection({ status: 'NEEDS_REAUTH' })],
    ['REVOKED', connection({ status: 'REVOKED' })],
    ['no connection', undefined],
  ])(
    'switch on with %s → 409 CONNECTION_NEEDS_REAUTH before the token/limit checks, no Graph, no tx',
    async (_label, value) => {
      const { svc, db, subs, transactions } = setup();
      // Also no token + over the limit: the connection check comes first.
      arm({
        connection: value,
        current: page({ hasToken: false }),
        limit: 0,
        activeCount: 3,
      });
      const body = await conflictBody(svc.toggle(WS, PAGE, true));
      expect(body).toMatchObject({ code: 'CONNECTION_NEEDS_REAUTH' });
      expect(q.findWorkspaceConnection).toHaveBeenCalledWith(db, WS);
      expect(q.countPooledActivePages).not.toHaveBeenCalled();
      expect(sq.findWorkspacePageToken).not.toHaveBeenCalled();
      expect(subs.subscribe).not.toHaveBeenCalled();
      expect(transactions()).toBe(0);
    },
  );

  it('connection turns NEEDS_REAUTH after the subscribe: in-tx re-check → 409 + best-effort unsubscribe', async () => {
    const { svc, tx, subs, order } = setup();
    arm({});
    q.findWorkspaceConnection.mockImplementation(async (executor) =>
      (executor as unknown) === (tx as unknown)
        ? connection({ status: 'NEEDS_REAUTH' })
        : connection(),
    );
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'CONNECTION_NEEDS_REAUTH' });
    expect(q.findWorkspaceConnection).toHaveBeenCalledWith(tx, WS);
    // Read under the workspace lock.
    const lockIdx = q.findWorkspaceBilling.mock.calls.findIndex(
      (args) => (args[0] as unknown) === tx,
    );
    const readIdx = q.findWorkspaceConnection.mock.calls.findIndex(
      (args) => (args[0] as unknown) === tx,
    );
    expect(
      q.findWorkspaceBilling.mock.invocationCallOrder[lockIdx]!,
    ).toBeLessThan(
      q.findWorkspaceConnection.mock.invocationCallOrder[readIdx]!,
    );
    expect(order).toEqual(['subscribe', 'tx', 'unsubscribe']);
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('switch off is allowed while NEEDS_REAUTH / REVOKED (no connection read)', async () => {
    for (const status of ['NEEDS_REAUTH', 'REVOKED'] as const) {
      vi.resetAllMocks();
      const { svc, tx } = setup();
      arm({
        current: page({ isActive: true }),
        connection: connection({ status }),
      });
      await expect(svc.toggle(WS, PAGE, false)).resolves.toMatchObject({
        changed: true,
        page: { isActive: false },
      });
      expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, false);
      expect(q.findWorkspaceConnection).not.toHaveBeenCalled();
    }
  });

  it('already on stays a no-op while NEEDS_REAUTH (no 409)', async () => {
    const { svc } = setup();
    const current = page({ isActive: true });
    arm({ current, connection: connection({ status: 'NEEDS_REAUTH' }) });
    await expect(svc.toggle(WS, PAGE, true)).resolves.toEqual({
      page: current,
      changed: false,
    });
  });

  it('switch off: tx first, then best-effort unsubscribe; its failure leaves the response', async () => {
    const { svc, tx, subs, order } = setup();
    arm({ current: page({ isActive: true }) });
    subs.unsubscribeBestEffort.mockImplementation(async () => {
      order.push('unsubscribe');
      return false;
    });
    const result = await svc.toggle(WS, PAGE, false);
    expect(result).toMatchObject({ changed: true, page: { isActive: false } });
    expect(order).toEqual(['tx', 'unsubscribe']);
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
    expect(subs.subscribe).not.toHaveBeenCalled();
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, false);
  });

  it('uses the live plan’s limit against the pooled count', async () => {
    const { svc } = setup();
    arm({ limit: 5, activeCount: 4 });
    await expect(svc.toggle(WS, PAGE, true)).resolves.toMatchObject({
      changed: true,
    });
  });

  it('409 PAGE_LIMIT_REACHED at the pooled limit: pre-check, no Graph, no tx', async () => {
    const { svc, subs, transactions } = setup();
    // The 1 active Page is in another workspace of the account.
    arm({ limit: 1, activeCount: 1 });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({
      code: 'PAGE_LIMIT_REACHED',
      details: { limit: 1, activeCount: 1 },
    });
    expect(q.setPageActive).not.toHaveBeenCalled();
    expect(subs.subscribe).not.toHaveBeenCalled();
    expect(transactions()).toBe(0);
  });

  it('409 NO_ACTIVE_PLAN without a live plan (pre-check): no Graph, no tx', async () => {
    const { svc, subs, transactions } = setup();
    arm({ limit: null, activeCount: 0 });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'NO_ACTIVE_PLAN' });
    expect(body).not.toHaveProperty('details');
    expect(subs.subscribe).not.toHaveBeenCalled();
    expect(transactions()).toBe(0);
  });

  it('plan ends between the pre-check and the tx → 409 NO_ACTIVE_PLAN + best-effort unsubscribe', async () => {
    const { svc, tx, subs, order } = setup();
    arm({});
    lq.findLiveSubscription.mockImplementation(async (executor) =>
      (executor as unknown) === tx ? null : live(1),
    );
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'NO_ACTIVE_PLAN' });
    expect(order).toEqual(['subscribe', 'tx', 'unsubscribe']);
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
    expect(q.countPooledActivePages).not.toHaveBeenCalledWith(tx, WS);
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('workspace without a billing account → 409 NO_ACTIVE_PLAN in the tx, no account lock', async () => {
    const { svc, subs } = setup();
    arm({ workspace: { billingAccountId: null } });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'NO_ACTIVE_PLAN' });
    expect(q.lockBillingAccount).not.toHaveBeenCalled();
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('NO_ACTIVE_PLAN comes after the connection and token checks', async () => {
    const { svc } = setup();
    arm({ limit: null, current: page({ hasToken: false }) });
    expect(await conflictBody(svc.toggle(WS, PAGE, true))).toMatchObject({
      code: 'PAGE_TOKEN_MISSING',
    });
    vi.resetAllMocks();
    const second = setup();
    arm({ limit: null, connection: undefined });
    expect(await conflictBody(second.svc.toggle(WS, PAGE, true))).toMatchObject(
      { code: 'CONNECTION_NEEDS_REAUTH' },
    );
  });

  it('switch off works without a live plan (no plan read)', async () => {
    const { svc, tx } = setup();
    arm({ current: page({ isActive: true }), limit: null });
    await expect(svc.toggle(WS, PAGE, false)).resolves.toMatchObject({
      changed: true,
      page: { isActive: false },
    });
    expect(lq.findLiveSubscription).not.toHaveBeenCalled();
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, false);
  });

  it('409 PAGE_TOKEN_MISSING when activating a Page without a token, before the limit check', async () => {
    const { svc, subs } = setup();
    arm({ current: page({ hasToken: false }) });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'PAGE_TOKEN_MISSING' });
    expect(body.message).toMatch(/reconnect/i);
    expect(q.countPooledActivePages).not.toHaveBeenCalled();
    expect(q.setPageActive).not.toHaveBeenCalled();
    expect(subs.subscribe).not.toHaveBeenCalled();
  });

  it('deactivates without any limit or token check (even over the limit)', async () => {
    const { svc, tx } = setup();
    arm({ current: page({ isActive: true }), limit: 0, activeCount: 9 });
    const result = await svc.toggle(WS, PAGE, false);
    expect(result).toMatchObject({ changed: true, page: { isActive: false } });
    expect(lq.findLiveSubscription).not.toHaveBeenCalled();
    expect(q.countPooledActivePages).not.toHaveBeenCalled();
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, false);
  });

  it('deactivates a Page without a token', async () => {
    const { svc } = setup();
    arm({ current: page({ isActive: true, hasToken: false }) });
    await expect(svc.toggle(WS, PAGE, false)).resolves.toMatchObject({
      changed: true,
    });
  });

  it('same value = no-op: changed false, no update, no Graph call, row returned as is', async () => {
    for (const isActive of [true, false]) {
      vi.resetAllMocks();
      const { svc, subs } = setup();
      const current = page({ isActive, hasToken: isActive });
      arm({ current, limit: 0, activeCount: 5 });
      await expect(svc.toggle(WS, PAGE, isActive)).resolves.toEqual({
        page: current,
        changed: false,
      });
      expect(q.setPageActive).not.toHaveBeenCalled();
      expect(q.countPooledActivePages).not.toHaveBeenCalled();
      expect(subs.subscribe).not.toHaveBeenCalled();
      expect(subs.unsubscribeBestEffort).not.toHaveBeenCalled();
    }
  });

  it('404 when the Page is not this workspace’s', async () => {
    const { svc } = setup();
    arm({ current: undefined });
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('404 when the workspace row is gone', async () => {
    const { svc } = setup();
    arm({ workspace: undefined });
    await expect(svc.toggle(WS, PAGE, false)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(q.findWorkspacePage).not.toHaveBeenCalled();
  });

  it('404 when the UPDATE matches no row (after subscribe → unsubscribe attempted)', async () => {
    const { svc, subs } = setup();
    arm({});
    q.setPageActive.mockResolvedValue(undefined);
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(subs.unsubscribeBestEffort).toHaveBeenCalledWith(WS, PAGE);
  });

  it('a non-HTTP error from the tx (DB down) is rethrown without unsubscribing', async () => {
    const { svc, subs } = setup();
    arm({});
    q.setPageActive.mockRejectedValue(new Error('connection lost'));
    await expect(svc.toggle(WS, PAGE, true)).rejects.toThrow('connection lost');
    expect(subs.unsubscribeBestEffort).not.toHaveBeenCalled();
  });
});
