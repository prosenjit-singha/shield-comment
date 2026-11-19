import { readFileSync } from 'node:fs';
import type { INestApplication } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  findWorkspaceComment,
  incrementDailyCommentStats,
} from '../src/comments/comments.queries.js';
import {
  comments,
  dailyAiUsage,
  dailyCommentStats,
  moderationActions,
  moderationPolicies,
} from '../src/db/schema/index.js';
import { COMMENT_STATUSES } from '../src/moderation/moderation.constants.js';
import {
  completeModerationAction,
  defaultModerationPolicy,
  findAutoReplyAction,
  getOrCreateModerationPolicy,
  insertModerationAction,
  listCommentModerationActions,
  listDailyAiUsage,
  recordDailyAiUsage,
  reopenModerationAction,
  toModerationPolicy,
} from '../src/moderation/moderation.queries.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/** Postgres SQLSTATE of a failed query (Drizzle wraps the `pg` error in `cause`). */
async function pgCode(
  query: PromiseLike<unknown>,
): Promise<string | undefined> {
  try {
    await query;
  } catch (error) {
    const pgError = (error as { cause?: { code?: string } }).cause ?? error;
    return (pgError as { code?: string }).code;
  }
  return undefined;
}

const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

/**
 * M5-T7: moderation columns on `comments`, `moderation_actions`, `moderation_policies`, the new
 * `daily_comment_stats` counters and `daily_ai_usage` + the `moderation.queries.ts` helpers
 * (user decisions 2026-11-19 D3/D4/D5/D6/D8/D9/D10/D14). No routes yet (M5-T8+).
 */
describe('Moderation schema (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let a: Actor;
  let b: Actor;
  let commentA: string;
  let commentA2: string;
  let commentB: string;

  const base = `7${Date.now()}`;
  const page = `${base}1`;
  // Platform-wide usage rows: a model name unique to this run, deleted in afterAll.
  const model = `e2e-m5t7-${base}`;
  const db = () => actors.db;

  const classified = {
    category: 'SCAM_PHISHING',
    confidence: 0.912,
    reasoning: 'Fake bKash cashback offer with a phone number.',
    language: 'banglish',
    classifiedAt: new Date(),
    aiProvider: 'neon',
    model: 'gpt-oss-20b',
    promptVersion: 'moderation-v2',
    contextLevel: 'comment_only',
  } as const;

  async function insertCommentRow(workspaceId: string, n: number) {
    const [row] = await db()
      .insert(comments)
      .values({
        commentId: `${base}${n}_${base}${n + 1}`,
        workspaceId,
        platform: 'FACEBOOK',
        postId: `${page}_${n}`,
        message: 'bKash e 500 taka cashback',
      })
      .returning();
    return row!.id;
  }

  beforeAll(async () => {
    app = await createTestApp();
    actors = createAuthActors(app);
    a = await actors.signUp('m5t7-a');
    b = await actors.signUp('m5t7-b');
    commentA = await insertCommentRow(a.workspaceId, 10);
    commentA2 = await insertCommentRow(a.workspaceId, 20);
    commentB = await insertCommentRow(b.workspaceId, 30);
  });

  afterAll(async () => {
    if (actors) {
      await db().delete(dailyAiUsage).where(eq(dailyAiUsage.model, model));
      await actors.cleanup();
    }
    await app?.close();
  });

  it('migration 0016 is applied (journal count = applied rows)', async () => {
    const journal = JSON.parse(
      readFileSync(
        new URL('../drizzle/meta/_journal.json', import.meta.url),
        'utf8',
      ),
    ) as { entries: { tag: string }[] };
    expect(journal.entries.at(-1)?.tag).toBe('0016_moderation_schema');
    const result = await db().execute<{ applied: number }>(
      sql`select count(*)::int as applied from drizzle.__drizzle_migrations`,
    );
    expect(result.rows[0]?.applied).toBe(journal.entries.length);
  });

  describe('comments: statuses + classification', () => {
    it('every status is accepted; anything else is rejected', async () => {
      for (const status of COMMENT_STATUSES) {
        await db()
          .update(comments)
          .set({ status })
          .where(eq(comments.id, commentA2));
      }
      expect(
        await pgCode(
          db()
            .update(comments)
            .set({ status: 'BOGUS' as never })
            .where(eq(comments.id, commentA2)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('a full classification is stored and read back (confidence as a number)', async () => {
      await db()
        .update(comments)
        .set({
          ...classified,
          status: 'HIDDEN',
          creditsCharged: 1,
          statusReason: null,
        })
        .where(eq(comments.id, commentA));
      const [row] = await db()
        .select()
        .from(comments)
        .where(eq(comments.id, commentA));
      const read = await findWorkspaceComment(
        db(),
        a.workspaceId,
        row!.commentId,
      );
      expect(read).toMatchObject({
        ...classified,
        classifiedAt: expect.any(Date),
        status: 'HIDDEN',
        creditsCharged: 1,
        overriddenAt: null,
      });
      expect(typeof read!.confidence).toBe('number');
      expect(read!.confidence).toBe(0.912);
    });

    it.each([
      [
        'partial classification (category only)',
        { category: 'SPAM_IRRELEVANT' },
      ],
      ['unknown category', { ...classified, category: 'OTHER' }],
      ['confidence > 1', { ...classified, confidence: 1.5 }],
      ['confidence < 0', { ...classified, confidence: -0.1 }],
      ['reasoning > 280', { ...classified, reasoning: 'x'.repeat(281) }],
      ['reasoning without a classification', { reasoning: 'why' }],
      ['unknown language', { ...classified, language: 'fr' }],
      ['unknown provider', { ...classified, aiProvider: 'mistral' }],
      ['empty model', { ...classified, model: '' }],
      ['bad prompt version', { ...classified, promptVersion: 'V 2' }],
      ['unknown context level', { ...classified, contextLevel: 'everything' }],
      ['negative credits', { creditsCharged: -1 }],
      ['free-text status reason', { statusReason: 'The LLM said: no' }],
    ])('rejects %s', async (_label, values) => {
      expect(
        await pgCode(
          db()
            .update(comments)
            .set(values as never)
            .where(eq(comments.id, commentA2)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('accepts a status reason machine code and the human stamp', async () => {
      await db()
        .update(comments)
        .set({
          status: 'SKIPPED',
          statusReason: 'credits_exhausted',
          overriddenAt: new Date(),
        })
        .where(eq(comments.id, commentA2));
    });
  });

  describe('moderation_policies (D5 lazy defaults)', () => {
    it('getOrCreate creates the D3/D4/D6/D8 defaults once, even when called in parallel', async () => {
      const rows = await Promise.all(
        Array.from({ length: 5 }, () =>
          getOrCreateModerationPolicy(db(), a.workspaceId),
        ),
      );
      expect(new Set(rows.map((r) => r.workspaceId)).size).toBe(1);
      expect(toModerationPolicy(rows[0]!)).toEqual(
        defaultModerationPolicy(a.workspaceId),
      );
      const stored = await db()
        .select()
        .from(moderationPolicies)
        .where(eq(moderationPolicies.workspaceId, a.workspaceId));
      expect(stored).toHaveLength(1);
      expect(stored[0]!.confidenceThreshold).toBe(0.8);
    });

    it('an existing row is returned unchanged (no reset to defaults)', async () => {
      await db()
        .update(moderationPolicies)
        .set({ scamPhishingAction: 'DELETE', aiContextLevel: 'page_name' })
        .where(eq(moderationPolicies.workspaceId, a.workspaceId));
      const row = await getOrCreateModerationPolicy(db(), a.workspaceId);
      expect(row).toMatchObject({
        scamPhishingAction: 'DELETE',
        aiContextLevel: 'page_name',
      });
      // Tenant isolation: workspace B gets its own default row.
      const other = await getOrCreateModerationPolicy(db(), b.workspaceId);
      expect(toModerationPolicy(other)).toEqual(
        defaultModerationPolicy(b.workspaceId),
      );
    });

    it('auto-reply on with both texts is accepted', async () => {
      await db()
        .update(moderationPolicies)
        .set({
          safeInquiryAutoReply: true,
          safeInquiryReplyEn: 'Please check your inbox.',
          safeInquiryReplyBn: 'অনুগ্রহ করে ইনবক্স দেখুন।',
        })
        .where(eq(moderationPolicies.workspaceId, a.workspaceId));
    });

    it.each([
      ['unknown mode', { mode: 'OFF' }],
      ['threshold > 1', { confidenceThreshold: 1.5 }],
      ['threshold < 0', { confidenceThreshold: -0.2 }],
      ['unknown context level', { aiContextLevel: 'all' }],
      ['unknown action', { spamIrrelevantAction: 'BAN' }],
      ['auto-reply on without texts', { scamPhishingAutoReply: true }],
      [
        'auto-reply on with only en',
        { abusiveToxicAutoReply: true, abusiveToxicReplyEn: 'Hi' },
      ],
      ['empty reply text', { competitorPoachReplyEn: '' }],
      ['reply text > 500', { competitorPoachReplyBn: 'ক'.repeat(501) }],
    ])('rejects %s', async (_label, values) => {
      expect(
        await pgCode(
          db()
            .update(moderationPolicies)
            .set(values as never)
            .where(eq(moderationPolicies.workspaceId, b.workspaceId)),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('a policy needs an existing workspace', async () => {
      expect(
        await pgCode(
          getOrCreateModerationPolicy(
            db(),
            '0192f5a4-7c3e-7a10-8b2c-000000000000',
          ),
        ),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('moderation_actions (D10 log)', () => {
    it('insert is scoped by workspace: another workspace’s comment → undefined, nothing written', async () => {
      expect(
        await insertModerationAction(db(), {
          workspaceId: a.workspaceId,
          commentId: commentB,
          action: 'HIDE',
          source: 'AUTO',
        }),
      ).toBeUndefined();
      expect(
        await db()
          .select()
          .from(moderationActions)
          .where(eq(moderationActions.commentId, commentB)),
      ).toHaveLength(0);
    });

    it('PENDING → SUCCEEDED once; the wrong workspace cannot complete it', async () => {
      const action = await insertModerationAction(db(), {
        workspaceId: a.workspaceId,
        commentId: commentA,
        action: 'HIDE',
        source: 'AUTO',
      });
      expect(action).toMatchObject({
        state: 'PENDING',
        userId: null,
        errorKind: null,
        completedAt: null,
      });
      expect(
        await completeModerationAction(db(), b.workspaceId, action!.id, {
          state: 'SUCCEEDED',
        }),
      ).toBeUndefined();
      const done = await completeModerationAction(
        db(),
        a.workspaceId,
        action!.id,
        { state: 'SUCCEEDED' },
      );
      expect(done).toMatchObject({
        state: 'SUCCEEDED',
        completedAt: expect.any(Date),
      });
      // Finished actions are never rewritten.
      expect(
        await completeModerationAction(db(), a.workspaceId, action!.id, {
          state: 'FAILED',
          errorKind: 'transient',
        }),
      ).toBeUndefined();
    });

    it('a user action keeps the member; FAILED carries a kind and can be reopened', async () => {
      const action = await insertModerationAction(db(), {
        workspaceId: a.workspaceId,
        commentId: commentA,
        action: 'UNHIDE',
        source: 'USER',
        userId: a.id,
      });
      expect(action).toMatchObject({ source: 'USER', userId: a.id });
      const failed = await completeModerationAction(
        db(),
        a.workspaceId,
        action!.id,
        { state: 'FAILED', errorKind: 'rate_limited' },
      );
      expect(failed).toMatchObject({
        state: 'FAILED',
        errorKind: 'rate_limited',
      });
      expect(
        await reopenModerationAction(db(), b.workspaceId, action!.id),
      ).toBeUndefined();
      expect(
        await reopenModerationAction(db(), a.workspaceId, action!.id),
      ).toMatchObject({ state: 'PENDING', errorKind: null, completedAt: null });
      await expect(
        completeModerationAction(db(), a.workspaceId, action!.id, {
          state: 'FAILED',
          errorKind: 'Not A Code',
        }),
      ).rejects.toThrow('machine code');
    });

    it('D6: one auto-reply per comment (a second is a unique violation); its reply id is stored', async () => {
      const reply = await insertModerationAction(db(), {
        workspaceId: a.workspaceId,
        commentId: commentA,
        action: 'REPLY',
        source: 'AUTO',
      });
      expect(
        await pgCode(
          insertModerationAction(db(), {
            workspaceId: a.workspaceId,
            commentId: commentA,
            action: 'REPLY',
            source: 'AUTO',
          }),
        ),
      ).toBe(UNIQUE_VIOLATION);
      await completeModerationAction(db(), a.workspaceId, reply!.id, {
        state: 'SUCCEEDED',
        replyCommentId: `${base}10_${base}99`,
      });
      expect(
        await findAutoReplyAction(db(), a.workspaceId, commentA),
      ).toMatchObject({ id: reply!.id, replyCommentId: `${base}10_${base}99` });
      expect(
        await findAutoReplyAction(db(), b.workspaceId, commentA),
      ).toBeUndefined();
      // A human may still reply (not limited by the auto-reply index).
      expect(
        await insertModerationAction(db(), {
          workspaceId: a.workspaceId,
          commentId: commentA,
          action: 'REPLY',
          source: 'USER',
          userId: a.id,
        }),
      ).toBeDefined();
    });

    it('lists the comment’s actions oldest first, scoped by workspace', async () => {
      const list = await listCommentModerationActions(
        db(),
        a.workspaceId,
        commentA,
      );
      expect(list.map((r) => r.action)).toEqual([
        'HIDE',
        'UNHIDE',
        'REPLY',
        'REPLY',
      ]);
      expect(
        await listCommentModerationActions(db(), b.workspaceId, commentA),
      ).toEqual([]);
    });

    it.each([
      ['unknown action', { action: 'BAN' }],
      ['unknown source', { source: 'ROBOT' }],
      ['unknown state', { state: 'DONE', completedAt: new Date() }],
      ['AUTO with a user', { userId: 'self' }],
      ['FAILED without a kind', { state: 'FAILED', completedAt: new Date() }],
      [
        'free-text error kind',
        { state: 'FAILED', errorKind: 'Bad', completedAt: new Date() },
      ],
      ['kind on a PENDING action', { errorKind: 'transient' }],
      ['SUCCEEDED without completed_at', { state: 'SUCCEEDED' }],
      ['PENDING with completed_at', { completedAt: new Date() }],
      [
        'reply id on a HIDE',
        { state: 'SUCCEEDED', completedAt: new Date(), replyCommentId: '1_2' },
      ],
    ])('rejects %s', async (_label, patch) => {
      const values = {
        workspaceId: a.workspaceId,
        commentId: commentA2,
        action: 'HIDE',
        source: 'AUTO',
        ...patch,
      } as Record<string, unknown>;
      if (values.userId === 'self') values.userId = a.id;
      expect(
        await pgCode(
          db()
            .insert(moderationActions)
            .values(values as never),
        ),
      ).toBe(CHECK_VIOLATION);
    });

    it('FKs: unknown comment → 23503; a comment with actions cannot be deleted before them', async () => {
      expect(
        await pgCode(
          db().insert(moderationActions).values({
            workspaceId: a.workspaceId,
            commentId: '0192f5a4-7c3e-7a10-8b2c-000000000000',
            action: 'HIDE',
            source: 'AUTO',
          }),
        ),
      ).toBe(FK_VIOLATION);
      expect(
        await pgCode(db().delete(comments).where(eq(comments.id, commentA))),
      ).toBe(FK_VIOLATION);
    });
  });

  describe('daily_comment_stats moderation counters', () => {
    it('counters add up across calls and stay per key', async () => {
      const key = {
        workspaceId: a.workspaceId,
        pageId: page,
        platform: 'FACEBOOK' as const,
        day: '2026-11-19',
      };
      await incrementDailyCommentStats(db(), { ...key, received: 2 });
      await incrementDailyCommentStats(db(), {
        ...key,
        classified: 1,
        scamPhishing: 1,
        hidden: 1,
      });
      await Promise.all([
        incrementDailyCommentStats(db(), {
          ...key,
          classified: 1,
          safeInquiry: 1,
          replied: 1,
        }),
        incrementDailyCommentStats(db(), { ...key, skipped: 1 }),
        incrementDailyCommentStats(db(), { ...key, failed: 1, unhidden: 1 }),
      ]);
      const row = await incrementDailyCommentStats(db(), {
        ...key,
        deleted: 1,
        abusiveToxic: 1,
        competitorPoach: 1,
        spamIrrelevant: 1,
      });
      expect(row).toMatchObject({
        receivedCount: 2,
        editedCount: 0,
        removedCount: 0,
        classifiedCount: 2,
        safeInquiryCount: 1,
        competitorPoachCount: 1,
        scamPhishingCount: 1,
        spamIrrelevantCount: 1,
        abusiveToxicCount: 1,
        hiddenCount: 1,
        unhiddenCount: 1,
        deletedCount: 1,
        repliedCount: 1,
        skippedCount: 1,
        failedCount: 1,
      });
      expect(
        await pgCode(
          db()
            .update(dailyCommentStats)
            .set({ hiddenCount: -1 })
            .where(eq(dailyCommentStats.id, row.id)),
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  describe('daily_ai_usage (D14)', () => {
    const day = '2026-11-19';

    it('upserts add up (parallel too); failure kinds merge key by key; latency sum/max', async () => {
      await recordDailyAiUsage(db(), {
        day,
        provider: 'neon',
        model,
        calls: 1,
        inputTokens: 300,
        outputTokens: 40,
        credits: 1,
        latencyMs: 500,
      });
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          recordDailyAiUsage(db(), {
            day,
            provider: 'neon',
            model,
            calls: 1,
            inputTokens: 100,
            outputTokens: 10,
            credits: 2,
            latencyMs: 100 + i,
            failures: i % 2 === 0 ? { timeout: 1 } : {},
          }),
        ),
      );
      const row = await recordDailyAiUsage(db(), {
        day,
        provider: 'neon',
        model,
        calls: 1,
        latencyMs: 2000,
        failures: { invalid_output: 1 },
      });
      expect(row).toMatchObject({
        calls: 10,
        inputTokens: 1100,
        outputTokens: 120,
        credits: 17,
        failedCalls: 5,
        failuresByKind: { timeout: 4, invalid_output: 1 },
        latencyMsSum: 500 + 8 * 100 + 28 + 2000,
        latencyMsMax: 2000,
      });
      // Another provider + model = another row.
      await recordDailyAiUsage(db(), {
        day,
        provider: 'anthropic',
        model,
        calls: 1,
        failures: { auth: 1 },
      });
      const rows = (
        await listDailyAiUsage(db(), { from: day, to: day })
      ).filter((r) => r.model === model);
      expect(rows.map((r) => [r.provider, r.calls, r.failuresByKind])).toEqual([
        ['anthropic', 1, { auth: 1 }],
        ['neon', 10, { timeout: 4, invalid_output: 1 }],
      ]);
    });

    it.each([
      ['unknown provider', { provider: 'mistral' }],
      ['failed > calls', { calls: 1, failedCalls: 2 }],
      ['negative tokens', { inputTokens: -1 }],
      ['failures not an object', { failuresByKind: [1] }],
      ['empty model', { model: '' }],
    ])('rejects %s', async (_label, patch) => {
      expect(
        await pgCode(
          db()
            .insert(dailyAiUsage)
            .values({
              day: '2000-01-01',
              provider: 'neon',
              model,
              ...patch,
            } as never),
        ),
      ).toBe(CHECK_VIOLATION);
    });
  });

  it('cleanup() deletes moderation actions first, then policies, comments, stats, workspaces', async () => {
    const workspaceIds = [a.workspaceId, b.workspaceId];
    expect(
      (
        await db()
          .select()
          .from(moderationActions)
          .where(inArray(moderationActions.workspaceId, workspaceIds))
      ).length,
    ).toBeGreaterThan(0);
    await actors.cleanup();
    for (const table of [moderationActions, moderationPolicies, comments]) {
      expect(
        await db()
          .select()
          .from(table)
          .where(inArray(table.workspaceId, workspaceIds)),
      ).toEqual([]);
    }
    expect(
      await db()
        .select()
        .from(dailyCommentStats)
        .where(
          and(
            inArray(dailyCommentStats.workspaceId, workspaceIds),
            eq(dailyCommentStats.pageId, page),
          ),
        ),
    ).toEqual([]);
  });
});
