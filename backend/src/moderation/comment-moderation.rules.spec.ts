import {
  commentIsReply,
  type ConfigurableWorker,
  decisionStatusReason,
  isFinalAttempt,
  needsMeta,
  preClassifySkip,
  sameVersion,
  skipSetsStatus,
  startModerationWorker,
  statusWhenUnfinished,
} from './comment-moderation.rules.js';

const AT = new Date('2026-11-19T10:00:00.000Z');

const comment = (
  patch: Partial<Parameters<typeof preClassifySkip>[0]> = {},
): Parameters<typeof preClassifySkip>[0] => ({
  overriddenAt: null,
  deletedAt: null,
  status: 'PENDING',
  message: 'bKash e taka pathan',
  socialPageId: 'page-row',
  page: { metaPageId: '100', isActive: true },
  connectionStatus: 'ACTIVE',
  ...patch,
});

describe('comment moderation rules', () => {
  it('sameVersion compares edit times (null = original text)', () => {
    expect(sameVersion(null, null)).toBe(true);
    expect(sameVersion(AT, new Date(AT.getTime()))).toBe(true);
    expect(sameVersion(AT, null)).toBe(false);
    expect(sameVersion(AT, new Date(AT.getTime() + 1))).toBe(false);
  });

  describe('preClassifySkip (D13 + D10)', () => {
    it('classifies a live comment on an active Page (ACTIVE or NEEDS_REAUTH connection)', () => {
      expect(preClassifySkip(comment())).toBeNull();
      expect(
        preClassifySkip(comment({ connectionStatus: 'NEEDS_REAUTH' })),
      ).toBeNull();
    });

    it.each([
      [{ overriddenAt: AT, deletedAt: AT }, 'human_override'],
      [{ deletedAt: AT }, 'comment_deleted'],
      [{ status: 'DELETED' as const }, 'comment_deleted'],
      [{ message: null }, 'no_text'],
      [{ message: ' \n\t ' }, 'no_text'],
      [{ socialPageId: null, page: null }, 'page_disconnected'],
      [{ page: null }, 'page_disconnected'],
      [{ page: { metaPageId: '1', isActive: false } }, 'page_inactive'],
      [{ connectionStatus: 'REVOKED' as const }, 'connection_inactive'],
      [{ connectionStatus: null }, 'connection_inactive'],
    ])('%j → %s', (patch, reason) => {
      expect(preClassifySkip(comment(patch))).toBe(reason);
    });
  });

  it('only human_override (and the bookkeeping skips) leave the status alone', () => {
    expect(skipSetsStatus('human_override')).toBe(false);
    expect(skipSetsStatus('already_moderated')).toBe(false);
    expect(skipSetsStatus('stale_version')).toBe(false);
    expect(skipSetsStatus('comment_limit_reached')).toBe(true);
    expect(skipSetsStatus('no_active_plan')).toBe(true);
    expect(skipSetsStatus('no_text')).toBe(true);
  });

  it('statusWhenUnfinished keeps HIDDEN/DELETED (mirrors Meta), else the wanted status', () => {
    expect(statusWhenUnfinished('PENDING', 'FAILED')).toBe('FAILED');
    expect(statusWhenUnfinished('VISIBLE', 'SKIPPED')).toBe('SKIPPED');
    expect(statusWhenUnfinished('HIDDEN', 'FAILED')).toBe('HIDDEN');
    expect(statusWhenUnfinished('DELETED', 'SKIPPED')).toBe('DELETED');
  });

  it('commentIsReply reads Meta parent_id per platform', () => {
    expect(commentIsReply('FACEBOOK', '1_2', { parent_id: '1_2' })).toBe(false);
    expect(commentIsReply('FACEBOOK', '1_2', { parent_id: '2_3' })).toBe(true);
    expect(commentIsReply('FACEBOOK', '1_2', {})).toBe(false);
    expect(commentIsReply('INSTAGRAM', '9', { parent_id: '8' })).toBe(true);
    expect(commentIsReply('INSTAGRAM', '9', null)).toBe(false);
  });

  it('isFinalAttempt: attemptsMade is 0-based', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 5 } })).toBe(
      false,
    );
    expect(isFinalAttempt({ attemptsMade: 4, opts: { attempts: 5 } })).toBe(
      true,
    );
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true);
  });

  it('needsMeta / decisionStatusReason', () => {
    expect(
      needsMeta({ action: 'NONE', status: 'VISIBLE', reason: 'policy' }),
    ).toBe(false);
    expect(
      needsMeta({
        action: 'NONE',
        status: 'VISIBLE',
        reason: 'policy',
        reply: { language: 'bn', text: 'ধন্যবাদ' },
      }),
    ).toBe(true);
    expect(
      needsMeta({ action: 'HIDE', status: 'HIDDEN', reason: 'policy' }),
    ).toBe(true);
    expect(
      decisionStatusReason({
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        reason: 'below_threshold',
      }),
    ).toBe('below_threshold');
    expect(
      decisionStatusReason({
        action: 'HIDE',
        status: 'HIDDEN',
        reason: 'policy',
      }),
    ).toBeNull();
  });

  it('startModerationWorker applies concurrency + limiter, then runs once', async () => {
    const worker: ConfigurableWorker & { runs: number } = {
      concurrency: 1,
      opts: {},
      runs: 0,
      isRunning() {
        return this.runs > 0;
      },
      run() {
        this.runs += 1;
        return Promise.resolve();
      },
    };
    const settings = { concurrency: 3, limiter: { max: 7, duration: 2000 } };
    await startModerationWorker(worker, settings);
    expect(worker.concurrency).toBe(3);
    expect(worker.opts.limiter).toEqual({ max: 7, duration: 2000 });
    expect(startModerationWorker(worker, settings)).toBeNull();
    expect(worker.runs).toBe(1);
  });
});
