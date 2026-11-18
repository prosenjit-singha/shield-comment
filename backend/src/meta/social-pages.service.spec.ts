import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import type { WorkspacePage } from './dto/workspace-pages.dto.js';
import * as queries from './social-pages.queries.js';
import {
  assertCanActivate,
  connectedPagesLimit,
  SocialPagesService,
} from './social-pages.service.js';

vi.mock('./social-pages.queries.js', () => ({
  listWorkspacePages: vi.fn(),
  findWorkspacePage: vi.fn(),
  findWorkspacePlanId: vi.fn(),
  findPlanFeatureConfig: vi.fn(),
  countActivePages: vi.fn(),
  setPageActive: vi.fn(),
}));

const q = vi.mocked(queries);
const WS = '019a0000-0000-7000-8000-000000000001';
const PAGE = '019a0000-0000-7000-8000-0000000000a1';
const PLAN = '019a0000-0000-7000-8000-0000000000c1';

const config = (connectedPages: unknown) => ({
  limits: { connectedPages, monthlyComments: 500, teamSeats: 1 },
  features: {},
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

function setup() {
  const tx = { tag: 'tx' };
  let transactions = 0;
  const db = {
    tag: 'db',
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      transactions++;
      return fn(tx);
    },
  };
  return {
    svc: new SocialPagesService(db as unknown as Database),
    db,
    tx,
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
});

describe('connectedPagesLimit', () => {
  it('reads limits.connectedPages through normalizeFeatureConfig', () => {
    expect(connectedPagesLimit(config(5))).toBe(5);
    expect(connectedPagesLimit(config(0))).toBe(0);
  });

  it('fails closed (0) for a missing plan or a malformed value', () => {
    expect(connectedPagesLimit(undefined)).toBe(0);
    expect(connectedPagesLimit(null)).toBe(0);
    expect(connectedPagesLimit({})).toBe(0);
    expect(connectedPagesLimit(config(-1))).toBe(0);
    expect(connectedPagesLimit(config(1.5))).toBe(0);
    expect(connectedPagesLimit(config('3'))).toBe(0);
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

describe('SocialPagesService.list', () => {
  it('returns the pages + the plan limit and active count', async () => {
    const { svc, db } = setup();
    const items = [
      page({ isActive: true }),
      page({ id: 'b', isActive: false }),
      page({ id: 'c', isActive: true }),
    ];
    q.listWorkspacePages.mockResolvedValue(items);
    q.findWorkspacePlanId.mockResolvedValue({ planId: PLAN });
    q.findPlanFeatureConfig.mockResolvedValue(config(5));
    await expect(svc.list(WS)).resolves.toEqual({
      items,
      pageLimit: { limit: 5, activeCount: 2 },
    });
    expect(q.listWorkspacePages).toHaveBeenCalledWith(db, WS);
    expect(q.findWorkspacePlanId).toHaveBeenCalledWith(db, WS);
    expect(q.findPlanFeatureConfig).toHaveBeenCalledWith(db, PLAN);
  });

  it('no plan → the Free plan (planId null)', async () => {
    const { svc, db } = setup();
    q.listWorkspacePages.mockResolvedValue([]);
    q.findWorkspacePlanId.mockResolvedValue({ planId: null });
    q.findPlanFeatureConfig.mockResolvedValue(config(1));
    await expect(svc.list(WS)).resolves.toEqual({
      items: [],
      pageLimit: { limit: 1, activeCount: 0 },
    });
    expect(q.findPlanFeatureConfig).toHaveBeenCalledWith(db, null);
  });
});

describe('SocialPagesService.toggle', () => {
  function arm(options: {
    workspace?: { planId: string | null } | undefined;
    current?: WorkspacePage | undefined;
    limit?: unknown;
    activeCount?: number;
  }) {
    q.findWorkspacePlanId.mockResolvedValue(
      'workspace' in options ? options.workspace : { planId: null },
    );
    q.findWorkspacePage.mockResolvedValue(
      'current' in options ? options.current : page(),
    );
    q.findPlanFeatureConfig.mockResolvedValue(config(options.limit ?? 1));
    q.countActivePages.mockResolvedValue(options.activeCount ?? 0);
    q.setPageActive.mockImplementation(async (_e, _w, _id, isActive) =>
      page({ isActive, updatedAt: new Date('2026-11-18T01:00:00.000Z') }),
    );
  }

  it('activates under the limit: locks workspace then page in one tx, then updates', async () => {
    const { svc, tx, transactions } = setup();
    arm({ limit: 1, activeCount: 0 });
    const result = await svc.toggle(WS, PAGE, true);
    expect(result.changed).toBe(true);
    expect(result.page.isActive).toBe(true);
    expect(transactions()).toBe(1);
    expect(q.findWorkspacePlanId).toHaveBeenCalledWith(tx, WS, true);
    expect(q.findWorkspacePage).toHaveBeenCalledWith(tx, WS, PAGE, true);
    expect(q.findWorkspacePlanId.mock.invocationCallOrder[0]!).toBeLessThan(
      q.findWorkspacePage.mock.invocationCallOrder[0]!,
    );
    expect(q.findPlanFeatureConfig).toHaveBeenCalledWith(tx, null);
    expect(q.countActivePages).toHaveBeenCalledWith(tx, WS);
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, true);
  });

  it('uses the workspace plan’s limit when it has one', async () => {
    const { svc, tx } = setup();
    arm({ workspace: { planId: PLAN }, limit: 5, activeCount: 4 });
    await expect(svc.toggle(WS, PAGE, true)).resolves.toMatchObject({
      changed: true,
    });
    expect(q.findPlanFeatureConfig).toHaveBeenCalledWith(tx, PLAN);
  });

  it('409 PAGE_LIMIT_REACHED at the limit (no plan → Free limit), no update', async () => {
    const { svc } = setup();
    arm({ workspace: { planId: null }, limit: 1, activeCount: 1 });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({
      code: 'PAGE_LIMIT_REACHED',
      details: { limit: 1, activeCount: 1 },
    });
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('409 when the plan row is missing (limit 0, fail closed)', async () => {
    const { svc } = setup();
    arm({});
    q.findPlanFeatureConfig.mockResolvedValue(undefined);
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ details: { limit: 0, activeCount: 0 } });
  });

  it('409 PAGE_TOKEN_MISSING when activating a Page without a token, before the limit check', async () => {
    const { svc } = setup();
    arm({ current: page({ hasToken: false }) });
    const body = await conflictBody(svc.toggle(WS, PAGE, true));
    expect(body).toMatchObject({ code: 'PAGE_TOKEN_MISSING' });
    expect(body.message).toMatch(/reconnect/i);
    expect(q.countActivePages).not.toHaveBeenCalled();
    expect(q.setPageActive).not.toHaveBeenCalled();
  });

  it('deactivates without any limit or token check (even over the limit)', async () => {
    const { svc, tx } = setup();
    arm({ current: page({ isActive: true }), limit: 0, activeCount: 9 });
    const result = await svc.toggle(WS, PAGE, false);
    expect(result).toMatchObject({ changed: true, page: { isActive: false } });
    expect(q.findPlanFeatureConfig).not.toHaveBeenCalled();
    expect(q.countActivePages).not.toHaveBeenCalled();
    expect(q.setPageActive).toHaveBeenCalledWith(tx, WS, PAGE, false);
  });

  it('deactivates a Page without a token', async () => {
    const { svc } = setup();
    arm({ current: page({ isActive: true, hasToken: false }) });
    await expect(svc.toggle(WS, PAGE, false)).resolves.toMatchObject({
      changed: true,
    });
  });

  it('same value = no-op: changed false, no update, row returned as is', async () => {
    const { svc } = setup();
    for (const isActive of [true, false]) {
      vi.resetAllMocks();
      const current = page({ isActive, hasToken: isActive });
      arm({ current, limit: 0, activeCount: 5 });
      await expect(svc.toggle(WS, PAGE, isActive)).resolves.toEqual({
        page: current,
        changed: false,
      });
      expect(q.setPageActive).not.toHaveBeenCalled();
      expect(q.countActivePages).not.toHaveBeenCalled();
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

  it('404 when the UPDATE matches no row', async () => {
    const { svc } = setup();
    arm({});
    q.setPageActive.mockResolvedValue(undefined);
    await expect(svc.toggle(WS, PAGE, true)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
