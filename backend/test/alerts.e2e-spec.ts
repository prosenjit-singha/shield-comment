import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AiGatewayService } from '../src/ai-gateway/ai-gateway.service.js';
import {
  AlertRetryError,
  type ScamSpikeOutcome,
} from '../src/alerts/alert-dispatch.service.js';
import { AlertStore } from '../src/alerts/alert.store.js';
import { AlertsProcessor } from '../src/alerts/alerts.processor.js';
import {
  alertCooldownKey,
  SCAM_SPIKE_JOB_NAME,
} from '../src/alerts/scam-spike.js';
import { TELEGRAM_CONFIG } from '../src/alerts/telegram.client.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  alertDeliveries,
  alertSettings,
  comments,
  dailyAiUsage,
  metaConnections,
  socialPages,
  telegramChats,
  workspaceMembers,
} from '../src/db/schema/index.js';
import { EmailService } from '../src/email/email.service.js';
import { MODERATE_COMMENT_JOB_NAME } from '../src/moderation/comment-moderation.job.js';
import { CommentModerationProcessor } from '../src/moderation/comment-moderation.processor.js';
import type { ModerationResult } from '../src/moderation/comment-moderation.service.js';
import { QUEUE_NAMES } from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakeAiGateway } from './utils/fake-ai-gateway.js';
import { createEmailServiceFake } from './utils/fake-email.js';
import { type FakeJob, fakeQueue } from './utils/fake-queue.js';
import { MemoryAlertStore } from './utils/memory-alert-store.js';
import { startTelegramStub } from './utils/telegram-stub.js';

const TOKEN = '123456789:e2e-alerts-token-abcdefghijklmnopqrstu';
const TEST_MODEL = 'm7t9-e2e-model';
const SCAM_TEXT = 'bKash e 500 taka cashback, ei number e call korun';

/**
 * M7-T9 (D12/D14/D15/D17 answered 2026-11-20): scam-spike detector → `alerts` queue → dispatcher,
 * and "Send test alert". Real Postgres; the LLM is a strict fake, email is the strict fake
 * (`expectSends`), the Bot API is a local stub that fails on unexpected requests, Redis is a memory
 * store. Comments reach the detector through the real moderation worker (`process(job)`).
 */
describe('Scam spike alerts (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let cipher: TokenCipherService;
  let stub: Awaited<ReturnType<typeof startTelegramStub>>;
  const email = createEmailServiceFake();
  const ai = fakeAiGateway();
  const store = new MemoryAlertStore();
  let owner: Actor;
  let moderator: Actor;
  let starter: Actor;
  let outsider: Actor;
  let pageA: string;
  let pageS: string;

  const base = `7${Date.now()}`;
  let seq = 100;
  const next = () => `${base}${seq++}`;
  const db = () => actors.db;
  const http = () => request(app.getHttpServer());
  const alertsQueue = () => fakeQueue(app, QUEUE_NAMES.alerts);

  async function connectPage(workspaceId: string): Promise<string> {
    const fbUserId = next();
    // NEEDS_REAUTH: classified, the Meta action is skipped (no Graph call in this spec).
    await db()
      .insert(metaConnections)
      .values({
        workspaceId,
        facebookUserId: fbUserId,
        encryptedUserAccessToken: cipher.encrypt(
          `EAAuser${fbUserId}`,
          tokenCipherContext('meta_user_token', workspaceId, fbUserId),
        ),
        grantedScopes: ['pages_manage_engagement'],
        status: 'NEEDS_REAUTH',
      });
    const pageId = next();
    const [row] = await db()
      .insert(socialPages)
      .values({
        workspaceId,
        pageId,
        pageName: `Shop ${pageId}`,
        encryptedPageAccessToken: cipher.encrypt(
          `EAApage${pageId}`,
          tokenCipherContext('meta_page_token', workspaceId, pageId),
        ),
        isActive: true,
      })
      .returning();
    return row!.id;
  }

  /** Already-moderated rule scams (reading 8: `rule_url` / `rule_phone`, no category). */
  async function seedScams(
    workspaceId: string,
    socialPageId: string,
    count: number,
    { minutesAgo = 5, reason = 'rule_url' } = {},
  ) {
    for (let i = 0; i < count; i += 1)
      await db()
        .insert(comments)
        .values({
          commentId: `${next()}_${next()}`,
          workspaceId,
          socialPageId,
          platform: 'FACEBOOK',
          postId: `${next()}_${next()}`,
          message: SCAM_TEXT,
          status: 'HIDDEN',
          statusReason: i % 2 ? 'rule_phone' : reason,
          createdAt: new Date(Date.now() - minutesAgo * 60_000),
        });
  }

  /** One new comment through the real moderation worker, classified as `category`. */
  async function moderate(
    workspaceId: string,
    socialPageId: string,
    category = 'SCAM_PHISHING',
  ): Promise<ModerationResult> {
    const [row] = await db()
      .insert(comments)
      .values({
        commentId: `${next()}_${next()}`,
        workspaceId,
        socialPageId,
        platform: 'FACEBOOK',
        postId: `${next()}_${next()}`,
        message: SCAM_TEXT,
        moderationStage: 'classify',
      })
      .returning();
    ai.replyWith({
      model: TEST_MODEL,
      content: JSON.stringify({
        category,
        confidence_score: 0.97,
        reasoning: 'Test reasoning.',
        language: 'banglish',
      }),
    });
    return app.get(CommentModerationProcessor).process({
      id: `moderate:${row!.id}:add`,
      name: MODERATE_COMMENT_JOB_NAME,
      data: { workspaceId, commentRowId: row!.id, editedAt: null },
      opts: { attempts: 5 },
      attemptsMade: 0,
    } as unknown as Job) as Promise<ModerationResult>;
  }

  /** Runs a recorded `scam-spike` job through the real worker. */
  function runAlert(job: FakeJob, attemptsMade = 0) {
    const fake = {
      ...job,
      attemptsMade,
      updateData: vi.fn(async (data: unknown) => {
        job.data = data;
      }),
    };
    return {
      fake,
      result: app
        .get(AlertsProcessor)
        .process(fake as unknown as Job) as Promise<ScamSpikeOutcome>,
    };
  }

  const deliveriesOf = (workspaceId: string) =>
    db()
      .select()
      .from(alertDeliveries)
      .where(eq(alertDeliveries.workspaceId, workspaceId))
      .orderBy(alertDeliveries.sentAt, alertDeliveries.channel);
  const patchSettings = (actor: Actor, body: object) =>
    http()
      .patch(`/api/workspaces/${actor.workspaceId}/alerts/settings`)
      .set('Cookie', actor.cookie)
      .send(body)
      .expect(200);
  const linkChat = (workspaceId: string, telegramChatId: number) =>
    db().insert(telegramChats).values({
      workspaceId,
      telegramChatId,
      title: 'Shop team',
      type: 'group',
    });
  const ownerMemberId = async (actor: Actor) =>
    (
      await db()
        .select({ id: workspaceMembers.id })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, actor.workspaceId),
            eq(workspaceMembers.userId, actor.id),
          ),
        )
    )[0]!.id;
  /** Fresh alert state for the next case (cool-down, recorded jobs, delivery rows). */
  async function resetAlerts(workspaceId: string) {
    await store.release(alertCooldownKey(workspaceId));
    alertsQueue().reset();
    await db()
      .delete(alertDeliveries)
      .where(eq(alertDeliveries.workspaceId, workspaceId));
    await db().delete(comments).where(eq(comments.workspaceId, workspaceId));
  }

  beforeAll(async () => {
    stub = await startTelegramStub(TOKEN);
    app = await createTestApp((b) =>
      b
        .overrideProvider(EmailService)
        .useValue(email)
        .overrideProvider(AiGatewayService)
        .useValue(ai)
        .overrideProvider(AlertStore)
        .useValue(store)
        .overrideProvider(TELEGRAM_CONFIG)
        .useValue({
          botToken: TOKEN,
          botUsername: 'ShieldTestBot',
          webhookSecret: 'e2e-telegram-webhook-secret-0123',
          apiBaseUrl: stub.url,
        }),
    );
    actors = createAuthActors(app);
    cipher = app.get(TokenCipherService);
    owner = await actors.signUp('m7t9-owner');
    moderator = await actors.signUp('m7t9-mod');
    starter = await actors.signUp('m7t9-starter', { trial: true });
    outsider = await actors.signUp('m7t9-outsider');
    await actors.addMember(owner.workspaceId, moderator.id, 'moderator');
    await actors.activatePlan(owner, 'growth');
    pageA = await connectPage(owner.workspaceId);
    pageS = await connectPage(starter.workspaceId);
    await linkChat(owner.workspaceId, 5001);
    await patchSettings(owner, {
      spikeThreshold: 3,
      emailEnabled: true,
      telegramEnabled: true,
    });
  });

  afterEach(() => {
    expect(email.unexpected).toEqual([]);
    expect(email.pending).toBe(0);
    expect(stub.unexpected).toEqual([]);
    expect(ai.pending).toBe(0);
    email.reset();
    ai.reset();
    stub.sent.length = 0;
    stub.failed.length = 0;
    stub.failures.clear();
  });

  afterAll(async () => {
    if (actors) {
      await db().delete(dailyAiUsage).where(eq(dailyAiUsage.model, TEST_MODEL));
      await actors.cleanup();
    }
    await app?.close();
    await stub?.close();
  });

  it('D17: threshold reached in the worker → one email + one Telegram message + delivery rows; none inside the cool-down', async () => {
    await seedScams(owner.workspaceId, pageA, 2);
    // Outside the window / not a scam: never counted.
    await seedScams(owner.workspaceId, pageA, 1, { minutesAgo: 61 });
    await seedScams(owner.workspaceId, pageA, 1, { reason: 'rule_keyword' });

    expect(await moderate(owner.workspaceId, pageA)).toMatchObject({
      kind: 'moderated',
      status: 'NEEDS_REVIEW',
      metaSkip: 'connection_needs_reauth',
    });
    expect(alertsQueue().jobs).toHaveLength(1);
    const [job] = alertsQueue().jobs;
    expect(job).toMatchObject({
      name: SCAM_SPIKE_JOB_NAME,
      id: expect.stringMatching(
        new RegExp(`^scam-spike:${owner.workspaceId}:\\d+$`),
      ),
      data: { workspaceId: owner.workspaceId, scamCount: 3, threshold: 3 },
      opts: { attempts: 5, backoff: { type: 'exponential', delay: 2000 } },
    });
    expect(store.ttl(alertCooldownKey(owner.workspaceId))).toBe(3600);

    email.expectSends(1);
    const { result } = runAlert(job!);
    expect(await result).toEqual({
      kind: 'delivered',
      deliveries: [
        { channel: 'EMAIL', status: 'SENT', errorKind: null },
        { channel: 'TELEGRAM', status: 'SENT', errorKind: null },
      ],
    });
    // D15 default: the owner only. No comment text anywhere.
    expect(email.sent).toHaveLength(1);
    const mail = email.sent[0]!;
    expect(mail.to).toBe(owner.email);
    expect(mail.subject).toContain('Scam spike: 3 scam comments');
    expect(mail.text).toContain('/dashboard');
    expect(mail.idempotencyKey).toBe(
      `alert:${job!.id}:${await ownerMemberId(owner)}`,
    );
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0]!.chatId).toBe(5001);
    expect(stub.sent[0]!.text).toContain('Scam spike');
    expect(stub.sent[0]!.text).toContain('স্ক্যাম');
    for (const text of [mail.text, mail.html, stub.sent[0]!.text])
      expect(text).not.toContain('cashback');
    expect(await deliveriesOf(owner.workspaceId)).toEqual([
      expect.objectContaining({
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 3,
        errorKind: null,
        isTest: false,
      }),
      expect.objectContaining({
        channel: 'TELEGRAM',
        status: 'SENT',
        scamCount: 3,
        isTest: false,
      }),
    ]);
    const settings = await http()
      .get(`/api/workspaces/${owner.workspaceId}/alerts/settings`)
      .set('Cookie', moderator.cookie)
      .expect(200);
    expect(settings.body.lastAlerts).toHaveLength(2);

    // A second spike inside the cool-down: no job, nothing sent.
    await seedScams(owner.workspaceId, pageA, 3);
    await moderate(owner.workspaceId, pageA);
    expect(alertsQueue().jobs).toHaveLength(1);
    expect(await deliveriesOf(owner.workspaceId)).toHaveLength(2);
  });

  it('below the threshold, or a non-scam outcome, enqueues nothing', async () => {
    await resetAlerts(owner.workspaceId);
    await seedScams(owner.workspaceId, pageA, 1);
    await moderate(owner.workspaceId, pageA);
    expect(alertsQueue().jobs).toHaveLength(0);
    // 3 scams in the window, but this outcome is SAFE: D14 checks on scam outcomes only.
    await seedScams(owner.workspaceId, pageA, 1);
    await moderate(owner.workspaceId, pageA, 'SAFE_INQUIRY');
    expect(alertsQueue().jobs).toHaveLength(0);
    expect(store.ttl(alertCooldownKey(owner.workspaceId))).toBeNull();
  });

  it('an enqueue failure never fails moderation and gives the cool-down back', async () => {
    await resetAlerts(owner.workspaceId);
    await seedScams(owner.workspaceId, pageA, 2);
    alertsQueue().failAdds(new Error('Connection is closed.'));
    expect(await moderate(owner.workspaceId, pageA)).toMatchObject({
      kind: 'moderated',
    });
    expect(store.ttl(alertCooldownKey(owner.workspaceId))).toBeNull();
    alertsQueue().failAdds(null);
  });

  it('Starter (no messengerAlerts): email only, the saved Telegram setting and chat stay unused', async () => {
    await db().insert(alertSettings).values({
      workspaceId: starter.workspaceId,
      spikeThreshold: 1,
      emailEnabled: true,
      telegramEnabled: true,
    });
    await linkChat(starter.workspaceId, 5002);
    await moderate(starter.workspaceId, pageS);
    const [job] = alertsQueue().jobs.filter(
      (j) =>
        (j.data as { workspaceId: string }).workspaceId === starter.workspaceId,
    );
    email.expectSends(1);
    expect(await runAlert(job!).result).toEqual({
      kind: 'delivered',
      deliveries: [{ channel: 'EMAIL', status: 'SENT', errorKind: null }],
    });
    expect(email.sent[0]!.to).toBe(starter.email);
    expect(stub.sent).toEqual([]);
    expect(await deliveriesOf(starter.workspaceId)).toEqual([
      expect.objectContaining({
        channel: 'EMAIL',
        status: 'SENT',
        scamCount: 1,
      }),
    ]);
  });

  it('Telegram failure → FAILED row with the kind; a retryable one retries without re-sending', async () => {
    await resetAlerts(owner.workspaceId);
    await linkChat(owner.workspaceId, 5003);
    await seedScams(owner.workspaceId, pageA, 2);
    await moderate(owner.workspaceId, pageA);
    const [job] = alertsQueue().jobs;

    // Attempt 1: chat 5003 answers 500 → retry pending, no rows, the delivered targets are saved.
    stub.failChat(5003, 500, 'Internal Server Error');
    email.expectSends(1);
    const first = runAlert(job!, 0);
    await expect(first.result).rejects.toBeInstanceOf(AlertRetryError);
    expect(first.fake.updateData).toHaveBeenCalledTimes(1);
    expect((job!.data as { sent: string[] }).sent).toHaveLength(2);
    expect(stub.sent.map((m) => m.chatId)).toEqual([5001]);
    expect(await deliveriesOf(owner.workspaceId)).toEqual([]);

    // Attempt 2: only 5003 again (the email fake is unarmed: a re-send would throw); now blocked.
    stub.sent.length = 0;
    stub.failChat(5003, 403, 'Forbidden: bot was blocked by the user');
    expect(await runAlert(job!, 1).result).toEqual({
      kind: 'delivered',
      deliveries: [
        { channel: 'EMAIL', status: 'SENT', errorKind: null },
        {
          channel: 'TELEGRAM',
          status: 'FAILED',
          errorKind: 'chat_unavailable',
        },
      ],
    });
    expect(stub.sent).toEqual([]);
    expect(stub.failed.map((m) => m.chatId)).toEqual([5003, 5003]);
    expect(await deliveriesOf(owner.workspaceId)).toEqual([
      expect.objectContaining({ channel: 'EMAIL', status: 'SENT' }),
      expect.objectContaining({
        channel: 'TELEGRAM',
        status: 'FAILED',
        errorKind: 'chat_unavailable',
      }),
    ]);
    await db()
      .delete(telegramChats)
      .where(eq(telegramChats.telegramChatId, 5003));
  });

  describe('Send test alert (reading 12)', () => {
    const test = (actor: Actor, ws = actor.workspaceId) =>
      http()
        .post(`/api/workspaces/${ws}/alerts/test`)
        .set('Cookie', actor.cookie);

    it('moderator 403, non-member 404, no channel 409', async () => {
      await test(moderator, owner.workspaceId).expect(403);
      await test(outsider, owner.workspaceId).expect(404);
      const res = await test(outsider).expect(409);
      expect(res.body.code).toBe('ALERT_NO_CHANNEL');
    });

    it('sends through the real channels, rows marked test (not the last alert), no cool-down, 5 per hour', async () => {
      await resetAlerts(owner.workspaceId);
      for (let i = 0; i < 5; i += 1) {
        email.expectSends(1);
        const res = await test(owner).expect(200);
        expect(res.body).toEqual({
          deliveries: [
            { channel: 'EMAIL', status: 'SENT', errorKind: null },
            { channel: 'TELEGRAM', status: 'SENT', errorKind: null },
          ],
        });
      }
      expect(email.sent[0]!.subject).toContain('Test alert');
      expect(email.sent[0]!.text).toContain('/settings/alerts');
      expect(stub.sent).toHaveLength(5);
      expect(stub.sent[0]!.text).toContain('পরীক্ষামূলক');

      const res = await test(owner).expect(429);
      expect(res.body).toMatchObject({
        code: 'ALERT_TEST_RATE_LIMITED',
        details: { max: 5 },
      });
      const rows = await deliveriesOf(owner.workspaceId);
      expect(rows).toHaveLength(10);
      expect(rows.every((r) => r.isTest && r.scamCount === 0)).toBe(true);
      expect(store.ttl(alertCooldownKey(owner.workspaceId))).toBeNull();
      const settings = await http()
        .get(`/api/workspaces/${owner.workspaceId}/alerts/settings`)
        .set('Cookie', owner.cookie)
        .expect(200);
      expect(settings.body.lastAlerts).toEqual([]);
    });
  });
});
