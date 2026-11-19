import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Database } from '../db/database.js';
import * as pageQueries from '../meta/social-pages.queries.js';
import {
  ModerationPolicyService,
  workspacePlanFeatures,
} from './moderation-policy.service.js';
import * as queries from './moderation.queries.js';

vi.mock('../meta/social-pages.queries.js', () => ({
  findWorkspacePlanId: vi.fn(),
  findPlanFeatureConfig: vi.fn(),
}));

vi.mock('./moderation.queries.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./moderation.queries.js')>();
  return {
    ...actual,
    getOrCreateModerationPolicy: vi.fn(),
    lockModerationPolicy: vi.fn(),
    updateModerationPolicy: vi.fn(),
  };
});

const q = vi.mocked(queries);
const pq = vi.mocked(pageQueries);
const WS = '019a0000-0000-7000-8000-000000000001';
const PLAN = '019a0000-0000-7000-8000-0000000000c1';
const UPDATED_AT = new Date('2026-11-19T08:00:00.000Z');

/** A stored row with the column defaults. */
function row(
  patch: Partial<queries.ModerationPolicyRow> = {},
): queries.ModerationPolicyRow {
  const base: Record<string, unknown> = {
    workspaceId: WS,
    mode: 'AUTO',
    confidenceThreshold: 0.8,
    aiContextLevel: 'comment_only',
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
  };
  for (const key of [
    'safeInquiry',
    'competitorPoach',
    'scamPhishing',
    'spamIrrelevant',
    'abusiveToxic',
  ]) {
    base[`${key}Action`] = key === 'safeInquiry' ? 'NONE' : 'HIDE';
    base[`${key}AutoReply`] = false;
    base[`${key}ReplyEn`] = null;
    base[`${key}ReplyBn`] = null;
  }
  return { ...(base as queries.ModerationPolicyRow), ...patch };
}

const features = (autoReplyTemplates: boolean) => ({
  limits: { connectedPages: 1, monthlyComments: 500, teamSeats: 1 },
  features: { autoReplyTemplates },
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
  const service = new ModerationPolicyService(db as unknown as Database);
  return { service, db, tx, transactions: () => transactions };
}

beforeEach(() => {
  vi.resetAllMocks();
  pq.findWorkspacePlanId.mockResolvedValue({ planId: null });
  pq.findPlanFeatureConfig.mockResolvedValue(features(false));
  q.getOrCreateModerationPolicy.mockResolvedValue(row());
  q.lockModerationPolicy.mockResolvedValue(row());
});

describe('workspacePlanFeatures', () => {
  it('no plan → the Free plan lookup (planId null)', async () => {
    const db = {} as Database;
    expect(await workspacePlanFeatures(db, WS)).toEqual({
      autoReplyTemplates: false,
    });
    expect(pq.findPlanFeatureConfig).toHaveBeenCalledWith(db, null);
  });

  it('reads the workspace plan flag', async () => {
    pq.findWorkspacePlanId.mockResolvedValue({ planId: PLAN });
    pq.findPlanFeatureConfig.mockResolvedValue(features(true));
    expect(await workspacePlanFeatures({} as Database, WS)).toEqual({
      autoReplyTemplates: true,
    });
    expect(pq.findPlanFeatureConfig).toHaveBeenCalledWith({}, PLAN);
  });

  it('a missing plan row fails closed', async () => {
    pq.findPlanFeatureConfig.mockResolvedValue(undefined);
    expect(await workspacePlanFeatures({} as Database, WS)).toEqual({
      autoReplyTemplates: false,
    });
  });
});

describe('ModerationPolicyService', () => {
  it('get: lazy row + autoReplyAvailable', async () => {
    const { service, db } = setup();
    pq.findPlanFeatureConfig.mockResolvedValue(features(true));
    const res = await service.get(WS);
    expect(q.getOrCreateModerationPolicy).toHaveBeenCalledWith(db, WS);
    expect(res).toMatchObject({
      workspaceId: WS,
      mode: 'AUTO',
      confidenceThreshold: 0.8,
      aiContextLevel: 'comment_only',
      autoReplyAvailable: true,
      updatedAt: UPDATED_AT,
    });
    expect(res.categories.SCAM_PHISHING).toEqual({
      action: 'HIDE',
      autoReply: false,
      replyEn: null,
      replyBn: null,
    });
  });

  it('policy: the decision view', async () => {
    const { service } = setup();
    expect((await service.policy(WS)).categories.SAFE_INQUIRY.action).toBe(
      'NONE',
    );
  });

  it('update: empty body → 400 before any query', async () => {
    const { service, transactions } = setup();
    await expect(service.update(WS, {})).rejects.toThrow(BadRequestException);
    await expect(
      service.update(WS, { categories: { SAFE_INQUIRY: {} } }),
    ).rejects.toThrow('Nothing to update');
    expect(transactions()).toBe(0);
    expect(q.getOrCreateModerationPolicy).not.toHaveBeenCalled();
  });

  it('update: same values = no-op (no UPDATE, updatedAt kept)', async () => {
    const { service, tx } = setup();
    const res = await service.update(WS, {
      mode: 'AUTO',
      confidenceThreshold: 0.8,
      categories: { SCAM_PHISHING: { action: 'HIDE' } },
    });
    expect(res.changed).toBe(false);
    expect(res.updatedAt).toBe(UPDATED_AT);
    expect(q.getOrCreateModerationPolicy).toHaveBeenCalledWith(tx, WS);
    expect(q.lockModerationPolicy).toHaveBeenCalledWith(tx, WS);
    expect(q.updateModerationPolicy).not.toHaveBeenCalled();
  });

  it('update: writes the merged columns inside the tx after the lock', async () => {
    const { service, tx } = setup();
    const later = new Date('2026-11-19T09:00:00.000Z');
    q.updateModerationPolicy.mockResolvedValue(
      row({ scamPhishingAction: 'DELETE', mode: 'REVIEW', updatedAt: later }),
    );
    const res = await service.update(WS, {
      mode: 'REVIEW',
      categories: { SCAM_PHISHING: { action: 'DELETE' } },
    });
    expect(res).toMatchObject({
      changed: true,
      mode: 'REVIEW',
      updatedAt: later,
    });
    expect(res.categories.SCAM_PHISHING.action).toBe('DELETE');
    expect(q.updateModerationPolicy).toHaveBeenCalledWith(
      tx,
      WS,
      expect.objectContaining({
        mode: 'REVIEW',
        scamPhishingAction: 'DELETE',
        abusiveToxicAction: 'HIDE',
      }),
    );
    const lockOrder = q.lockModerationPolicy.mock.invocationCallOrder[0]!;
    expect(
      q.getOrCreateModerationPolicy.mock.invocationCallOrder[0],
    ).toBeLessThan(lockOrder);
    expect(lockOrder).toBeLessThan(
      q.updateModerationPolicy.mock.invocationCallOrder[0]!,
    );
  });

  it('update: 409 on a plan without autoReplyTemplates, nothing written', async () => {
    const { service } = setup();
    await expect(
      service.update(WS, {
        categories: {
          SAFE_INQUIRY: { autoReply: true, replyEn: 'Hi', replyBn: 'হাই' },
        },
      }),
    ).rejects.toThrow(ConflictException);
    expect(q.updateModerationPolicy).not.toHaveBeenCalled();
  });

  it('update: 400 when switching on without both texts', async () => {
    const { service } = setup();
    pq.findPlanFeatureConfig.mockResolvedValue(features(true));
    await expect(
      service.update(WS, {
        categories: { SAFE_INQUIRY: { autoReply: true, replyEn: 'Hi' } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(q.updateModerationPolicy).not.toHaveBeenCalled();
  });
});
