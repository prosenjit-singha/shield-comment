import type { MockInstance } from 'vitest';
import { type INestApplication, Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { AiGatewayError } from '../src/ai-gateway/ai-gateway.errors.js';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.js';
import { CommentIngestProcessor } from '../src/comments/comment-ingest.processor.js';
import type { IngestOutcome } from '../src/comments/comment-ingest.service.js';
import { dhakaDayKey } from '../src/comments/comments.queries.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  comments,
  dailyAiUsage,
  dailyCommentStats,
  metaConnections,
  type MetaConnectionStatus,
  moderationActions,
  moderationPolicies,
  plans,
  socialPages,
  subscriptions,
  walletBalances,
  wallets,
  workspaces,
} from '../src/db/schema/index.js';
import { MetaGraphClient } from '../src/meta/meta-graph.client.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import {
  MODERATE_COMMENT_JOB_NAME,
  MODERATION_SWEEP_JOB_NAME,
  moderationJobId,
} from '../src/moderation/comment-moderation.job.js';
import { CommentModerationProcessor } from '../src/moderation/comment-moderation.processor.js';
import type { ModerationResult } from '../src/moderation/comment-moderation.service.js';
import { ModerationPolicyService } from '../src/moderation/moderation-policy.service.js';
import {
  ModerationJobSchedulers,
  ModerationSweeper,
} from '../src/moderation/comment-moderation.sweeper.js';
import type { ContextLevel } from '../src/moderation/moderation.constants.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { WalletService } from '../src/wallet/wallet.service.js';
import {
  COMMENT_INGEST_JOB_NAME,
  type CommentIngestJobData,
} from '../src/webhooks/comment-ingest.job.js';
import { parseMetaWebhookEnvelope } from '../src/webhooks/meta-webhook-envelope.js';
import {
  entry,
  envelope,
  fbCommentValue,
} from './fixtures/meta-webhook-payloads.js';
import {
  type Actor,
  createAuthActors,
  TRUSTED_ORIGIN,
} from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakeAiGateway } from './utils/fake-ai-gateway.js';
import {
  FAKE_REPLY_ID,
  fakeCommentActionGraph,
} from './utils/fake-meta-graph.js';
import { type FakeJob, fakeQueue } from './utils/fake-queue.js';
import { FakeWorker } from './utils/fake-worker.js';

/** Model name of the fake LLM answers: `daily_ai_usage` rows of this spec are deleted by it. */
const TEST_MODEL = 'm5t12-e2e-model';
const CAPTION = 'Eid offer! Premium panjabi 1,250 taka.';
const REPLY_BN = 'ধন্যবাদ! আমাদের পেজে ইনবক্স করুন।';
const REPLY_EN = 'Thanks! Please message our Page.';

/**
 * M5-T12: the `comment-moderation` worker against the real test DB (decisions D2, D3, D4, D6,
 * D8, D11, D13; PW-T4: PW-D1/D2/D9 monthly comments from the account wallet: every sign-up has a
 * live 7-day Starter trial with 300 comments). The LLM (`AiGatewayService`) and Meta (`MetaGraphClient`) are strict
 * fakes: an unexpected `chat` or Graph call throws, so "no AI call" / "no Graph call" are checked
 * by the fakes themselves. Jobs come from the real ingest worker's hand-off into the `FakeQueue`.
 */
describe('Comment moderation worker (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let ingestProcessor: CommentIngestProcessor;
  let processor: CommentModerationProcessor;
  const graph = fakeCommentActionGraph();
  const ai = fakeAiGateway();
  let a: Actor;
  let b: Actor;
  let pageA: { id: string; pageId: string; token: string };
  let pageB: { id: string; pageId: string; token: string };

  const db = () => actors.db;
  const base = `6${Date.now()}`;
  let seq = 100;
  const next = () => `${base}${seq++}`;
  /** Event times: now-ish (seconds), increasing, so every edit is newer than the last. */
  let clock = Math.floor(Date.now() / 1000) - 600;
  const tick = () => ++clock;

  const queue = () => fakeQueue(app, QUEUE_NAMES.commentModeration);

  async function insertConnection(actor: Pick<Actor, 'workspaceId'>) {
    const fbUserId = next();
    await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken: cipher.encrypt(
          `EAAuser${fbUserId}`,
          tokenCipherContext('meta_user_token', actor.workspaceId, fbUserId),
        ),
        grantedScopes: ['pages_manage_engagement'],
        status: 'ACTIVE',
      });
  }

  async function insertPage(workspaceId: string) {
    const pageId = next();
    const token = `EAApage${pageId}x`;
    const [row] = await db()
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: `Shop ${pageId}`,
        encryptedPageAccessToken: cipher.encrypt(
          token,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive: true,
      })
      .returning();
    return { id: row!.id, pageId, token };
  }

  /** One FB `feed` change on `pageId` as the receiver enqueues it. */
  function fbJob(
    pageId: string,
    value: Record<string, unknown>,
    time = tick(),
  ): CommentIngestJobData {
    const post =
      typeof value.post_id === 'string' ? value.post_id : `${pageId}_${base}9`;
    const body = envelope('page', [
      entry(
        pageId,
        [
          {
            field: 'feed',
            value: fbCommentValue({ post_id: post, parent_id: post, ...value }),
          },
        ],
        time,
      ),
    ]);
    return parseMetaWebhookEnvelope(JSON.stringify(body)).jobs[0]!.data;
  }

  const ingest = (data: CommentIngestJobData) =>
    ingestProcessor.process({
      id: data.eventId,
      name: COMMENT_INGEST_JOB_NAME,
      data,
      opts: { attempts: 5 },
      attemptsMade: 0,
    } as unknown as Job<unknown, IngestOutcome>);

  /** Ingests a new comment and returns its row id + the moderation job the hand-off enqueued. */
  async function newComment(
    page: { pageId: string } = pageA,
    message = 'bKash e 500 taka cashback, link e click korun',
  ) {
    const commentId = `${next()}_${next()}`;
    // A post of its own: the D8 caption cache (per post) never leaks between tests.
    const outcome = await ingest(
      fbJob(page.pageId, {
        comment_id: commentId,
        message,
        post_id: `${page.pageId}_${next()}`,
      }),
    );
    if (outcome.kind !== 'stored' || !outcome.commentRowId) {
      throw new Error('comment not stored');
    }
    return {
      rowId: outcome.commentRowId,
      metaId: commentId,
      job: jobFor(outcome.commentRowId, null),
    };
  }

  async function editComment(
    page: { pageId: string },
    metaId: string,
    message: string,
  ) {
    const outcome = await ingest(
      fbJob(page.pageId, { comment_id: metaId, verb: 'edited', message }),
    );
    if (outcome.kind !== 'stored' || !outcome.moderate) {
      throw new Error('edit not applied');
    }
    return jobFor(outcome.commentRowId!, outcome.editedAt ?? null);
  }

  function jobFor(rowId: string, editedAt: Date | null): FakeJob {
    const id = moderationJobId(rowId, editedAt);
    const job = queue().jobs.find((j) => j.id === id);
    if (!job) throw new Error(`no moderation job ${id}`);
    return job;
  }

  const run = (job: FakeJob, attemptsMade = 0) =>
    processor.process({
      ...job,
      attemptsMade,
    } as unknown as Job<
      unknown,
      ModerationResult
    >) as Promise<ModerationResult>;

  /** Arms one LLM answer. */
  const llm = (category: string, confidence = 0.95, language = 'banglish') =>
    ai.replyWith({
      model: TEST_MODEL,
      content: JSON.stringify({
        category,
        confidence_score: confidence,
        reasoning: 'Test reasoning.',
        language,
      }),
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    });

  const row = async (id: string) =>
    (await db().select().from(comments).where(eq(comments.id, id)))[0]!;
  const actionsOf = (id: string) =>
    db()
      .select()
      .from(moderationActions)
      .where(eq(moderationActions.commentId, id))
      .orderBy(moderationActions.createdAt);
  /** `monthlyComments` used in the account's current wallet period (PW-T4). */
  const used = async (workspaceId: string) => {
    const balance = await app.get(WalletService).balance(workspaceId);
    if (!balance) throw new Error('no live plan');
    return balance.used;
  };
  const accountOf = async (workspaceId: string) =>
    (
      await db()
        .select({ id: workspaces.billingAccountId })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    )[0]!.id!;
  /** Sets `used` of the account's `monthlyComments` balances (the live period). */
  const setUsed = async (workspaceId: string, value: number) => {
    const account = await accountOf(workspaceId);
    await db()
      .update(walletBalances)
      .set({ used: value })
      .where(
        and(
          eq(walletBalances.meter, 'monthlyComments'),
          inArray(
            walletBalances.walletId,
            db()
              .select({ id: wallets.id })
              .from(wallets)
              .where(eq(wallets.billingAccountId, account)),
          ),
        ),
      );
  };
  const included = async (workspaceId: string) =>
    (await app.get(WalletService).balance(workspaceId))!.included;
  const todayStats = async (workspaceId: string, pageId: string) =>
    (
      await db()
        .select()
        .from(dailyCommentStats)
        .where(
          and(
            eq(dailyCommentStats.workspaceId, workspaceId),
            eq(dailyCommentStats.pageId, pageId),
            eq(dailyCommentStats.day, dhakaDayKey()),
          ),
        )
    )[0];
  const setPolicy = (
    workspaceId: string,
    patch: Partial<typeof moderationPolicies.$inferInsert>,
  ) =>
    db()
      .update(moderationPolicies)
      .set(patch)
      .where(eq(moderationPolicies.workspaceId, workspaceId));
  const setConnection = (workspaceId: string, status: MetaConnectionStatus) =>
    db()
      .update(metaConnections)
      .set({ status })
      .where(eq(metaConnections.workspaceId, workspaceId));
  const graphCalls = () =>
    graph.hideComment.mock.calls.length +
    graph.unhideComment.mock.calls.length +
    graph.deleteComment.mock.calls.length +
    graph.replyToComment.mock.calls.length +
    graph.getPostCaption.mock.calls.length;

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(MetaGraphClient)
        .useValue(graph)
        .overrideProvider(AiGatewayService)
        .useValue(ai),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    ingestProcessor = app.get(CommentIngestProcessor);
    processor = app.get(CommentModerationProcessor);
    a = await actors.signUp('m5t12-a');
    b = await actors.signUp('m5t12-b');
    await insertConnection(a);
    await insertConnection(b);
    pageA = await insertPage(a.workspaceId);
    pageB = await insertPage(b.workspaceId);
    // Policy rows exist from the first use; create them now so `setPolicy` can edit them.
    await app.get(ModerationPolicyService).policy(a.workspaceId);
  });

  beforeEach(() => {
    ai.reset();
    graph.hideComment.mockClear();
    graph.unhideComment.mockClear();
    graph.deleteComment.mockClear();
    graph.replyToComment.mockClear();
    graph.getPostCaption.mockReset().mockImplementation(async () => {
      throw new Error('Unexpected MetaGraphClient.getPostCaption call');
    });
  });

  afterEach(() => {
    // Every armed LLM answer must have been used (no hidden extra or missing call).
    expect(ai.pending).toBe(0);
  });

  afterAll(async () => {
    if (actors) {
      await db().delete(dailyAiUsage).where(eq(dailyAiUsage.model, TEST_MODEL));
      await actors.cleanup();
    }
    await app?.close();
  });

  it('starts the worker itself with the env concurrency + limiter, registers the sweep', async () => {
    const worker = processor.worker as unknown as FakeWorker;
    expect(worker).toBeInstanceOf(FakeWorker);
    expect(worker.running).toBe(true);
    expect(worker.concurrency).toBe(4);
    expect(worker.opts).toMatchObject({
      autorun: false,
      limiter: { max: 10, duration: 1000 },
    });
    await app.get(ModerationJobSchedulers).ready;
    expect(await queue().getJobSchedulers()).toEqual([
      expect.objectContaining({
        id: 'comment-moderation-sweep',
        repeat: { pattern: '*/15 * * * *', tz: 'Asia/Dhaka' },
        template: expect.objectContaining({ name: MODERATION_SWEEP_JOB_NAME }),
      }),
    ]);
  });

  it('ingest → job → fake LLM → fake Graph hide: classified, HIDDEN, counted once, counts', async () => {
    const before = await todayStats(a.workspaceId, pageA.pageId);
    const usedBefore = await used(a.workspaceId);
    const { rowId, metaId, job } = await newComment();
    expect(job).toMatchObject({
      name: MODERATE_COMMENT_JOB_NAME,
      data: { workspaceId: a.workspaceId, commentRowId: rowId, editedAt: null },
      opts: { attempts: 5 },
    });
    expect((await row(rowId)).moderationStage).toBe('classify');

    llm('SCAM_PHISHING');
    const result = await run(job);
    expect(result).toEqual({
      kind: 'moderated',
      classified: true,
      counted: true,
      action: 'HIDE',
      status: 'HIDDEN',
      replied: false,
    });
    expect(graph.hideComment).toHaveBeenCalledWith(
      'FACEBOOK',
      metaId,
      pageA.token,
    );
    expect(await row(rowId)).toMatchObject({
      status: 'HIDDEN',
      statusReason: null,
      category: 'SCAM_PHISHING',
      confidence: 0.95,
      language: 'banglish',
      model: TEST_MODEL,
      contextLevel: 'comment_only',
      usageCountedAt: expect.any(Date),
      moderationStage: null,
    });
    // PW-D1: the comment counts 1 against the account's monthly comments.
    expect(await used(a.workspaceId)).toBe(usedBefore + 1);
    expect(await actionsOf(rowId)).toEqual([
      expect.objectContaining({
        action: 'HIDE',
        source: 'AUTO',
        state: 'SUCCEEDED',
      }),
    ]);
    const after = await todayStats(a.workspaceId, pageA.pageId);
    expect(after!.classifiedCount - (before?.classifiedCount ?? 0)).toBe(1);
    expect(after!.scamPhishingCount - (before?.scamPhishingCount ?? 0)).toBe(1);
    expect(after!.hiddenCount - (before?.hiddenCount ?? 0)).toBe(1);
    const [usage] = await db()
      .select()
      .from(dailyAiUsage)
      .where(eq(dailyAiUsage.model, TEST_MODEL));
    expect(usage).toMatchObject({
      provider: 'neon',
      calls: expect.any(Number),
    });
    expect(usage!.inputTokens).toBeGreaterThanOrEqual(120);
    // The LLM never sees the author (D8): only the comment text + platform + reply flag.
    const sent = JSON.stringify(ai.chat.mock.calls[0]![0]);
    expect(sent).not.toContain('Rahim');
  });

  it('duplicate job / re-delivered webhook = one action and one count', async () => {
    const { rowId, job } = await newComment();
    llm('SPAM_IRRELEVANT');
    await run(job);
    const counted = (await row(rowId)).usageCountedAt;
    const usedAfter = await used(a.workspaceId);
    expect(await run(job)).toEqual({
      kind: 'skipped',
      reason: 'already_moderated',
    });
    expect(await run(job, 3)).toEqual({
      kind: 'skipped',
      reason: 'already_moderated',
    });
    expect(await used(a.workspaceId)).toBe(usedAfter);
    expect((await row(rowId)).usageCountedAt).toEqual(counted);
    expect(await actionsOf(rowId)).toHaveLength(1);
    expect(graph.hideComment).toHaveBeenCalledTimes(1);
    // The hand-off of a second identical enqueue is ignored by the job id.
    const jobs = queue().jobs.filter((j) => j.id === job.id);
    expect(jobs).toHaveLength(1);
  });

  it('D11 + PW-D2: an edit is re-classified for free and an AI-hidden comment is un-hidden when safe', async () => {
    const { rowId, metaId, job } = await newComment();
    llm('SCAM_PHISHING');
    await run(job);
    expect((await row(rowId)).status).toBe('HIDDEN');
    const countedAt = (await row(rowId)).usageCountedAt;
    expect(countedAt).toBeInstanceOf(Date);
    const usedAfterFirst = await used(a.workspaceId);

    const editJob = await editComment(
      pageA,
      metaId,
      'Price koto? Size M ache?',
    );
    expect(editJob.id).toMatch(new RegExp(`^moderate:${rowId}:edit-\\d+$`));
    expect((await row(rowId)).moderationStage).toBe('classify');
    // The original version's job is stale now (a newer edit has its own job).
    expect(await run(job)).toEqual({
      kind: 'skipped',
      reason: 'stale_version',
    });

    llm('SAFE_INQUIRY', 0.97);
    expect(await run(editJob)).toMatchObject({
      kind: 'moderated',
      action: 'UNHIDE',
      status: 'VISIBLE',
      counted: false,
    });
    expect(graph.unhideComment).toHaveBeenCalledWith(
      'FACEBOOK',
      metaId,
      pageA.token,
    );
    expect(await row(rowId)).toMatchObject({
      status: 'VISIBLE',
      category: 'SAFE_INQUIRY',
      usageCountedAt: countedAt,
      moderationStage: null,
    });
    expect(await used(a.workspaceId)).toBe(usedAfterFirst);

    // Escalation: the visible comment is edited into a scam → hidden again.
    const scamJob = await editComment(
      pageA,
      metaId,
      'Nagad 01711111111 e taka pathan',
    );
    llm('SCAM_PHISHING');
    expect(await run(scamJob)).toMatchObject({
      action: 'HIDE',
      status: 'HIDDEN',
      counted: false,
    });
    expect((await row(rowId)).usageCountedAt).toEqual(countedAt);
    expect(await used(a.workspaceId)).toBe(usedAfterFirst);
  });

  it('a job for an older version never applies over a newer edit', async () => {
    const { rowId, metaId, job } = await newComment();
    await editComment(pageA, metaId, 'Edited before the first job ran');
    expect(await run(job)).toEqual({
      kind: 'skipped',
      reason: 'stale_version',
    });
    expect((await row(rowId)).moderationStage).toBe('classify');
  });

  it('D10: a human-stamped comment is never touched (no AI call, no Graph call)', async () => {
    const { rowId, metaId, job } = await newComment();
    await db()
      .update(comments)
      .set({ overriddenAt: new Date(), status: 'VISIBLE' })
      .where(eq(comments.id, rowId));
    expect(await run(job)).toEqual({
      kind: 'skipped',
      reason: 'human_override',
    });
    const editJob = await editComment(pageA, metaId, 'bKash agent number 017');
    expect(await run(editJob)).toEqual({
      kind: 'skipped',
      reason: 'human_override',
    });
    expect(await row(rowId)).toMatchObject({
      status: 'VISIBLE',
      category: null,
      usageCountedAt: null,
      moderationStage: null,
    });
    expect(graphCalls()).toBe(0);
  });

  describe('PW-T4: monthly comment limit + plan', () => {
    let warn: MockInstance<Logger['warn']>;
    beforeEach(() => {
      warn = vi.spyOn(Logger.prototype, 'warn');
    });
    afterEach(() => warn.mockRestore());
    const limitWarnings = () =>
      warn.mock.calls.filter(([message]) =>
        String(message).includes('monthly comment limit reached'),
      );

    it('limit reached → SKIPPED comment_limit_reached, visible, no AI call, one warning per account per day', async () => {
      const limit = await included(b.workspaceId);
      expect(limit).toBe(300);
      const usedB = await used(b.workspaceId);
      await setUsed(b.workspaceId, limit);
      try {
        for (let i = 0; i < 2; i++) {
          const { rowId, job } = await newComment(pageB);
          expect(await run(job)).toEqual({
            kind: 'skipped',
            reason: 'comment_limit_reached',
          });
          expect(await row(rowId)).toMatchObject({
            status: 'SKIPPED',
            statusReason: 'comment_limit_reached',
            category: null,
            usageCountedAt: null,
            moderationStage: null,
          });
        }
        expect(ai.chat).not.toHaveBeenCalled();
        expect(graphCalls()).toBe(0);
        expect(await used(b.workspaceId)).toBe(limit);
        expect(
          (await todayStats(b.workspaceId, pageB.pageId))?.skippedCount,
        ).toBeGreaterThanOrEqual(2);
        // One warning for the account today (ids only, never the comment text).
        const warnings = limitWarnings();
        expect(warnings).toHaveLength(1);
        expect(String(warnings[0]![0])).toContain(
          await accountOf(b.workspaceId),
        );
        const all = warn.mock.calls.map(([m]) => String(m)).join('\n');
        expect(all).not.toContain('cashback');
      } finally {
        await setUsed(b.workspaceId, usedB);
      }
    });

    it('no live plan: expired trial, then no billing account → SKIPPED no_active_plan, nothing sent to Meta', async () => {
      const c = await actors.signUp('pwt4-noplan');
      await insertConnection(c);
      const pageC = await insertPage(c.workspaceId);
      const account = await accountOf(c.workspaceId);
      await db()
        .update(subscriptions)
        .set({ status: 'EXPIRED' })
        .where(eq(subscriptions.billingAccountId, account));
      const expired = await newComment(pageC);
      expect(await run(expired.job)).toEqual({
        kind: 'skipped',
        reason: 'no_active_plan',
      });
      expect(await row(expired.rowId)).toMatchObject({
        status: 'SKIPPED',
        statusReason: 'no_active_plan',
        category: null,
        usageCountedAt: null,
        moderationStage: null,
      });

      await actors.removeBilling(c);
      const unlinked = await newComment(pageC);
      expect(await run(unlinked.job)).toEqual({
        kind: 'skipped',
        reason: 'no_active_plan',
      });
      expect((await row(unlinked.rowId)).statusReason).toBe('no_active_plan');
      expect(ai.chat).not.toHaveBeenCalled();
      expect(graphCalls()).toBe(0);
      expect(limitWarnings()).toEqual([]);
    });

    it('pooled: two workspaces of one account share the 300 (and its warning)', async () => {
      const res = await actors
        .http()
        .post('/api/auth/organization/create')
        .set('Cookie', a.cookie)
        .set('Origin', TRUSTED_ORIGIN)
        .send({ name: 'Second shop', slug: `pwt4-second-${Date.now()}` })
        .expect(200);
      const second = { workspaceId: res.body.id as string };
      actors.trackWorkspace(second.workspaceId);
      expect(await accountOf(second.workspaceId)).toBe(
        await accountOf(a.workspaceId),
      );
      await insertConnection(second);
      const pageS = await insertPage(second.workspaceId);

      const usedA = await used(a.workspaceId);
      expect(await used(second.workspaceId)).toBe(usedA);
      const limit = await included(a.workspaceId);
      expect(limit).toBe(300);
      await setUsed(a.workspaceId, limit - 1);
      try {
        // The second workspace uses the account's last comment …
        const s1 = await newComment(pageS);
        llm('SAFE_INQUIRY');
        expect(await run(s1.job)).toMatchObject({
          kind: 'moderated',
          counted: true,
        });
        expect(await used(a.workspaceId)).toBe(limit);
        expect(await used(second.workspaceId)).toBe(limit);
        // … so the first workspace is out, and so is the second one.
        const a1 = await newComment(pageA);
        expect(await run(a1.job)).toEqual({
          kind: 'skipped',
          reason: 'comment_limit_reached',
        });
        const s2 = await newComment(pageS);
        expect(await run(s2.job)).toEqual({
          kind: 'skipped',
          reason: 'comment_limit_reached',
        });
        // One warning per account per day, whichever workspace hit it.
        expect(limitWarnings()).toHaveLength(1);
        expect(String(limitWarnings()[0]![0])).toContain(
          await accountOf(a.workspaceId),
        );
      } finally {
        await setUsed(a.workspaceId, usedA);
      }
    });
  });

  describe('D2: LLM failures', () => {
    const down = () =>
      new AiGatewayError('transient', 'Service unavailable', {
        status: 503,
        provider: 'neon',
      });

    it('LLM down → retried (count refunded + cleared), last attempt → FAILED, still visible', async () => {
      const { rowId, job } = await newComment();
      const usedBefore = await used(a.workspaceId);
      ai.failWith(down());
      const first = await run(job, 0).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(Error);
      expect(first).not.toBeInstanceOf(UnrecoverableError);
      expect(await row(rowId)).toMatchObject({
        status: 'PENDING',
        moderationStage: 'classify',
        usageCountedAt: null,
      });
      expect(await used(a.workspaceId)).toBe(usedBefore);

      ai.failWith(down());
      const last = await run(job, 4).catch((e: unknown) => e);
      expect(last).toBeInstanceOf(Error);
      expect(await row(rowId)).toMatchObject({
        status: 'FAILED',
        statusReason: 'transient',
        usageCountedAt: null,
        // The sweeper retries it within 24 h.
        moderationStage: 'classify',
      });
      expect(await used(a.workspaceId)).toBe(usedBefore);
      expect(graphCalls()).toBe(0);

      // Once the LLM is back, the next run (sweeper re-queue) classifies it.
      llm('SAFE_INQUIRY');
      expect(await run(job)).toMatchObject({ status: 'VISIBLE' });
      expect(await row(rowId)).toMatchObject({
        statusReason: null,
        usageCountedAt: expect.any(Date),
      });
      expect(await used(a.workspaceId)).toBe(usedBefore + 1);
    });

    it.each(['not_configured', 'payment_required', 'auth'] as const)(
      '%s → UnrecoverableError, FAILED, count refunded + cleared',
      async (kind) => {
        const { rowId, job } = await newComment();
        const usedBefore = await used(a.workspaceId);
        ai.failWith(new AiGatewayError(kind, 'nope', { provider: 'neon' }));
        await expect(run(job)).rejects.toBeInstanceOf(UnrecoverableError);
        expect(await row(rowId)).toMatchObject({
          status: 'FAILED',
          statusReason: kind,
          usageCountedAt: null,
        });
        expect(await used(a.workspaceId)).toBe(usedBefore);
      },
    );

    it('an unusable answer (LLM reached) stays counted, FAILED invalid_output, not retried', async () => {
      const { rowId, job } = await newComment();
      const usedBefore = await used(a.workspaceId);
      ai.replyWith({ model: TEST_MODEL, content: 'not json' });
      ai.replyWith({ model: TEST_MODEL, content: '{"category":"MAYBE"}' });
      await expect(run(job)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(await row(rowId)).toMatchObject({
        status: 'FAILED',
        statusReason: 'invalid_output',
        usageCountedAt: expect.any(Date),
        category: null,
      });
      expect(await used(a.workspaceId)).toBe(usedBefore + 1);
    });
  });

  it('D13: connection NEEDS_REAUTH → classified + counted, Meta action skipped', async () => {
    const { rowId, job } = await newComment();
    await setConnection(a.workspaceId, 'NEEDS_REAUTH');
    try {
      llm('SCAM_PHISHING');
      expect(await run(job)).toMatchObject({
        kind: 'moderated',
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        metaSkip: 'connection_needs_reauth',
      });
      expect(await row(rowId)).toMatchObject({
        status: 'NEEDS_REVIEW',
        statusReason: 'connection_needs_reauth',
        category: 'SCAM_PHISHING',
        usageCountedAt: expect.any(Date),
        moderationStage: null,
      });
      expect(graphCalls()).toBe(0);
    } finally {
      await setConnection(a.workspaceId, 'ACTIVE');
    }
  });

  it('D13: a comment without text is SKIPPED without an AI call', async () => {
    const { rowId, job } = await newComment(pageA, '   ');
    expect(await run(job)).toEqual({ kind: 'skipped', reason: 'no_text' });
    expect(await row(rowId)).toMatchObject({
      status: 'SKIPPED',
      statusReason: 'no_text',
      moderationStage: null,
    });
  });

  it('D4: below the threshold → NEEDS_REVIEW, no action', async () => {
    const { rowId, job } = await newComment();
    llm('SCAM_PHISHING', 0.6);
    expect(await run(job)).toMatchObject({
      action: 'NONE',
      status: 'NEEDS_REVIEW',
    });
    expect(await row(rowId)).toMatchObject({
      status: 'NEEDS_REVIEW',
      statusReason: 'below_threshold',
    });
    expect(graphCalls()).toBe(0);
  });

  describe('D8 + PW-D1: the level decides what is sent, every level counts 1 comment', () => {
    afterEach(() =>
      setPolicy(a.workspaceId, { aiContextLevel: 'comment_only' }),
    );

    it.each([
      ['comment_only', null, 'comment_only'],
      ['page_name', null, 'page_name'],
      ['post_caption', CAPTION, 'post_caption'],
      ['post_caption', null, 'page_name'],
    ] as const)(
      'workspace level %s (caption %j) → sent %s, 1 comment',
      async (level: ContextLevel, caption, sentLevel) => {
        await setPolicy(a.workspaceId, { aiContextLevel: level });
        if (level === 'post_caption') {
          graph.getPostCaption.mockReset().mockResolvedValue(caption);
        }
        const { rowId, job } = await newComment();
        const usedBefore = await used(a.workspaceId);
        llm('SAFE_INQUIRY');
        expect(await run(job)).toMatchObject({ counted: true });
        expect(await row(rowId)).toMatchObject({
          contextLevel: sentLevel,
          usageCountedAt: expect.any(Date),
        });
        expect(await used(a.workspaceId)).toBe(usedBefore + 1);
        const sent = JSON.stringify(ai.chat.mock.calls[0]![0]);
        expect(sent.includes(`Shop ${pageA.pageId}`)).toBe(
          level !== 'comment_only',
        );
        expect(sent.includes('Eid offer')).toBe(sentLevel === 'post_caption');
        expect(graph.getPostCaption).toHaveBeenCalledTimes(
          level === 'post_caption' ? 1 : 0,
        );
      },
    );
  });

  it('D6: growth plan + switch on → hide and one auto-reply in the comment language', async () => {
    const [growth] = await db()
      .select()
      .from(plans)
      .where(eq(plans.slug, 'growth'));
    await db()
      .update(workspaces)
      .set({ planId: growth!.id })
      .where(eq(workspaces.id, a.workspaceId));
    await setPolicy(a.workspaceId, {
      scamPhishingAutoReply: true,
      scamPhishingReplyEn: REPLY_EN,
      scamPhishingReplyBn: REPLY_BN,
    });
    try {
      const { rowId, metaId, job } = await newComment();
      llm('SCAM_PHISHING', 0.95, 'bn');
      expect(await run(job)).toMatchObject({
        action: 'HIDE',
        status: 'HIDDEN',
        replied: true,
      });
      expect(graph.replyToComment).toHaveBeenCalledWith(
        'FACEBOOK',
        metaId,
        REPLY_BN,
        pageA.token,
      );
      expect(await actionsOf(rowId)).toEqual([
        expect.objectContaining({ action: 'HIDE', state: 'SUCCEEDED' }),
        expect.objectContaining({
          action: 'REPLY',
          state: 'SUCCEEDED',
          replyCommentId: FAKE_REPLY_ID,
        }),
      ]);
    } finally {
      await setPolicy(a.workspaceId, { scamPhishingAutoReply: false });
      await db()
        .update(workspaces)
        .set({ planId: null })
        .where(eq(workspaces.id, a.workspaceId));
    }
  });

  it('a transient Graph failure retries only the Meta step (no second AI call or count)', async () => {
    const { rowId, job } = await newComment();
    const usedBefore = await used(a.workspaceId);
    graph.hideComment.mockRejectedValueOnce(
      new MetaGraphError('rate_limited', 'Too many calls', { status: 429 }),
    );
    llm('SCAM_PHISHING');
    const error = await run(job).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(await row(rowId)).toMatchObject({
      moderationStage: 'act',
      category: 'SCAM_PHISHING',
      usageCountedAt: expect.any(Date),
    });
    // Retry: no LLM answer armed, so a second AI call would throw.
    expect(await run(job, 1)).toMatchObject({
      kind: 'moderated',
      classified: false,
      counted: false,
      action: 'HIDE',
      status: 'HIDDEN',
    });
    expect(await row(rowId)).toMatchObject({
      status: 'HIDDEN',
      moderationStage: null,
    });
    expect(await used(a.workspaceId)).toBe(usedBefore + 1);
  });

  it('two workspaces are isolated: a job naming another workspace finds nothing', async () => {
    const { rowId, job } = await newComment();
    const forged = {
      ...job,
      data: { workspaceId: b.workspaceId, commentRowId: rowId, editedAt: null },
    };
    const usedB = await used(b.workspaceId);
    expect(await run(forged)).toEqual({
      kind: 'skipped',
      reason: 'comment_not_found',
    });
    expect((await row(rowId)).moderationStage).toBe('classify');

    const own = await newComment(pageB);
    llm('ABUSIVE_TOXIC');
    await run(own.job);
    expect(await used(b.workspaceId)).toBe(usedB + 1);
    expect(graph.hideComment).toHaveBeenCalledWith(
      'FACEBOOK',
      own.metaId,
      pageB.token,
    );
    // A's comment is still waiting for its own job.
    llm('SAFE_INQUIRY');
    await run(job);
  });

  describe('D2 sweeper', () => {
    const insert = async (
      patch: Partial<typeof comments.$inferInsert>,
    ): Promise<string> => {
      const n = next();
      const [created] = await db()
        .insert(comments)
        .values({
          commentId: `${n}_${n}9`,
          workspaceId: a.workspaceId,
          socialPageId: pageA.id,
          platform: 'FACEBOOK',
          postId: `${pageA.pageId}_${n}`,
          message: 'bKash 01700000000',
          status: 'PENDING',
          moderationStage: 'classify',
          ...patch,
        })
        .returning({ id: comments.id });
      return created!.id;
    };

    it('re-queues only < 24 h PENDING/FAILED (stage set) comments idle ≥ 5 min', async () => {
      const now = new Date();
      const ago = (ms: number) => new Date(now.getTime() - ms);
      const H = 60 * 60 * 1000;
      const pending = await insert({
        createdAt: ago(2 * H),
        updatedAt: ago(2 * H),
      });
      const failed = await insert({
        status: 'FAILED',
        statusReason: 'transient',
        createdAt: ago(3 * H),
        updatedAt: ago(H),
      });
      const editedAt = ago(H);
      const edited = await insert({
        status: 'VISIBLE',
        editedAt,
        createdAt: ago(30 * H),
        updatedAt: ago(H),
      });
      const old = await insert({
        createdAt: ago(25 * H),
        updatedAt: ago(25 * H),
      });
      const busy = await insert({
        createdAt: ago(H),
        updatedAt: ago(60 * 1000),
      });
      const done = await insert({
        status: 'VISIBLE',
        moderationStage: null,
        createdAt: ago(H),
        updatedAt: ago(H),
      });
      const queued = await insert({ createdAt: ago(H), updatedAt: ago(H) });

      queue().reset();
      // A failed job with the same id is replaced; a waiting one is left alone.
      await queue().add(
        'moderate-comment',
        {},
        { jobId: moderationJobId(failed, null) },
      );
      queue().setJobState(moderationJobId(failed, null), 'failed');
      await queue().add(
        'moderate-comment',
        { keep: true },
        { jobId: moderationJobId(queued, null) },
      );

      const result = await app.get(ModerationSweeper).sweep(now);
      expect(result.requeued).toBeGreaterThanOrEqual(3);
      const ids = queue().jobs.map((j) => j.id);
      expect(ids).toContain(moderationJobId(pending, null));
      expect(ids).toContain(moderationJobId(failed, null));
      expect(ids).toContain(moderationJobId(edited, editedAt));
      expect(ids).not.toContain(moderationJobId(old, null));
      expect(ids).not.toContain(moderationJobId(busy, null));
      expect(ids).not.toContain(moderationJobId(done, null));
      expect(
        queue().jobs.find((j) => j.id === moderationJobId(failed, null))?.data,
      ).toEqual({
        workspaceId: a.workspaceId,
        commentRowId: failed,
        editedAt: null,
      });
      expect(
        queue().jobs.find((j) => j.id === moderationJobId(queued, null))?.data,
      ).toEqual({
        keep: true,
      });

      // The sweep job itself runs through the processor.
      const tickResult = await processor.process({
        id: 'repeat:sweep',
        name: MODERATION_SWEEP_JOB_NAME,
        data: {},
        opts: { attempts: 1 },
        attemptsMade: 0,
      } as unknown as Job<unknown, ModerationResult>);
      expect(tickResult).toMatchObject({ requeued: expect.any(Number) });

      // Leave nothing that owes moderation behind for later specs.
      await db()
        .update(comments)
        .set({ moderationStage: null })
        .where(
          and(
            eq(comments.workspaceId, a.workspaceId),
            sql`${comments.moderationStage} is not null`,
          ),
        );
    });
  });
});
