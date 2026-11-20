import type { INestApplication } from '@nestjs/common';
import { and, between, desc, eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import { AdminAiService } from '../src/admin/admin-ai.service.js';
import type {
  AiAnalysis,
  AiCreditTopup,
  AiSpendSummary,
} from '../src/admin/dto/admin-ai.dto.js';
import {
  aiCreditTopupAuditLogs,
  aiCreditTopups,
  comments,
  dailyAiUsage,
  moderationActions,
  socialPages,
  workspaces,
} from '../src/db/schema/index.js';
import type { ModerationActionType } from '../src/moderation/moderation.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';

const ANALYSES = '/api/admin/ai/analyses';
const SUMMARY = '/api/admin/ai/summary';
const TOPUPS = '/api/admin/ai/credit-topups';

/** 2030-06-15 12:00 Dhaka: seeded rows sit after anything real, so they lead the log. */
const T = new Date('2030-06-15T06:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const JEV = 'typesafeai-jev-1-14-0';
const UNPRICED = 'e2e-m5t15d-unpriced';
/** `daily_ai_usage` days of this file (deleted in afterAll). */
const USAGE_DAYS = ['2001-01-01', '2001-01-31'] as const;

/**
 * M5-T15d (D25/D26): admin AI analysis log, credit top-ups (+ audit) and the spend summary.
 * Seeded rows only; no external call is made (global `fetch` throws).
 */
describe('Admin AI analyses, top-ups and summary (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  const http = () => actors.http();
  const db = () => actors.db;
  let superAdmin: Actor;
  let client: Actor;
  let workspaceName: string;
  let pageRow: { id: string; pageId: string; pageName: string };
  const fetchSpy = vi.fn(() => {
    throw new Error('unexpected live call');
  });
  let realFetch: typeof fetch;

  const base = `9${Date.now()}`;
  let seq = 0;
  const metaId = () => `${base}${seq++}`;

  async function insertClassified(input: {
    at: Date;
    model: string;
    tokens: [number, number] | null;
    latencyMs: number | null;
    status: 'VISIBLE' | 'HIDDEN' | 'NEEDS_REVIEW' | 'FAILED';
    statusReason?: string;
    withPage?: boolean;
    action?: { type: ModerationActionType; at: Date; failed?: boolean };
  }): Promise<string> {
    const [row] = await db()
      .insert(comments)
      .values({
        commentId: `${pageRow.pageId}_${metaId()}`,
        workspaceId: client.workspaceId,
        socialPageId: input.withPage === false ? null : pageRow.id,
        platform: 'FACEBOOK',
        postId: `${pageRow.pageId}_${metaId()}`,
        message: `bKash cashback ${seq}`,
        status: input.status,
        statusReason: input.statusReason ?? null,
        category: 'SCAM_PHISHING',
        confidence: 0.9,
        language: 'banglish',
        classifiedAt: input.at,
        aiProvider: 'neon',
        model: input.model,
        promptVersion: 'moderation-v2',
        contextLevel: 'comment_only',
        aiInputTokens: input.tokens?.[0] ?? null,
        aiOutputTokens: input.tokens?.[1] ?? null,
        aiLatencyMs: input.latencyMs,
      })
      .returning({ id: comments.id });
    if (input.action) {
      await db()
        .insert(moderationActions)
        .values({
          workspaceId: client.workspaceId,
          commentId: row!.id,
          action: input.action.type,
          source: 'AUTO',
          state: input.action.failed ? 'FAILED' : 'SUCCEEDED',
          errorKind: input.action.failed ? 'permission' : null,
          completedAt: input.action.at,
          createdAt: input.action.at,
        });
    }
    return row!.id;
  }

  const summary = async () =>
    (await http().get(SUMMARY).set('Cookie', superAdmin.cookie).expect(200))
      .body as AiSpendSummary;
  const decisionOf = (s: AiSpendSummary, d: string) =>
    s.spendByDecision.find((x) => x.decision === d)!;

  let before: AiSpendSummary;
  const ids: string[] = [];

  beforeAll(async () => {
    realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    app = await createTestApp();
    app.get(AdminAiService).now = () => T;
    actors = createAuthActors(app);
    superAdmin = await actors.signUpSuperAdmin('m5t15d-super');
    client = await actors.signUp('m5t15d-client');
    const [ws] = await db()
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, client.workspaceId));
    workspaceName = ws!.name;
    const pageId = metaId();
    const [page] = await db()
      .insert(socialPages)
      .values({
        workspaceId: client.workspaceId,
        pageId,
        pageName: `Shop ${pageId}`,
      })
      .returning();
    pageRow = { id: page!.id, pageId, pageName: page!.pageName };

    before = await summary();

    // Newest first: c1 … c5 (c6 is never classified).
    ids.push(
      await insertClassified({
        at: new Date(T.getTime() - HOUR),
        model: 'gpt-oss-20b',
        tokens: [1000, 100],
        latencyMs: 800,
        status: 'HIDDEN',
        action: { type: 'HIDE', at: new Date(T.getTime() - HOUR + 1000) },
      }),
      await insertClassified({
        at: new Date(T.getTime() - 2 * HOUR),
        model: JEV,
        tokens: [1000, 0],
        latencyMs: 450,
        status: 'VISIBLE',
      }),
      // Classified before M5-T15d: no usage stored → cost n/a.
      await insertClassified({
        at: new Date(T.getTime() - 3 * HOUR),
        model: 'gpt-oss-20b',
        tokens: null,
        latencyMs: null,
        status: 'NEEDS_REVIEW',
        statusReason: 'below_threshold',
      }),
      // Unknown price; the Meta delete failed; Page disconnected.
      await insertClassified({
        at: new Date(T.getTime() - 6 * DAY),
        model: UNPRICED,
        tokens: [300, 20],
        latencyMs: 900,
        status: 'FAILED',
        statusReason: 'permission',
        withPage: false,
        action: {
          type: 'DELETE',
          at: new Date(T.getTime() - 6 * DAY + 1000),
          failed: true,
        },
      }),
      // A hide of an older text (before this classification) is not this decision.
      await insertClassified({
        at: new Date(T.getTime() - 8 * DAY),
        model: 'gemini-4-carbon',
        tokens: [500, 50],
        latencyMs: 300,
        status: 'VISIBLE',
        action: { type: 'HIDE', at: new Date(T.getTime() - 9 * DAY) },
      }),
    );
    await db()
      .insert(comments)
      .values({
        commentId: `${pageRow.pageId}_${metaId()}`,
        workspaceId: client.workspaceId,
        socialPageId: pageRow.id,
        platform: 'FACEBOOK',
        postId: `${pageRow.pageId}_${metaId()}`,
        message: 'not analyzed',
      });
    await db()
      .insert(dailyAiUsage)
      .values([
        {
          day: USAGE_DAYS[0],
          provider: 'neon',
          model: 'gpt-oss-20b',
          calls: 3,
          inputTokens: 10_000,
          outputTokens: 1000,
        },
        {
          day: USAGE_DAYS[0],
          provider: 'neon',
          model: UNPRICED,
          calls: 2,
          inputTokens: 40,
          outputTokens: 4,
        },
      ]);
  });

  afterAll(async () => {
    if (actors) {
      await db()
        .delete(dailyAiUsage)
        .where(between(dailyAiUsage.day, USAGE_DAYS[0], USAGE_DAYS[1]));
      await actors.cleanup();
    }
    await app?.close();
    globalThis.fetch = realFetch;
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  describe('access', () => {
    const calls = [
      () => http().get(ANALYSES),
      () => http().get(SUMMARY),
      () => http().get(TOPUPS),
      () => http().post(TOPUPS),
      () => http().delete(`${TOPUPS}/00000000-0000-4000-8000-000000000000`),
    ];

    it('401 signed out, 403 for a workspace owner', async () => {
      for (const call of calls) {
        await call().expect(401);
        const res = await call().set('Cookie', client.cookie).expect(403);
        expect(res.body).toMatchObject({ message: 'Super admin only' });
      }
    });
  });

  describe('GET analyses', () => {
    it('newest classification first, every field, comment text included', async () => {
      const res = await http()
        .get(`${ANALYSES}?limit=5`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const items = res.body.items as AiAnalysis[];
      expect(items.map((i) => i.id)).toEqual(ids);
      expect(items[0]).toEqual({
        id: ids[0],
        classifiedAt: new Date(T.getTime() - HOUR).toISOString(),
        workspace: { id: client.workspaceId, name: workspaceName },
        page: {
          id: pageRow.id,
          pageId: pageRow.pageId,
          name: pageRow.pageName,
        },
        platform: 'FACEBOOK',
        message: expect.stringMatching(/^bKash cashback \d+$/),
        category: 'SCAM_PHISHING',
        confidence: 0.9,
        decision: 'HIDE',
        actionState: 'SUCCEEDED',
        status: 'HIDDEN',
        statusReason: null,
        provider: 'neon',
        model: 'gpt-oss-20b',
        inputTokens: 1000,
        outputTokens: 100,
        latencyMs: 800,
        estimatedCostUsd: 0.0001,
      });
      expect(
        items.map((i) => [i.decision, i.actionState, i.estimatedCostUsd]),
      ).toEqual([
        ['HIDE', 'SUCCEEDED', 0.0001],
        ['NONE', null, 0.000042], // jev: input only
        ['NONE', null, null], // no tokens stored
        ['DELETE', 'FAILED', null], // unknown price
        ['NONE', null, 0], // free model; older hide ignored
      ]);
      expect(items[2]).toMatchObject({
        status: 'NEEDS_REVIEW',
        statusReason: 'below_threshold',
        inputTokens: null,
        outputTokens: null,
        latencyMs: null,
      });
      expect(items[3]).toMatchObject({
        page: null,
        status: 'FAILED',
        statusReason: 'permission',
      });
    });

    it('default limit 20; limit 1–20 else 400', async () => {
      const res = await http()
        .get(ANALYSES)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThanOrEqual(5);
      expect(res.body.items.length).toBeLessThanOrEqual(20);
      const two = await http()
        .get(`${ANALYSES}?limit=2`)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      expect(two.body.items.map((i: AiAnalysis) => i.id)).toEqual(
        ids.slice(0, 2),
      );
      for (const bad of ['21', '0', 'abc', '2.5']) {
        await http()
          .get(`${ANALYSES}?limit=${bad}`)
          .set('Cookie', superAdmin.cookie)
          .expect(400);
      }
      await http()
        .get(`${ANALYSES}?skip=1`)
        .set('Cookie', superAdmin.cookie)
        .expect(400);
    });
  });

  describe('credit top-ups', () => {
    const post = (body: unknown) =>
      http()
        .post(TOPUPS)
        .set('Cookie', superAdmin.cookie)
        .send(body as object);
    let a: AiCreditTopup;
    let b: AiCreditTopup;
    let c: AiCreditTopup;

    it('POST valid → 201 with the creator; blank note = null', async () => {
      a = (
        await post({
          amountUsd: 10.5,
          toppedUpOn: '2030-06-10',
          note: '  Neon card  ',
        }).expect(201)
      ).body.topup;
      expect(a).toEqual({
        id: expect.any(String),
        amountUsd: 10.5,
        toppedUpOn: '2030-06-10',
        note: 'Neon card',
        createdAt: expect.any(String),
        createdBy: { id: superAdmin.id, name: 'm5t15d-super' },
      });
      // Today (Dhaka) is allowed.
      b = (
        await post({
          amountUsd: 2,
          toppedUpOn: '2030-06-15',
          note: ' ',
        }).expect(201)
      ).body.topup;
      expect(b.note).toBeNull();
      c = (await post({ amountUsd: 1, toppedUpOn: '2030-06-12' }).expect(201))
        .body.topup;
    });

    it('POST 400s: amount ≤ 0 / 3 dp / string, bad or future date, long note, unknown field', async () => {
      const ok = { amountUsd: 1, toppedUpOn: '2030-06-01' };
      for (const body of [
        { ...ok, amountUsd: 0 },
        { ...ok, amountUsd: -5 },
        { ...ok, amountUsd: 1.234 },
        { ...ok, amountUsd: '5' },
        { toppedUpOn: ok.toppedUpOn },
        { ...ok, toppedUpOn: '2030-02-30' },
        { ...ok, toppedUpOn: '15-06-2030' },
        { ...ok, note: 'x'.repeat(201) },
        { ...ok, extra: true },
      ]) {
        await post(body).expect(400);
      }
      const future = await post({ ...ok, toppedUpOn: '2030-06-16' }).expect(
        400,
      );
      expect(future.body).toMatchObject({
        statusCode: 400,
        code: 'TOPUP_DATE_IN_FUTURE',
      });
      await post({ ...ok, note: 'x'.repeat(200) })
        .expect(201)
        .then(async (res) => {
          await http()
            .delete(`${TOPUPS}/${res.body.topup.id}`)
            .set('Cookie', superAdmin.cookie)
            .expect(204);
        });
    });

    it('GET: newest top-up date first', async () => {
      const res = await http()
        .get(TOPUPS)
        .set('Cookie', superAdmin.cookie)
        .expect(200);
      const mine = (res.body.items as AiCreditTopup[]).filter((t) =>
        [a.id, b.id, c.id].includes(t.id),
      );
      expect(mine.map((t) => t.id)).toEqual([b.id, c.id, a.id]);
      expect(mine[2]).toEqual(a);
    });

    it('DELETE → 204, then 404; unknown / malformed id 404', async () => {
      const del = (id: string) =>
        http().delete(`${TOPUPS}/${id}`).set('Cookie', superAdmin.cookie);
      await del(c.id).expect(204);
      await del(c.id).expect(404);
      await del('00000000-0000-4000-8000-000000000000').expect(404);
      await del('nope').expect(404);
      const left = await db()
        .select({ id: aiCreditTopups.id })
        .from(aiCreditTopups)
        .where(inArray(aiCreditTopups.id, [a.id, b.id, c.id]));
      expect(left.map((r) => r.id).toSorted()).toEqual([a.id, b.id].toSorted());
    });

    it('every add / delete is audited with a copy of the top-up', async () => {
      const rows = await db()
        .select()
        .from(aiCreditTopupAuditLogs)
        .where(
          and(
            eq(aiCreditTopupAuditLogs.adminId, superAdmin.id),
            inArray(aiCreditTopupAuditLogs.topupId, [a.id, b.id, c.id]),
          ),
        )
        .orderBy(desc(aiCreditTopupAuditLogs.createdAt));
      expect(
        rows.map((r) => [r.action, r.topupId, r.amountUsd, r.toppedUpOn]),
      ).toEqual(
        expect.arrayContaining([
          ['add', a.id, 10.5, '2030-06-10'],
          ['add', b.id, 2, '2030-06-15'],
          ['add', c.id, 1, '2030-06-12'],
          ['delete', c.id, 1, '2030-06-12'],
        ]),
      );
      expect(rows).toHaveLength(4);
      expect(rows.find((r) => r.topupId === a.id)?.note).toBe('Neon card');
    });
  });

  describe('GET summary', () => {
    it('credit, spend, remaining, analyzed counts, tokens, by model and by decision', async () => {
      const after = await summary();
      expect(after).toMatchObject({
        asOf: T.toISOString(),
        timezone: 'Asia/Dhaka',
      });
      expect(after.creditAddedUsd - before.creditAddedUsd).toBeCloseTo(12.5, 6);
      // gpt-oss-20b: 10k × 0.07 + 1k × 0.3 per 1M = 0.001; the unpriced model adds nothing.
      expect(after.estimatedSpendUsd - before.estimatedSpendUsd).toBeCloseTo(
        0.001,
        6,
      );
      expect(after.estimatedRemainingUsd).toBeCloseTo(
        after.creditAddedUsd - after.estimatedSpendUsd,
        6,
      );
      expect(after.unpricedCalls - before.unpricedCalls).toBe(2);
      expect(after.tokens.input - before.tokens.input).toBe(10_040);
      expect(after.tokens.output - before.tokens.output).toBe(1004);
      expect(after.spendByModel).toContainEqual({
        provider: 'neon',
        model: UNPRICED,
        calls: 2,
        inputTokens: 40,
        outputTokens: 4,
        costUsd: null,
      });
      expect({
        total: after.commentsAnalyzed.total - before.commentsAnalyzed.total,
        today: after.commentsAnalyzed.today - before.commentsAnalyzed.today,
        last7Days:
          after.commentsAnalyzed.last7Days - before.commentsAnalyzed.last7Days,
      }).toEqual({ total: 5, today: 3, last7Days: 4 });
      expect(after.spendByDecision.map((d) => d.decision)).toEqual([
        'NONE',
        'HIDE',
        'DELETE',
      ]);
      const delta = (d: string) => {
        const [x, y] = [decisionOf(after, d), decisionOf(before, d)];
        return {
          comments: x.comments - y.comments,
          costUsd: Math.round((x.costUsd - y.costUsd) * 1e6) / 1e6,
          unpricedComments: x.unpricedComments - y.unpricedComments,
        };
      };
      expect(delta('NONE')).toEqual({
        comments: 3,
        costUsd: 0.000042,
        unpricedComments: 1,
      });
      expect(delta('HIDE')).toEqual({
        comments: 1,
        costUsd: 0.0001,
        unpricedComments: 0,
      });
      expect(delta('DELETE')).toEqual({
        comments: 1,
        costUsd: 0,
        unpricedComments: 1,
      });
    });
  });
});
