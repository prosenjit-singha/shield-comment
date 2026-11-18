import type { INestApplication } from '@nestjs/common';
import type { Job } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import type { App } from 'supertest/types.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../src/crypto/token-cipher.service.js';
import {
  comments,
  dailyCommentStats,
  type MetaConnectionStatus,
  metaConnections,
} from '../src/db/schema/index.js';
import type { RawPayloadPurgeOutcome } from '../src/comments/raw-payload-purge.js';
import { MetaJobSchedulers } from '../src/meta-callbacks/meta-job-schedulers.js';
import {
  META_DEBUG_TOKEN_JOB_NAME,
  RAW_PAYLOAD_PURGE_JOB_NAME,
} from '../src/meta-callbacks/meta-scheduled.jobs.js';
import {
  MetaTokenCheckProcessor,
  type MetaTokenCheckResult,
} from '../src/meta-callbacks/meta-token-check.processor.js';
import {
  MetaTokenCheckService,
  type TokenCheckOutcome,
} from '../src/meta-callbacks/meta-token-check.service.js';
import {
  MetaGraphClient,
  type MetaTokenDebugInfo,
} from '../src/meta/meta-graph.client.js';
import { META_LOGIN_SCOPES } from '../src/meta/meta-graph.config.js';
import { MetaGraphError } from '../src/meta/meta-graph.errors.js';
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from '../src/queue/queue.constants.js';
import { type Actor, createAuthActors } from './utils/auth-actors.js';
import { createTestApp } from './utils/create-test-app.js';
import { fakeQueue } from './utils/fake-queue.js';

const DAY = 24 * 60 * 60 * 1000;
const ALL = [...META_LOGIN_SCOPES];
const EXPIRES = new Date('2027-01-15T00:00:00.000Z');

/**
 * M4-T7: scheduled jobs on `meta-token-check` (Module 4 D3/D4/D8) against the real test DB.
 * Schedulers land on the FakeQueue at boot; the jobs run through the real processor
 * (`FakeWorker`, no Redis); `MetaGraphClient` is a fake that fails on any token it doesn't know.
 */
describe('Scheduled jobs: debug_token check + raw_payload purge (e2e)', () => {
  let app: INestApplication<App>;
  let actors: ReturnType<typeof createAuthActors>;
  let processor: MetaTokenCheckProcessor;
  let cipher: TokenCipherService;
  /** Plain token → what Meta answers. Unknown token → the test fails. */
  const answers = new Map<string, MetaTokenDebugInfo | MetaGraphError>();
  const graph = {
    enabled: true,
    debugToken: vi.fn((token: string): Promise<MetaTokenDebugInfo> => {
      const answer = answers.get(token);
      if (answer === undefined) {
        return Promise.reject(new Error('unexpected debug_token call'));
      }
      return answer instanceof MetaGraphError
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    }),
  };

  const base = `7${Date.now()}`;
  const fbUser = (n: number) => `${base}0${n}`;
  const commentId = (n: number) => `${base}5${n}_${base}6${n}`;
  const db = () => actors.db;

  const run = async <T extends MetaTokenCheckResult>(name: string) =>
    (await processor.process({
      id: `repeat:${name}:1`,
      name,
      data: {},
      opts: { ...DEFAULT_JOB_OPTIONS },
      attemptsMade: 0,
    } as unknown as Job<unknown, MetaTokenCheckResult>)) as T;

  const connection = (actor: Actor) =>
    db()
      .select()
      .from(metaConnections)
      .where(eq(metaConnections.workspaceId, actor.workspaceId))
      .then((rows) => rows[0]!);

  const statusChangedLongAgo = new Date(Date.now() - 10 * DAY);

  async function connect(
    actor: Actor,
    n: number,
    status: MetaConnectionStatus,
    answer?: MetaTokenDebugInfo | MetaGraphError,
  ) {
    const plain = `EAAG-e2e-token-${base}-${n}`;
    if (answer) answers.set(plain, answer);
    await db()
      .insert(metaConnections)
      .values({
        workspaceId: actor.workspaceId,
        facebookUserId: fbUser(n),
        encryptedUserAccessToken:
          status === 'REVOKED'
            ? null
            : cipher.encrypt(
                plain,
                tokenCipherContext(
                  'meta_user_token',
                  actor.workspaceId,
                  fbUser(n),
                ),
              ),
        tokenExpiresAt: EXPIRES,
        grantedScopes: ALL,
        status,
        statusChangedAt: statusChangedLongAgo,
      });
  }

  let active: Actor; // valid → stays ACTIVE
  let fixed: Actor; // NEEDS_REAUTH, valid again → ACTIVE
  let invalid: Actor; // is_valid false → NEEDS_REAUTH
  let scopeless: Actor; // scope removed → NEEDS_REAUTH
  let revoked: Actor; // REVOKED → never checked
  let flaky: Actor; // transient Graph error → unchanged
  let graphInvalid: Actor; // Graph token_invalid → NEEDS_REAUTH

  beforeAll(async () => {
    app = await createTestApp((builder) =>
      builder.overrideProvider(MetaGraphClient).useValue(graph),
    );
    actors = createAuthActors(app);
    processor = app.get(MetaTokenCheckProcessor);
    cipher = app.get(TokenCipherService);
    app.get(MetaTokenCheckService).pauseMs = 0;
    active = await actors.signUp('m4t7-active');
    fixed = await actors.signUp('m4t7-fixed');
    invalid = await actors.signUp('m4t7-invalid');
    scopeless = await actors.signUp('m4t7-scopeless');
    revoked = await actors.signUp('m4t7-revoked');
    flaky = await actors.signUp('m4t7-flaky');
    graphInvalid = await actors.signUp('m4t7-graph-invalid');
    for (let n = 1; n <= 7; n++) actors.trackFacebookUser(fbUser(n));
    const valid = { isValid: true, scopes: ALL, expiresAt: EXPIRES };
    await connect(active, 1, 'ACTIVE', valid);
    await connect(fixed, 2, 'NEEDS_REAUTH', valid);
    await connect(invalid, 3, 'ACTIVE', {
      isValid: false,
      scopes: [],
      expiresAt: null,
    });
    await connect(scopeless, 4, 'ACTIVE', {
      isValid: true,
      scopes: ALL.filter((s) => s !== 'pages_manage_engagement'),
      expiresAt: new Date('2027-02-01T00:00:00.000Z'),
    });
    await connect(revoked, 5, 'REVOKED');
    await connect(
      flaky,
      6,
      'ACTIVE',
      new MetaGraphError('transient', 'Meta Graph 500: x'),
    );
    await connect(
      graphInvalid,
      7,
      'ACTIVE',
      new MetaGraphError('token_invalid', 'Meta Graph 400 (#190): x'),
    );
  });

  afterAll(async () => {
    await actors?.cleanup();
    await app?.close();
  });

  it('registers both job schedulers at boot (Asia/Dhaka, D3 job options)', async () => {
    await app.get(MetaJobSchedulers).ready;
    const schedulers = await fakeQueue(
      app,
      QUEUE_NAMES.metaTokenCheck,
    ).getJobSchedulers();
    expect(schedulers).toEqual([
      {
        id: 'meta-debug-token-daily',
        repeat: { pattern: '0 3 * * *', tz: 'Asia/Dhaka' },
        template: {
          name: META_DEBUG_TOKEN_JOB_NAME,
          data: {},
          opts: { ...DEFAULT_JOB_OPTIONS },
        },
      },
      {
        id: 'raw-payload-purge-daily',
        repeat: { pattern: '30 3 * * *', tz: 'Asia/Dhaka' },
        template: {
          name: RAW_PAYLOAD_PURGE_JOB_NAME,
          data: {},
          opts: { ...DEFAULT_JOB_OPTIONS },
        },
      },
    ]);
    // Scheduling adds no job by itself.
    expect(fakeQueue(app, QUEUE_NAMES.metaTokenCheck).jobs).toHaveLength(0);
  });

  describe('debug-token job', () => {
    it('maps every checked connection; REVOKED is never checked', async () => {
      const before = await connection(revoked);
      const outcome = await run<TokenCheckOutcome>(META_DEBUG_TOKEN_JOB_NAME);
      expect(outcome).toEqual({
        kind: 'token_check',
        rateLimited: false,
        counts: {
          checked: 6,
          unchanged: 1,
          toActive: 1,
          toNeedsReauth: 3,
          expiryRefreshed: 0,
          raced: 0,
          graphErrors: 1,
          undecryptable: 0,
          notChecked: 0,
        },
      });
      // Called with decrypted tokens only, never for the REVOKED row.
      expect(graph.debugToken).toHaveBeenCalledTimes(6);
      for (const [token] of graph.debugToken.mock.calls) {
        expect(answers.has(token)).toBe(true);
      }

      const a = await connection(active);
      expect(a.status).toBe('ACTIVE');
      expect(a.statusChangedAt).toEqual(statusChangedLongAgo);

      const f = await connection(fixed);
      expect(f.status).toBe('ACTIVE');
      expect(f.statusChangedAt.getTime()).toBeGreaterThan(
        statusChangedLongAgo.getTime(),
      );

      for (const actor of [invalid, scopeless, graphInvalid]) {
        const row = await connection(actor);
        expect(row.status).toBe('NEEDS_REAUTH');
        expect(row.statusChangedAt.getTime()).toBeGreaterThan(
          statusChangedLongAgo.getTime(),
        );
        expect(row.encryptedUserAccessToken).not.toBeNull();
      }
      // A valid token with a missing scope still refreshes the expiry Meta reported.
      expect((await connection(scopeless)).tokenExpiresAt).toEqual(
        new Date('2027-02-01T00:00:00.000Z'),
      );
      // An invalid token keeps the stored expiry.
      expect((await connection(invalid)).tokenExpiresAt).toEqual(EXPIRES);

      expect(await connection(flaky)).toMatchObject({
        status: 'ACTIVE',
        statusChangedAt: statusChangedLongAgo,
      });
      expect(await connection(revoked)).toEqual(before);
    });

    it('a second run changes nothing: status_changed_at moved exactly once', async () => {
      const ids = [active, fixed, invalid, scopeless, flaky, graphInvalid].map(
        (a) => a.workspaceId,
      );
      const snapshot = await db()
        .select()
        .from(metaConnections)
        .where(inArray(metaConnections.workspaceId, ids));
      graph.debugToken.mockClear();
      const outcome = await run<TokenCheckOutcome>(META_DEBUG_TOKEN_JOB_NAME);
      expect(outcome).toMatchObject({
        counts: {
          checked: 6,
          unchanged: 5,
          toActive: 0,
          toNeedsReauth: 0,
          graphErrors: 1,
        },
      });
      const after = await db()
        .select()
        .from(metaConnections)
        .where(inArray(metaConnections.workspaceId, ids));
      const byId = (rows: typeof after) =>
        Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId(after)).toEqual(byId(snapshot));
    });

    it('a Deauthorize during the check wins: the verdict is dropped (raced)', async () => {
      // Rows are checked in id order, so the first call is `active`'s. While Meta "answers",
      // Deauthorize revokes that row; the conditional UPDATE must not touch it.
      graph.debugToken.mockClear();
      graph.debugToken.mockImplementationOnce(async () => {
        await db()
          .update(metaConnections)
          .set({ status: 'REVOKED', encryptedUserAccessToken: null })
          .where(eq(metaConnections.workspaceId, active.workspaceId));
        return { isValid: false, scopes: [], expiresAt: null };
      });
      const outcome = await run<TokenCheckOutcome>(META_DEBUG_TOKEN_JOB_NAME);
      expect(outcome).toMatchObject({
        counts: { checked: 6, raced: 1, toNeedsReauth: 0 },
      });
      expect(await connection(active)).toMatchObject({
        status: 'REVOKED',
        encryptedUserAccessToken: null,
      });
    });
  });

  describe('raw-payload-purge job', () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

    it('clears raw_payload only on rows older than 30 days, in every workspace', async () => {
      const updatedAt = daysAgo(31);
      const seed = (
        actor: Actor,
        n: number,
        createdAt: Date,
        rawPayload: Record<string, unknown> | null,
      ) =>
        db()
          .insert(comments)
          .values({
            commentId: commentId(n),
            workspaceId: actor.workspaceId,
            platform: 'FACEBOOK',
            postId: `${base}9_1`,
            authorId: '42',
            authorName: 'Rahim',
            message: `bKash 017 #${n}`,
            rawPayload,
            createdAt,
            updatedAt,
          });
      await seed(active, 1, daysAgo(31), { message: 'old A' });
      await seed(fixed, 2, daysAgo(45), { message: 'old B' });
      await seed(active, 3, daysAgo(29), { message: 'recent' });
      await seed(active, 4, daysAgo(40), null);
      await db()
        .insert(dailyCommentStats)
        .values({
          workspaceId: active.workspaceId,
          pageId: `${base}11`,
          platform: 'FACEBOOK',
          day: '2026-10-01',
          receivedCount: 3,
        });

      const outcome = await run<RawPayloadPurgeOutcome>(
        RAW_PAYLOAD_PURGE_JOB_NAME,
      );
      expect(outcome).toMatchObject({
        kind: 'raw_payload_purge',
        purged: 2,
        batches: 1,
        complete: true,
      });

      const rows = await db()
        .select()
        .from(comments)
        .where(
          inArray(
            comments.commentId,
            [1, 2, 3, 4].map((n) => commentId(n)),
          ),
        );
      const byComment = Object.fromEntries(rows.map((r) => [r.commentId, r]));
      for (const n of [1, 2]) {
        expect(byComment[commentId(n)]).toMatchObject({
          rawPayload: null,
          message: `bKash 017 #${n}`,
          authorName: 'Rahim',
          status: 'PENDING',
          updatedAt,
        });
      }
      expect(byComment[commentId(3)]!.rawPayload).toEqual({
        message: 'recent',
      });
      expect(byComment[commentId(4)]!.rawPayload).toBeNull();
      expect(
        await db()
          .select()
          .from(dailyCommentStats)
          .where(eq(dailyCommentStats.workspaceId, active.workspaceId)),
      ).toEqual([expect.objectContaining({ receivedCount: 3 })]);

      // Nothing left: a rerun purges nothing.
      expect(
        await run<RawPayloadPurgeOutcome>(RAW_PAYLOAD_PURGE_JOB_NAME),
      ).toMatchObject({ purged: 0, batches: 1 });
    });
  });
});
