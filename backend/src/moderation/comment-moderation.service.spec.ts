import type { MockInstance } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Database } from '../db/database.js';
import type { WalletService } from '../wallet/wallet.service.js';
import type {
  ClassificationFailure,
  ClassificationSuccess,
  CommentClassifier,
} from './comment-classifier.js';
import {
  clearCommentCounted,
  findWorkspaceBillingAccountId,
  lockModerationComment,
  markCommentCounted,
  type ModerationComment,
  updateModerationState,
} from './comment-moderation.queries.js';
import {
  CommentModerationService,
  ModerationStepError,
} from './comment-moderation.service.js';
import type { ModerationActionExecutor } from './moderation-action.executor.js';
import type { ModerationPolicyService } from './moderation-policy.service.js';
import { defaultModerationPolicy } from './moderation.queries.js';
import type { PostContextService } from './post-context.service.js';

vi.mock('./comment-moderation.queries.js', () => ({
  lockModerationComment: vi.fn(),
  updateModerationState: vi.fn(),
  findAutoActionFlags: vi.fn(),
  markCommentCounted: vi.fn(),
  clearCommentCounted: vi.fn(),
  findWorkspaceBillingAccountId: vi.fn(),
}));
vi.mock('../comments/comments.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  incrementDailyCommentStats: vi.fn(),
}));
vi.mock('./moderation.queries.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordDailyAiUsage: vi.fn(),
}));
vi.mock('./moderation-policy.service.js', () => ({
  ModerationPolicyService: class {},
  workspacePlanFeatures: vi.fn(async () => ({ autoReplyTemplates: false })),
}));

const WS = '019a0000-0000-7000-8000-00000000000a';
const ROW = '019a0000-0000-7000-8000-0000000000c1';
const ACCOUNT = '019a0000-0000-7000-8000-0000000000ac';
const NOW = new Date('2026-11-19T06:00:00.000Z');
const target = { workspaceId: WS, commentRowId: ROW, editedAt: null };

function comment(patch: Partial<ModerationComment> = {}): ModerationComment {
  return {
    id: ROW,
    workspaceId: WS,
    platform: 'FACEBOOK',
    postId: 'p_1',
    message: 'price koto?',
    rawPayload: null,
    status: 'PENDING',
    editedAt: null,
    deletedAt: null,
    overriddenAt: null,
    moderationStage: 'classify',
    usageCountedAt: null,
    category: null,
    confidence: null,
    language: null,
    socialPageId: 'sp_1',
    page: { metaPageId: 'page_1', isActive: true },
    connectionStatus: 'ACTIVE',
    ...patch,
  };
}

const success: ClassificationSuccess = {
  ok: true,
  category: 'SAFE_INQUIRY',
  confidence: 0.97,
  reasoning: 'A price question.',
  language: 'banglish',
  contextLevel: 'comment_only',
  promptVersion: 'v1',
  provider: 'neon',
  model: 'm',
  outputMode: 'json_schema',
  usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
  latencyMs: 5,
  attempts: 1,
};

const noAnswer: ClassificationFailure = {
  ok: false,
  kind: 'transient',
  retryable: true,
  promptVersion: 'v1',
  attempts: 1,
  latencyMs: 5,
  provider: 'neon',
  model: 'm',
  status: 503,
};

/**
 * PW-T4 worker branches with a mocked `WalletService` (PW-D1/D2/D9): count once before the first
 * AI call, skip on `limit_reached` / `no_active_plan`, free re-checks, refund on the no-LLM paths.
 * The DB queries are mocked; the e2e spec runs the same flows against Postgres.
 */
describe('CommentModerationService usage counting (PW-T4)', () => {
  let wallet: {
    consume: ReturnType<typeof vi.fn<WalletService['consume']>>;
    refund: ReturnType<typeof vi.fn<WalletService['refund']>>;
  };
  let classify: ReturnType<typeof vi.fn<CommentClassifier['classify']>>;
  let service: CommentModerationService;
  let warn: MockInstance<Logger['warn']>;

  beforeEach(() => {
    vi.clearAllMocks();
    wallet = { consume: vi.fn(), refund: vi.fn(async () => true) };
    classify = vi.fn(async () => success);
    const db = {
      transaction: async <T>(fn: (tx: object) => Promise<T>) => fn({}),
    };
    const postContext = {
      forComment: vi.fn(async () => ({ pageName: null, postCaption: null })),
    };
    const policies = {
      policy: vi.fn(async () => defaultModerationPolicy(WS)),
    };
    service = new CommentModerationService(
      db as unknown as Database,
      policies as unknown as ModerationPolicyService,
      postContext as unknown as PostContextService,
      wallet as unknown as WalletService,
      { classify } as unknown as CommentClassifier,
      {} as ModerationActionExecutor,
    );
    vi.mocked(lockModerationComment).mockResolvedValue(comment());
    vi.mocked(updateModerationState).mockResolvedValue(true);
    vi.mocked(markCommentCounted).mockResolvedValue(true);
    vi.mocked(clearCommentCounted).mockResolvedValue(true);
    vi.mocked(findWorkspaceBillingAccountId).mockResolvedValue(ACCOUNT);
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  const run = (finalAttempt = false) =>
    service.moderate(target, { finalAttempt }, () => NOW);

  it('ok → counted once at the consume instant, then classified', async () => {
    wallet.consume.mockResolvedValue('ok');
    expect(await run()).toMatchObject({
      kind: 'moderated',
      classified: true,
      counted: true,
      status: 'VISIBLE',
    });
    expect(wallet.consume).toHaveBeenCalledWith(WS, 'monthlyComments', 1, NOW);
    expect(markCommentCounted).toHaveBeenCalledWith(
      expect.anything(),
      WS,
      ROW,
      NOW,
    );
    expect(classify).toHaveBeenCalledTimes(1);
    expect(wallet.refund).not.toHaveBeenCalled();
  });

  it('limit_reached → SKIPPED comment_limit_reached, no AI call, one warning per account per day', async () => {
    wallet.consume.mockResolvedValue('limit_reached');
    for (let i = 0; i < 3; i++) {
      expect(await run()).toEqual({
        kind: 'skipped',
        reason: 'comment_limit_reached',
      });
    }
    expect(classify).not.toHaveBeenCalled();
    expect(markCommentCounted).not.toHaveBeenCalled();
    expect(updateModerationState).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ stage: 'classify' }),
      { stage: null, status: 'SKIPPED', statusReason: 'comment_limit_reached' },
      NOW,
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(ACCOUNT);
    expect(String(warn.mock.calls[0]![0])).not.toContain('price');
    // A new Dhaka day warns again.
    await service.moderate(
      target,
      { finalAttempt: false },
      () => new Date('2026-11-20T06:00:00.000Z'),
    );
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('no_active_plan → SKIPPED no_active_plan, no AI call, no warning', async () => {
    wallet.consume.mockResolvedValue('no_active_plan');
    expect(await run()).toEqual({ kind: 'skipped', reason: 'no_active_plan' });
    expect(classify).not.toHaveBeenCalled();
    expect(updateModerationState).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { stage: null, status: 'SKIPPED', statusReason: 'no_active_plan' },
      NOW,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('already counted (edit re-check / retry) → runs without consuming', async () => {
    vi.mocked(lockModerationComment).mockResolvedValue(
      comment({ usageCountedAt: new Date('2026-11-18T00:00:00Z') }),
    );
    expect(await run()).toMatchObject({
      kind: 'moderated',
      classified: true,
      counted: false,
    });
    expect(wallet.consume).not.toHaveBeenCalled();
    expect(markCommentCounted).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('another run counted it first → this count is refunded, still classified', async () => {
    wallet.consume.mockResolvedValue('ok');
    vi.mocked(markCommentCounted).mockResolvedValue(false);
    expect(await run()).toMatchObject({ kind: 'moderated', counted: false });
    expect(wallet.refund).toHaveBeenCalledWith(WS, 'monthlyComments', 1, NOW);
    expect(clearCommentCounted).not.toHaveBeenCalled();
  });

  it('LLM never reached (no tokens) → refund at usage_counted_at + cleared, retried', async () => {
    wallet.consume.mockResolvedValue('ok');
    classify.mockResolvedValue(noAnswer);
    await expect(run()).rejects.toBeInstanceOf(ModerationStepError);
    expect(wallet.refund).toHaveBeenCalledWith(WS, 'monthlyComments', 1, NOW);
    expect(clearCommentCounted).toHaveBeenCalledWith(
      expect.anything(),
      WS,
      ROW,
      NOW,
      NOW,
    );
  });

  it('a non-AI error before/at the call → refund + cleared, error rethrown', async () => {
    wallet.consume.mockResolvedValue('ok');
    classify.mockRejectedValue(new Error('settings read failed'));
    await expect(run()).rejects.toThrow('settings read failed');
    expect(wallet.refund).toHaveBeenCalledWith(WS, 'monthlyComments', 1, NOW);
    expect(clearCommentCounted).toHaveBeenCalledTimes(1);
  });

  it('an answer with tokens (invalid output) stays counted: no refund', async () => {
    wallet.consume.mockResolvedValue('ok');
    classify.mockResolvedValue({
      ...noAnswer,
      kind: 'invalid_output',
      retryable: false,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
    await expect(run(true)).rejects.toBeInstanceOf(ModerationStepError);
    expect(wallet.refund).not.toHaveBeenCalled();
    expect(clearCommentCounted).not.toHaveBeenCalled();
  });

  it('a no-LLM failure on a re-check (counted before) refunds nothing', async () => {
    vi.mocked(lockModerationComment).mockResolvedValue(
      comment({ usageCountedAt: new Date('2026-11-18T00:00:00Z') }),
    );
    classify.mockResolvedValue(noAnswer);
    await expect(run()).rejects.toBeInstanceOf(ModerationStepError);
    expect(wallet.consume).not.toHaveBeenCalled();
    expect(wallet.refund).not.toHaveBeenCalled();
    expect(clearCommentCounted).not.toHaveBeenCalled();
  });
});
