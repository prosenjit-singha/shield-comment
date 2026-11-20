import type { INestApplication } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { AiGatewayError } from '../src/ai-gateway/ai-gateway.errors.js';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.js';
import { dhakaDayKey } from '../src/comments/comments.queries.js';
import {
  comments,
  dailyAiUsage,
  dailyCommentStats,
  moderationActions,
  moderationPolicies,
} from '../src/db/schema/index.js';
import type { PlaygroundTestResponse } from '../src/moderation/dto/playground.dto.js';
import { ModerationPolicyService } from '../src/moderation/moderation-policy.service.js';
import {
  PlaygroundCounter,
  playgroundCounterKey,
} from '../src/moderation/playground.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakeAiGateway } from './utils/fake-ai-gateway.js';

const TEST_MODEL = 'm6t7-e2e-model';

/** Redis is stubbed in e2e: the daily counter lives in memory (same contract). */
class MemoryPlaygroundCounter extends PlaygroundCounter {
  readonly counts = new Map<string, number>();
  async hit(key: string) {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n;
  }
  async undo(key: string) {
    this.counts.set(key, (this.counts.get(key) ?? 0) - 1);
  }
}

/**
 * M6-T7: moderation playground (D9 free 10/day, D7 every member + impersonation, D2 b rules).
 * AI = strict fake (an unarmed call fails), global `fetch` throws: no live request.
 */
describe('Playground API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  const ai = fakeAiGateway();
  const counter = new MemoryPlaygroundCounter();
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const path = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/playground/test`;
  const post = (cookie: string, workspaceId: string, body: object) =>
    actors.http().post(path(workspaceId)).set('Cookie', cookie).send(body);
  const key = (workspaceId: string) =>
    playgroundCounterKey(workspaceId, dhakaDayKey());
  const llm = (category: string, confidence = 0.95) =>
    ai.replyWith({
      model: TEST_MODEL,
      content: JSON.stringify({
        category,
        confidence_score: confidence,
        reasoning: 'Test reasoning.',
        language: 'banglish',
      }),
      usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
    });
  const setRules = (
    workspaceId: string,
    patch: Partial<typeof moderationPolicies.$inferInsert>,
  ) =>
    actors.db
      .update(moderationPolicies)
      .set(patch)
      .where(eq(moderationPolicies.workspaceId, workspaceId));
  const countRows = async (workspaceId: string) => ({
    comments: (
      await actors.db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.workspaceId, workspaceId))
    ).length,
    actions: (
      await actors.db
        .select({ id: moderationActions.id })
        .from(moderationActions)
        .where(eq(moderationActions.workspaceId, workspaceId))
    ).length,
    stats: (
      await actors.db
        .select({ day: dailyCommentStats.day })
        .from(dailyCommentStats)
        .where(eq(dailyCommentStats.workspaceId, workspaceId))
    ).length,
  });

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp((builder) =>
      builder
        .overrideProvider(AiGatewayService)
        .useValue(ai)
        .overrideProvider(PlaygroundCounter)
        .useValue(counter),
    );
    actors = createAuthActors(app);
    owner = await actors.signUp('m6t7-owner');
    other = await actors.signUp('m6t7-other');
    moderator = await actors.signUp('m6t7-mod');
    outsider = await actors.signUp('m6t7-outsider');
    superAdmin = await actors.signUpSuperAdmin('m6t7-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    const policies = app.get(ModerationPolicyService);
    await policies.policy(owner.workspaceId);
    await policies.policy(other.workspaceId);
  });

  beforeEach(() => {
    ai.reset();
    counter.counts.clear();
  });

  afterEach(() => {
    expect(ai.pending).toBe(0);
  });

  afterAll(async () => {
    if (actors) {
      await actors.db
        .delete(dailyAiUsage)
        .where(eq(dailyAiUsage.model, TEST_MODEL));
      await actors.cleanup();
    }
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a keyword rule hit decides without the AI (0 requests), stores nothing', async () => {
    await setRules(owner.workspaceId, {
      blockedKeywords: ['cashback'],
      keywordRuleAction: 'DELETE',
    });
    try {
      const res = await post(owner.cookie, owner.workspaceId, {
        text: '  Get CASHBACK today  ',
      }).expect(200);
      expect(res.body).toEqual({
        ruleMatch: { kind: 'keyword', value: 'cashback' },
        classification: null,
        decision: { action: 'DELETE', status: 'DELETED', reason: 'policy' },
        latencyMs: expect.any(Number),
        testsLeft: 9,
      } satisfies PlaygroundTestResponse);
      expect(ai.chat).not.toHaveBeenCalled();
      expect(await countRows(owner.workspaceId)).toEqual({
        comments: 0,
        actions: 0,
        stats: 0,
      });
    } finally {
      await setRules(owner.workspaceId, { blockedKeywords: [] });
    }
  });

  it('no rule match → 1 AI request, daily_ai_usage recorded, no comment row', async () => {
    llm('SCAM_PHISHING');
    const day = dhakaDayKey();
    const res = await post(owner.cookie, owner.workspaceId, {
      text: 'bkash e 500 taka pathan',
      platform: 'INSTAGRAM',
    }).expect(200);
    expect(res.body).toEqual({
      ruleMatch: null,
      classification: {
        category: 'SCAM_PHISHING',
        confidence: 0.95,
        reasoning: 'Test reasoning.',
        language: 'banglish',
      },
      decision: { action: 'HIDE', status: 'HIDDEN', reason: 'policy' },
      latencyMs: expect.any(Number),
      testsLeft: 9,
    });
    expect(ai.chat).toHaveBeenCalledTimes(1);
    const [usage] = await actors.db
      .select()
      .from(dailyAiUsage)
      .where(
        and(eq(dailyAiUsage.model, TEST_MODEL), eq(dailyAiUsage.day, day)),
      );
    expect(usage).toMatchObject({
      calls: 1,
      inputTokens: 120,
      outputTokens: 30,
    });
    expect(await countRows(owner.workspaceId)).toEqual({
      comments: 0,
      actions: 0,
      stats: 0,
    });
  });

  it('every test counts; the 11th → 429 PLAYGROUND_LIMIT_REACHED (not counted)', async () => {
    counter.counts.set(key(owner.workspaceId), 9);
    llm('SAFE_INQUIRY');
    const last = await post(owner.cookie, owner.workspaceId, {
      text: 'dam koto?',
    }).expect(200);
    expect(last.body).toMatchObject({
      decision: { action: 'NONE', status: 'VISIBLE', reason: 'policy' },
      testsLeft: 0,
    });
    const res = await post(owner.cookie, owner.workspaceId, {
      text: 'dam koto?',
    }).expect(429);
    expect(res.body).toMatchObject({
      code: 'PLAYGROUND_LIMIT_REACHED',
      details: { limit: 10, resetsAt: expect.any(String) },
    });
    const resetsAt = Date.parse(res.body.details.resetsAt);
    expect(resetsAt).toBeGreaterThan(Date.now());
    expect(resetsAt - Date.now()).toBeLessThanOrEqual(24 * 3_600_000);
    expect(counter.counts.get(key(owner.workspaceId))).toBe(10);
    // Another workspace has its own counter.
    llm('SAFE_INQUIRY');
    await post(other.cookie, other.workspaceId, { text: 'hi' }).expect(200);
  });

  it('AI failure → 502 PLAYGROUND_AI_FAILED with details; not configured → 503; neither counts', async () => {
    ai.failWith(
      new AiGatewayError('transient', 'Service unavailable', {
        status: 503,
        provider: 'neon',
      }),
    );
    const failed = await post(owner.cookie, owner.workspaceId, {
      text: 'hello',
    }).expect(502);
    expect(failed.body).toMatchObject({
      code: 'PLAYGROUND_AI_FAILED',
      details: { errorKind: 'transient', retryable: true },
    });
    ai.failWith(new AiGatewayError('not_configured', 'No AI provider'));
    const off = await post(owner.cookie, owner.workspaceId, {
      text: 'hello',
    }).expect(503);
    expect(off.body.code).toBe('PLAYGROUND_AI_NOT_CONFIGURED');
    expect(off.body.details).toBeUndefined();
    expect(counter.counts.get(key(owner.workspaceId))).toBe(0);
  });

  it('400 for a blank / too long text, a bad platform or extra keys (not counted)', async () => {
    for (const body of [
      {},
      { text: '   ' },
      { text: 'x'.repeat(2_001) },
      { text: 'hi', platform: 'TIKTOK' },
      { text: 'hi', commentId: 'x' },
    ]) {
      await post(owner.cookie, owner.workspaceId, body).expect(400);
    }
    expect(counter.counts.size).toBe(0);
  });

  describe('access (D7) + tenant isolation', () => {
    it('401 without a session; 404 for a non-member or a malformed id', async () => {
      await actors
        .http()
        .post(path(owner.workspaceId))
        .send({ text: 'hi' })
        .expect(401);
      await post(outsider.cookie, owner.workspaceId, { text: 'hi' }).expect(
        404,
      );
      await post(owner.cookie, 'not-a-uuid', { text: 'hi' }).expect(404);
      expect(counter.counts.size).toBe(0);
    });

    it('a moderator may test', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      llm('SPAM_IRRELEVANT');
      await post(cookie, owner.workspaceId, { text: 'follow me' }).expect(200);
    });

    it('an impersonated session tests its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      llm('SAFE_INQUIRY');
      await post(cookie, owner.workspaceId, { text: 'hi' }).expect(200);
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await post(cookie, other.workspaceId, { text: 'hi' }).expect(404);
    });

    it("another workspace's rules never apply", async () => {
      await setRules(other.workspaceId, { blockedKeywords: ['offer'] });
      llm('SAFE_INQUIRY');
      const res = await post(owner.cookie, owner.workspaceId, {
        text: 'any offer?',
      }).expect(200);
      expect(res.body.ruleMatch).toBeNull();
      const theirs = await post(other.cookie, other.workspaceId, {
        text: 'any offer?',
      }).expect(200);
      expect(theirs.body.ruleMatch).toEqual({
        kind: 'keyword',
        value: 'offer',
      });
    });
  });
});
