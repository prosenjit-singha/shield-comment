import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { addDays, dhakaBucketKey } from '../src/admin/dashboard-range.js';
import type { DashboardSummaryResponse } from '../src/comments/dto/dashboard-summary.dto.js';
import {
  comments,
  type CommentPlatform,
  type CommentStatus,
  dailyCommentStats,
} from '../src/db/schema/index.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

/**
 * M6-T5: workspace dashboard summary (D10 a, D7 every member + impersonation). Seeded
 * `daily_comment_stats` + comments only; no external call is made (global `fetch` throws).
 */
describe('Dashboard summary API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let other: Actor;
  let empty: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let today: string;
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const base = `9${Date.now()}`;
  let seq = 0;
  const metaId = () => `${base}${seq++}`;
  const PAGE_A = metaId();
  const PAGE_B = metaId();

  const path = (workspaceId: string) =>
    `/api/workspaces/${workspaceId}/dashboard/summary`;
  const get = (cookie: string, workspaceId: string, query = {}) =>
    actors.http().get(path(workspaceId)).query(query).set('Cookie', cookie);
  const summary = async (
    actor: Actor,
    query: Record<string, string> = {},
  ): Promise<DashboardSummaryResponse> =>
    (await get(actor.cookie, actor.workspaceId, query).expect(200)).body;

  async function insertStats(
    workspaceId: string,
    pageId: string,
    platform: CommentPlatform,
    day: string,
    counts: Partial<typeof dailyCommentStats.$inferInsert>,
  ) {
    await actors.db
      .insert(dailyCommentStats)
      .values({ workspaceId, pageId, platform, day, ...counts });
  }

  async function insertComment(workspaceId: string, status: CommentStatus) {
    await actors.db.insert(comments).values({
      commentId: `${metaId()}_${metaId()}`,
      workspaceId,
      platform: 'FACEBOOK',
      postId: `${metaId()}_${metaId()}`,
      message: 'kemon dam?',
      status,
    });
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m6t5-owner');
    other = await actors.signUp('m6t5-other');
    empty = await actors.signUp('m6t5-empty');
    moderator = await actors.signUp('m6t5-mod');
    outsider = await actors.signUp('m6t5-outsider');
    superAdmin = await actors.signUpSuperAdmin('m6t5-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    today = dhakaBucketKey(new Date(), 'day');
    const ws = owner.workspaceId;

    // Today: two Pages + both platforms sum into one day.
    await insertStats(ws, PAGE_A, 'FACEBOOK', today, {
      classifiedCount: 4,
      ruleMatchedCount: 1,
      hiddenCount: 2,
      safeInquiryCount: 2,
      scamPhishingCount: 2,
    });
    await insertStats(ws, PAGE_A, 'INSTAGRAM', today, {
      classifiedCount: 1,
      deletedCount: 1,
      abusiveToxicCount: 1,
    });
    await insertStats(ws, PAGE_B, 'FACEBOOK', today, {
      classifiedCount: 2,
      hiddenCount: 1,
      scamPhishingCount: 1,
      competitorPoachCount: 1,
    });
    // 6 days ago: inside 7d.
    await insertStats(ws, PAGE_A, 'FACEBOOK', addDays(today, -6), {
      classifiedCount: 3,
      spamIrrelevantCount: 3,
      hiddenCount: 3,
    });
    // 7 days ago: outside 7d, inside 30d.
    await insertStats(ws, PAGE_A, 'FACEBOOK', addDays(today, -7), {
      classifiedCount: 10,
      scamPhishingCount: 10,
      hiddenCount: 10,
    });
    // 30 days ago: outside 30d, inside 90d.
    await insertStats(ws, PAGE_B, 'FACEBOOK', addDays(today, -30), {
      classifiedCount: 100,
      ruleMatchedCount: 5,
    });
    // Another workspace on the same Page id + day: never counted for the owner.
    await insertStats(other.workspaceId, PAGE_A, 'FACEBOOK', today, {
      classifiedCount: 1000,
      scamPhishingCount: 1000,
      hiddenCount: 1000,
    });

    await insertComment(ws, 'NEEDS_REVIEW');
    await insertComment(ws, 'NEEDS_REVIEW');
    await insertComment(ws, 'VISIBLE');
    await insertComment(ws, 'HIDDEN');
    await insertComment(other.workspaceId, 'NEEDS_REVIEW');
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('defaults to 30d: zero-filled Dhaka days, sums across Pages and platforms', async () => {
    const s = await summary(owner);
    expect(s.range).toBe('30d');
    expect(s.daily).toHaveLength(30);
    expect(s.daily[0]!.day).toBe(addDays(today, -29));
    expect(s.daily.at(-1)).toEqual({ day: today, scanned: 8, autoHidden: 4 });
    expect(s.daily.at(-7)).toEqual({
      day: addDays(today, -6),
      scanned: 3,
      autoHidden: 3,
    });
    expect(s.daily.at(-8)).toEqual({
      day: addDays(today, -7),
      scanned: 10,
      autoHidden: 10,
    });
    expect(s.daily.filter((d) => d.scanned > 0)).toHaveLength(3);
    expect(s.kpis).toEqual({
      scanned: 21,
      autoHidden: 17,
      needsReview: 2,
      scamsBlocked: 13,
    });
    expect(s.intents).toEqual([
      { category: 'SAFE_INQUIRY', count: 2 },
      { category: 'COMPETITOR_POACH', count: 1 },
      { category: 'SCAM_PHISHING', count: 13 },
      { category: 'SPAM_IRRELEVANT', count: 3 },
      { category: 'ABUSIVE_TOXIC', count: 1 },
    ]);
    expect(s.flagged).toEqual(s.intents.slice(1));
  });

  it('7d and 90d cover their own days', async () => {
    const week = await summary(owner, { range: '7d' });
    expect(week.daily).toHaveLength(7);
    expect(week.kpis).toMatchObject({
      scanned: 11,
      autoHidden: 7,
      scamsBlocked: 3,
    });
    const quarter = await summary(owner, { range: '90d' });
    expect(quarter.daily).toHaveLength(90);
    expect(quarter.kpis.scanned).toBe(126);
  });

  it('an empty workspace is all zeros', async () => {
    const s = await summary(empty, { range: '7d' });
    expect(s.daily).toHaveLength(7);
    expect(s.daily.every((d) => d.scanned === 0 && d.autoHidden === 0)).toBe(
      true,
    );
    expect(s.kpis).toEqual({
      scanned: 0,
      autoHidden: 0,
      needsReview: 0,
      scamsBlocked: 0,
    });
    expect(s.intents.every((i) => i.count === 0)).toBe(true);
  });

  it.each([
    [{ range: '12m' }],
    [{ range: '1d' }],
    [{ from: '2026-11-01', to: '2026-11-02' }],
    [{ workspace: 'x' }],
  ])('400 for %j', async (query) => {
    await get(owner.cookie, owner.workspaceId, query).expect(400);
  });

  describe('access (D7) + tenant isolation', () => {
    it('401 without a session; 404 for a non-member or a malformed id', async () => {
      await actors.http().get(path(owner.workspaceId)).expect(401);
      await get(outsider.cookie, owner.workspaceId).expect(404);
      await get(owner.cookie, 'not-a-uuid').expect(404);
    });

    it('a moderator may read the summary', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      const res = await get(cookie, owner.workspaceId).expect(200);
      expect(res.body.kpis.scanned).toBe(21);
    });

    it('an impersonated session reads its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      const res = await get(cookie, owner.workspaceId).expect(200);
      expect(res.body.kpis.needsReview).toBe(2);
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await get(cookie, other.workspaceId).expect(404);
    });

    it('each workspace sees only its own counters', async () => {
      const s = await summary(other, { range: '7d' });
      expect(s.kpis).toEqual({
        scanned: 1000,
        autoHidden: 1000,
        needsReview: 1,
        scamsBlocked: 1000,
      });
    });
  });
});
