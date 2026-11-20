import type { INestApplication } from '@nestjs/common';
import type { App } from 'supertest/types.js';
import { addDays, dhakaBucketKey } from '../src/admin/dashboard-range.js';
import {
  COMMENTS_CSV_HEADER,
  DAILY_CSV_HEADER,
} from '../src/comments/analytics.js';
import type { AnalyticsResponse } from '../src/comments/dto/analytics.dto.js';
import {
  comments,
  type CommentPlatform,
  type CommentStatus,
  dailyCommentStats,
  moderationActions,
  socialPages,
} from '../src/db/schema/index.js';
import type { ModerationCategory } from '../src/moderation/moderation.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AUTHOR_ID = '777000111222444';
const RAW_MARKER = 'raw-payload-marker-m6t6';

/**
 * M6-T6: workspace analytics + CSV exports (D11 a, D12 b, D7 every member + impersonation).
 * Seeded `daily_comment_stats` / comments / actions only; no external call (global `fetch` throws).
 */
describe('Analytics API (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let owner: Actor;
  let other: Actor;
  let moderator: Actor;
  let outsider: Actor;
  let superAdmin: Actor;
  let today: string;
  let pageA: { id: string; name: string };
  let pageB: { id: string; name: string };
  let otherPage: { id: string; name: string };
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const base = `7${Date.now()}`;
  let seq = 0;
  const metaId = () => `${base}${seq++}`;
  const META_A = metaId();
  const META_B = metaId();
  const META_OTHER = metaId();

  const path = (workspaceId: string, suffix = '') =>
    `/api/workspaces/${workspaceId}/analytics${suffix}`;
  const get = (
    cookie: string,
    workspaceId: string,
    suffix = '',
    query: Record<string, string> = {},
  ) =>
    actors
      .http()
      .get(path(workspaceId, suffix))
      .query(query)
      .set('Cookie', cookie);
  const analytics = async (query: Record<string, string> = {}) =>
    (await get(owner.cookie, owner.workspaceId, '', query).expect(200))
      .body as AnalyticsResponse;
  const csvLines = (text: string) => {
    expect(text.charCodeAt(0)).toBe(0xfeff);
    return text.slice(1).split('\r\n').slice(0, -1);
  };

  async function insertPage(workspaceId: string, pageId: string, name: string) {
    const [page] = await actors.db
      .insert(socialPages)
      .values({ workspaceId, pageId, pageName: name })
      .returning();
    return { id: page!.id, name: page!.pageName };
  }

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

  async function insertComment(input: {
    workspaceId: string;
    at: Date;
    message: string;
    pageId?: string;
    platform?: CommentPlatform;
    status?: CommentStatus;
    category?: ModerationCategory;
  }): Promise<string> {
    const [row] = await actors.db
      .insert(comments)
      .values({
        commentId: `${metaId()}_${metaId()}`,
        workspaceId: input.workspaceId,
        socialPageId: input.pageId ?? null,
        platform: input.platform ?? 'FACEBOOK',
        postId: `${metaId()}_${metaId()}`,
        authorId: AUTHOR_ID,
        authorName: 'Rahim',
        message: input.message,
        rawPayload: { marker: RAW_MARKER },
        status: input.status ?? 'PENDING',
        createdAt: input.at,
        ...(input.category && {
          category: input.category,
          confidence: 0.912,
          reasoning: 'Asks for a bKash payment.',
          language: 'bn',
          classifiedAt: input.at,
          aiProvider: 'neon',
          model: 'm6t6-e2e-model',
          promptVersion: 'moderation-v2',
          contextLevel: 'comment_only',
        }),
      })
      .returning({ id: comments.id });
    return row!.id;
  }

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp();
    actors = createAuthActors(app);
    owner = await actors.signUp('m6t6-owner');
    other = await actors.signUp('m6t6-other');
    moderator = await actors.signUp('m6t6-mod');
    outsider = await actors.signUp('m6t6-outsider');
    superAdmin = await actors.signUpSuperAdmin('m6t6-super');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    today = dhakaBucketKey(new Date(), 'day');
    const ws = owner.workspaceId;
    pageA = await insertPage(ws, META_A, 'Shop A');
    pageB = await insertPage(ws, META_B, 'Shop B');
    otherPage = await insertPage(other.workspaceId, META_OTHER, 'Other');

    await insertStats(ws, META_A, 'FACEBOOK', today, {
      receivedCount: 7,
      classifiedCount: 4,
      ruleMatchedCount: 1,
      hiddenCount: 2,
      scamPhishingCount: 3,
      safeInquiryCount: 1,
    });
    await insertStats(ws, META_A, 'INSTAGRAM', today, {
      classifiedCount: 1,
      deletedCount: 1,
      abusiveToxicCount: 1,
    });
    await insertStats(ws, META_B, 'FACEBOOK', addDays(today, -1), {
      classifiedCount: 2,
      hiddenCount: 1,
      competitorPoachCount: 2,
    });
    // 40 days ago: outside the 30-day default, inside a 100-day (monthly) range.
    await insertStats(ws, META_B, 'FACEBOOK', addDays(today, -40), {
      classifiedCount: 10,
      spamIrrelevantCount: 10,
    });
    // A Page that is gone (aggregates outlive disconnect): no name in the CSV.
    await insertStats(ws, metaId(), 'FACEBOOK', addDays(today, -2), {
      receivedCount: 1,
    });
    // Another workspace on the same Meta Page id + day: never counted for the owner.
    await insertStats(other.workspaceId, META_A, 'FACEBOOK', today, {
      classifiedCount: 1000,
      hiddenCount: 1000,
    });

    const now = Date.now();
    const scam = await insertComment({
      workspaceId: ws,
      at: new Date(now - 2 * DAY),
      message: 'বিকাশে টাকা পাঠান, "অফার" 01712345678',
      pageId: pageA.id,
      status: 'VISIBLE',
      category: 'SCAM_PHISHING',
    });
    await insertComment({
      workspaceId: ws,
      at: new Date(now - DAY),
      message: '=HYPERLINK("http://evil")',
      pageId: pageB.id,
      platform: 'INSTAGRAM',
    });
    await insertComment({
      workspaceId: ws,
      at: new Date(now - 40 * DAY),
      message: 'old comment',
      pageId: pageA.id,
    });
    await insertComment({
      workspaceId: other.workspaceId,
      at: new Date(now - DAY),
      message: 'other workspace comment',
      pageId: otherPage.id,
    });
    await actors.db.insert(moderationActions).values([
      {
        workspaceId: ws,
        commentId: scam,
        action: 'HIDE',
        source: 'AUTO',
        state: 'SUCCEEDED',
        createdAt: new Date(now - 2 * DAY + 1000),
        completedAt: new Date(now - 2 * DAY + 2000),
      },
      {
        workspaceId: ws,
        commentId: scam,
        action: 'UNHIDE',
        source: 'USER',
        userId: owner.id,
        state: 'SUCCEEDED',
        createdAt: new Date(now - 2 * DAY + 60_000),
        completedAt: new Date(now - 2 * DAY + 61_000),
      },
    ]);
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('GET …/analytics', () => {
    it('defaults to 30 zero-filled Dhaka days summed over Pages and platforms', async () => {
      const a = await analytics();
      expect(a).toMatchObject({
        from: addDays(today, -29),
        to: today,
        granularity: 'day',
        page: null,
      });
      expect(a.series).toHaveLength(30);
      expect(a.series.at(-1)).toMatchObject({
        bucket: today,
        received: 7,
        scanned: 6,
        autoHidden: 3,
      });
      expect(a.series.at(-2)).toMatchObject({ scanned: 2, autoHidden: 1 });
      expect(a.series.at(-3)).toMatchObject({ received: 1, scanned: 0 });
      expect(a.series.filter((b) => b.scanned > 0)).toHaveLength(2);
      expect(a.totals).toMatchObject({
        scanned: 8,
        autoHidden: 4,
        received: 8,
        ruleMatched: 1,
      });
      expect(a.intents).toEqual([
        { category: 'SAFE_INQUIRY', count: 1 },
        { category: 'COMPETITOR_POACH', count: 2 },
        { category: 'SCAM_PHISHING', count: 3 },
        { category: 'SPAM_IRRELEVANT', count: 0 },
        { category: 'ABUSIVE_TOXIC', count: 1 },
      ]);
      expect(a.flagged).toEqual(a.intents.slice(1));
    });

    it('a range over 92 days switches to monthly buckets', async () => {
      const a = await analytics({ from: addDays(today, -99), to: today });
      expect(a.granularity).toBe('month');
      expect(a.series[0]!.bucket).toBe(addDays(today, -99).slice(0, 7));
      expect(a.series.at(-1)!.bucket).toBe(today.slice(0, 7));
      expect(a.totals.scanned).toBe(18);
      expect(
        a.series.find((b) => b.bucket === addDays(today, -40).slice(0, 7))!
          .spamIrrelevant,
      ).toBe(10);
    });

    it('filters by Page (both platforms of it)', async () => {
      const a = await analytics({ pageId: pageA.id });
      expect(a.page).toEqual(pageA);
      expect(a.totals).toMatchObject({ scanned: 6, autoHidden: 3 });
      const b = await analytics({ pageId: pageB.id });
      expect(b.totals.scanned).toBe(2);
    });

    it('404 for a Page of another workspace or an unknown one', async () => {
      await get(owner.cookie, owner.workspaceId, '', {
        pageId: otherPage.id,
      }).expect(404);
      await get(owner.cookie, owner.workspaceId, '', {
        pageId: '0b6f9f3e-6a3f-4c55-9a43-0c7c2b0a8e11',
      }).expect(404);
    });

    it.each([
      [{ from: '2026-01-01' }],
      [{ from: '2026-01-10', to: '2026-01-01' }],
      [{ from: '2026/01/01', to: '2026-01-02' }],
      [{ pageId: 'not-a-uuid' }],
      [{ range: '30d' }],
    ])('400 for %j', async (query) => {
      await get(owner.cookie, owner.workspaceId, '', query).expect(400);
    });

    it('400 past today and beyond 12 months', async () => {
      await get(owner.cookie, owner.workspaceId, '', {
        from: today,
        to: addDays(today, 1),
      }).expect(400);
      const res = await get(owner.cookie, owner.workspaceId, '', {
        from: addDays(today, -400),
        to: today,
      }).expect(400);
      expect(res.body.message).toBe('The range may cover at most 12 months');
    });
  });

  describe('GET …/analytics/export.csv (every plan)', () => {
    it('downloads one row per day × Page × platform with every counter', async () => {
      const res = await get(owner.cookie, owner.workspaceId, '/export.csv')
        .buffer(true)
        .expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="shieldcomment-daily-stats-${addDays(today, -29)}-to-${today}.csv"`,
      );
      const lines = csvLines(res.text);
      expect(lines[0]).toBe(DAILY_CSV_HEADER.join(','));
      expect(lines).toHaveLength(5);
      expect(lines[1]).toMatch(/^[\d-]+,\d+,,FACEBOOK,1,0,/);
      expect(lines[2]).toBe(
        `${addDays(today, -1)},${META_B},Shop B,FACEBOOK,0,0,0,2,0,2,0,0,0,0,1,0,0,0,0,0`,
      );
      expect(lines[3]).toBe(
        `${today},${META_A},Shop A,FACEBOOK,7,0,0,4,1,0,3,0,0,1,2,0,0,0,0,0`,
      );
      expect(lines[4]).toBe(
        `${today},${META_A},Shop A,INSTAGRAM,0,0,0,1,0,0,0,0,1,0,0,0,1,0,0,0`,
      );
    });

    it('Page filter + 366-day cap', async () => {
      const res = await get(owner.cookie, owner.workspaceId, '/export.csv', {
        pageId: pageB.id,
        from: addDays(today, -365),
        to: today,
      })
        .buffer(true)
        .expect(200);
      const lines = csvLines(res.text);
      expect(lines.slice(1).map((l) => l.split(',')[0])).toEqual([
        addDays(today, -40),
        addDays(today, -1),
      ]);
      await get(owner.cookie, owner.workspaceId, '/export.csv', {
        from: addDays(today, -366),
        to: today,
      }).expect(400);
    });
  });

  describe('GET …/analytics/comments.csv (Pro only)', () => {
    it('409 PLAN_FEATURE_UNAVAILABLE without a plan and on Growth', async () => {
      const none = await get(
        owner.cookie,
        owner.workspaceId,
        '/comments.csv',
      ).expect(409);
      expect(none.body).toMatchObject({
        code: 'PLAN_FEATURE_UNAVAILABLE',
        details: { feature: 'whiteLabelReports' },
      });
      await actors.activatePlan(owner, 'growth');
      await get(owner.cookie, owner.workspaceId, '/comments.csv').expect(409);
    });

    it('Pro: one row per comment, no author ids or raw payload', async () => {
      await actors.activatePlan(owner, 'pro');
      const res = await get(owner.cookie, owner.workspaceId, '/comments.csv')
        .buffer(true)
        .expect(200);
      expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(res.headers['content-disposition']).toBe(
        `attachment; filename="shieldcomment-comments-${addDays(today, -29)}-to-${today}.csv"`,
      );
      const lines = csvLines(res.text);
      expect(lines[0]).toBe(COMMENTS_CSV_HEADER.join(','));
      expect(lines).toHaveLength(3);
      expect(lines[1]).toMatch(
        new RegExp(
          `^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2},${META_A},Shop A,FACEBOOK,"বিকাশে টাকা পাঠান, ""অফার"" 01712345678",VISIBLE,SCAM_PHISHING,0.912,bn,UNHIDE,USER,SUCCEEDED$`,
        ),
      );
      expect(lines[2]).toMatch(
        new RegExp(
          `,${META_B},Shop B,INSTAGRAM,"'=HYPERLINK\\(""http://evil""\\)",PENDING,,,,,,$`,
        ),
      );
      expect(res.text).not.toContain(AUTHOR_ID);
      expect(res.text).not.toContain('Rahim');
      expect(res.text).not.toContain(RAW_MARKER);
      expect(res.text).not.toContain('other workspace comment');
      expect(res.text).not.toContain('old comment');
    });

    it('Page filter, 92-day cap and foreign Page 404', async () => {
      const res = await get(owner.cookie, owner.workspaceId, '/comments.csv', {
        pageId: pageA.id,
        from: addDays(today, -91),
        to: today,
      })
        .buffer(true)
        .expect(200);
      const lines = csvLines(res.text);
      expect(lines).toHaveLength(3);
      expect(lines.slice(1).every((l) => l.includes(',Shop A,'))).toBe(true);
      expect(lines[1]).toContain('old comment');
      await get(owner.cookie, owner.workspaceId, '/comments.csv', {
        from: addDays(today, -92),
        to: today,
      }).expect(400);
      await get(owner.cookie, owner.workspaceId, '/comments.csv', {
        pageId: otherPage.id,
      }).expect(404);
    });
  });

  describe('access (D7) + tenant isolation', () => {
    it('401 without a session; 404 for a non-member or a malformed id', async () => {
      await actors.http().get(path(owner.workspaceId)).expect(401);
      await actors
        .http()
        .get(path(owner.workspaceId, '/export.csv'))
        .expect(401);
      await get(outsider.cookie, owner.workspaceId).expect(404);
      await get(outsider.cookie, owner.workspaceId, '/export.csv').expect(404);
      await get(outsider.cookie, owner.workspaceId, '/comments.csv').expect(
        404,
      );
      await get(owner.cookie, 'not-a-uuid').expect(404);
    });

    it('a moderator may read analytics and both CSVs', async () => {
      const cookie = await actors.signIn(moderator.email);
      await actors.patchStoredSession(cookie, {
        activeOrganizationId: owner.workspaceId,
      });
      const a = await get(cookie, owner.workspaceId).expect(200);
      expect(a.body.totals.scanned).toBe(8);
      await get(cookie, owner.workspaceId, '/export.csv').expect(200);
      await get(cookie, owner.workspaceId, '/comments.csv').expect(200);
    });

    it('an impersonated session reads its workspace only', async () => {
      const cookie = await actors.signIn(owner.email);
      await actors.patchStoredSession(cookie, {
        impersonatedBy: superAdmin.id,
        activeOrganizationId: owner.workspaceId,
      });
      await get(cookie, owner.workspaceId).expect(200);
      await get(cookie, owner.workspaceId, '/comments.csv').expect(200);
      await actors.addMember(other.workspaceId, owner.id, 'admin');
      await get(cookie, other.workspaceId).expect(404);
    });

    it('each workspace sees only its own counters', async () => {
      const a = (await get(other.cookie, other.workspaceId).expect(200))
        .body as AnalyticsResponse;
      expect(a.totals).toMatchObject({ scanned: 1000, autoHidden: 1000 });
      const res = await get(other.cookie, other.workspaceId, '/export.csv')
        .buffer(true)
        .expect(200);
      const lines = csvLines(res.text);
      expect(lines).toHaveLength(2);
      expect(lines[1]).toContain(`${today},${META_A},,FACEBOOK,`);
    });
  });
});
