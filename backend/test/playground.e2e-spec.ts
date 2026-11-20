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
  platformSettings,
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
  async peek(key: string) {
    return this.counts.get(key) ?? 0;
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
  const usage = (cookie: string, workspaceId: string) =>
    actors
      .http()
      .get(`/api/workspaces/${workspaceId}/playground/usage`)
      .set('Cookie', cookie);
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
    // Keyword rules only run on a plan with `customBlocklist` (Growth/Pro).
    await actors.activatePlan(owner, 'growth');
    await actors.activatePlan(other, 'growth');
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

  it('GET usage (M6-T11): limit, used, testsLeft, resetsAt; read only', async () => {
    const fresh = (await usage(owner.cookie, owner.workspaceId).expect(200))
      .body;
    expect(fresh).toEqual({
      limit: 10,
      used: 0,
      testsLeft: 10,
      resetsAt: expect.any(String),
    });
    expect(Date.parse(fresh.resetsAt)).toBeGreaterThan(Date.now());
    await usage(owner.cookie, owner.workspaceId).expect(200);
    expect(counter.counts.size).toBe(0);
    counter.counts.set(key(owner.workspaceId), 3);
    expect(
      (await usage(owner.cookie, owner.workspaceId).expect(200)).body,
    ).toMatchObject({ used: 3, testsLeft: 7 });
    // Another workspace has its own count.
    expect(
      (await usage(other.cookie, other.workspaceId).expect(200)).body,
    ).toMatchObject({ used: 0, testsLeft: 10 });
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
      await actors
        .http()
        .get(`/api/workspaces/${owner.workspaceId}/playground/usage`)
        .expect(401);
      await usage(outsider.cookie, owner.workspaceId).expect(404);
      expect(counter.counts.size).toBe(0);
    });

    it('a moderator may test', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      llm('SPAM_IRRELEVANT');
      await post(cookie, owner.workspaceId, { text: 'follow me' }).expect(200);
      await usage(cookie, owner.workspaceId).expect(200);
    });

    it('an impersonated session tests its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      llm('SAFE_INQUIRY');
      await post(cookie, owner.workspaceId, { text: 'hi' }).expect(200);
      expect(
        (await usage(cookie, owner.workspaceId).expect(200)).body,
      ).toMatchObject({ used: 1, testsLeft: 9 });
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await post(cookie, other.workspaceId, { text: 'hi' }).expect(404);
      await usage(cookie, other.workspaceId).expect(404);
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

  describe('admin limit setting (M6-T7b, D9)', () => {
    const PLATFORM = '/api/admin/settings/platform';
    const as = (cookie: string) => ({
      get: () => actors.http().get(PLATFORM).set('Cookie', cookie),
      patch: (body: object) =>
        actors.http().patch(PLATFORM).set('Cookie', cookie).send(body),
    });
    let before: (typeof platformSettings.$inferSelect)[];

    beforeAll(async () => {
      before = await actors.db.select().from(platformSettings);
      await actors.db.delete(platformSettings);
    });

    // Back to the baseline row (or none).
    afterAll(async () => {
      if (!actors) return;
      await actors.db.delete(platformSettings);
      if (before.length)
        await actors.db.insert(platformSettings).values(before);
    });

    it('GET defaults to 10; PATCH 25 alone keeps the WhatsApp number; bad values → 400', async () => {
      const admin = as(superAdmin.cookie);
      expect((await admin.get().expect(200)).body).toEqual({
        supportWhatsappNumber: null,
        playgroundDailyLimit: 10,
        updatedAt: null,
      });
      await admin.patch({ supportWhatsappNumber: '8801712345678' }).expect(200);
      const saved = await admin.patch({ playgroundDailyLimit: 25 }).expect(200);
      expect(saved.body).toMatchObject({
        supportWhatsappNumber: '8801712345678',
        playgroundDailyLimit: 25,
      });
      expect((await admin.get().expect(200)).body).toEqual(saved.body);

      for (const body of [
        {},
        { playgroundDailyLimit: 1001 },
        { playgroundDailyLimit: -1 },
        { playgroundDailyLimit: '5' },
        { playgroundDailyLimit: 2.5 },
        { playgroundDailyLimit: null },
      ])
        await admin.patch(body).expect(400);
      const [row] = await actors.db.select().from(platformSettings);
      expect(row).toMatchObject({
        playgroundDailyLimit: 25,
        supportWhatsappNumber: '8801712345678',
        updatedById: superAdmin.id,
      });
    });

    it('non-admins get 403 and change nothing', async () => {
      for (const actor of [owner, moderator]) {
        await as(actor.cookie).get().expect(403);
        await as(actor.cookie).patch({ playgroundDailyLimit: 1 }).expect(403);
      }
      const [row] = await actors.db.select().from(platformSettings);
      expect(row?.playgroundDailyLimit).toBe(25);
    });

    it('a lowered limit applies at once: 429 with details.limit = the setting; 0 = off', async () => {
      await as(superAdmin.cookie)
        .patch({ playgroundDailyLimit: 2 })
        .expect(200);
      counter.counts.set(key(owner.workspaceId), 1);
      llm('SAFE_INQUIRY');
      const last = await post(owner.cookie, owner.workspaceId, {
        text: 'dam koto?',
      }).expect(200);
      expect(last.body.testsLeft).toBe(0);
      const res = await post(owner.cookie, owner.workspaceId, {
        text: 'dam koto?',
      }).expect(429);
      expect(res.body).toMatchObject({
        code: 'PLAYGROUND_LIMIT_REACHED',
        details: { limit: 2 },
      });

      await as(superAdmin.cookie)
        .patch({ playgroundDailyLimit: 0 })
        .expect(200);
      const off = await post(other.cookie, other.workspaceId, {
        text: 'hi',
      }).expect(429);
      expect(off.body).toMatchObject({
        message: 'The playground is turned off right now.',
        details: { limit: 0 },
      });
      expect(
        (await usage(other.cookie, other.workspaceId).expect(200)).body,
      ).toMatchObject({ limit: 0, testsLeft: 0 });
      expect(counter.counts.get(key(other.workspaceId))).toBe(0);
    });
  });
});
