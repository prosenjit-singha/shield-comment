import {
  fbCommentValue,
  fbPayload,
  igPayload,
} from '../../test/fixtures/meta-webhook-payloads.js';
import type { Database } from '../db/database.js';
import type { CommentIngestJobData } from '../webhooks/comment-ingest.job.js';
import { parseMetaWebhookEnvelope } from '../webhooks/meta-webhook-envelope.js';
import * as ingestQueries from './comment-ingest.queries.js';
import type { IngestRoute } from './comment-ingest.rules.js';
import { CommentIngestService } from './comment-ingest.service.js';
import * as commentQueries from './comments.queries.js';

vi.mock('./comment-ingest.queries.js', () => ({
  findIngestRoute: vi.fn(),
  applyCommentEdit: vi.fn(),
  markCommentDeleted: vi.fn(),
}));
vi.mock('./comments.queries.js', async (importOriginal) => {
  const actual = await importOriginal<typeof commentQueries>();
  return {
    ...actual,
    insertWebhookEvent: vi.fn(),
    insertComment: vi.fn(),
    incrementDailyCommentStats: vi.fn(),
    markWebhookEventProcessed: vi.fn(),
  };
});

const q = vi.mocked(ingestQueries);
const c = vi.mocked(commentQueries);

const tx = { tx: true };
const transaction = vi.fn((fn: (t: unknown) => unknown) => fn(tx));
const db = { transaction } as unknown as Database;

const ROUTE: IngestRoute = {
  workspaceId: 'ws-1',
  socialPageId: 'page-row-1',
  pageId: '1000000000001',
  isActive: true,
  connectionStatus: 'ACTIVE',
};

/** entry.time of the fixtures (1763480000 = 2025-11-18T15:33:20Z = Dhaka 2025-11-18). */
const AT = new Date(1763480000 * 1000);
const NOW = new Date('2026-11-18T12:00:00Z');

function job(payload: Record<string, unknown>): CommentIngestJobData {
  const [first] = parseMetaWebhookEnvelope(JSON.stringify(payload)).jobs;
  return first!.data;
}
const add = () => job(fbPayload());
const edited = () =>
  job(fbPayload(fbCommentValue({ verb: 'edited', message: 'bKash 017' })));
const remove = () =>
  job(fbPayload(fbCommentValue({ verb: 'remove', message: undefined })));

const row = (id: string) =>
  ({ id }) as Awaited<ReturnType<typeof commentQueries.insertComment>>;

describe('CommentIngestService', () => {
  const service = new CommentIngestService(db);

  beforeEach(() => {
    vi.clearAllMocks();
    q.findIngestRoute.mockResolvedValue(ROUTE);
    c.insertWebhookEvent.mockResolvedValue(true);
    c.markWebhookEventProcessed.mockResolvedValue(true);
  });

  const stats = () => c.incrementDailyCommentStats.mock.calls.map((x) => x[1]);

  it('routes FB by Page id and IG by IG business id inside the tx', async () => {
    c.insertComment.mockResolvedValue(row('c1'));
    await service.ingest(add(), NOW);
    expect(q.findIngestRoute).toHaveBeenLastCalledWith(
      tx,
      'FACEBOOK',
      '1000000000001',
    );
    await service.ingest(job(igPayload()), NOW);
    expect(q.findIngestRoute).toHaveBeenLastCalledWith(
      tx,
      'INSTAGRAM',
      '17841400000000001',
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unknown Page', undefined, 'unknown_page'],
    ['inactive Page', { ...ROUTE, isActive: false }, 'inactive_page'],
    [
      'REVOKED',
      { ...ROUTE, connectionStatus: 'REVOKED' as const },
      'connection_revoked',
    ],
  ])('drops a change for an %s: no writes', async (_l, route, reason) => {
    q.findIngestRoute.mockResolvedValue(route);
    expect(await service.ingest(add(), NOW)).toEqual({
      kind: 'dropped',
      reason,
    });
    expect(c.insertWebhookEvent).not.toHaveBeenCalled();
    expect(c.insertComment).not.toHaveBeenCalled();
    expect(c.incrementDailyCommentStats).not.toHaveBeenCalled();
  });

  it('stops at a duplicate event (nothing else written)', async () => {
    c.insertWebhookEvent.mockResolvedValue(false);
    expect(await service.ingest(add(), NOW)).toEqual({
      kind: 'duplicate',
      workspaceId: 'ws-1',
    });
    expect(c.insertComment).not.toHaveBeenCalled();
    expect(c.markWebhookEventProcessed).not.toHaveBeenCalled();
  });

  it('add: event → PENDING comment → received +1 on the Dhaka day → processed', async () => {
    const data = add();
    c.insertComment.mockResolvedValue(row('c1'));
    expect(await service.ingest(data, NOW)).toEqual({
      kind: 'stored',
      workspaceId: 'ws-1',
      action: 'created',
      commentRowId: 'c1',
      moderate: true,
      editedAt: null,
    });
    expect(c.insertWebhookEvent).toHaveBeenCalledWith(tx, {
      eventId: data.eventId,
      workspaceId: 'ws-1',
      payloadHash: data.payloadHash,
    });
    expect(c.insertComment).toHaveBeenCalledWith(tx, {
      commentId: data.commentId,
      workspaceId: 'ws-1',
      socialPageId: 'page-row-1',
      platform: 'FACEBOOK',
      postId: data.postId,
      authorId: data.authorId,
      authorName: data.authorName,
      message: data.message,
      rawPayload: data.rawPayload,
      status: 'PENDING',
      moderationStage: 'classify',
    });
    expect(stats()).toEqual([
      {
        workspaceId: 'ws-1',
        pageId: '1000000000001',
        platform: 'FACEBOOK',
        day: '2025-11-18',
        received: 1,
      },
    ]);
    expect(c.markWebhookEventProcessed).toHaveBeenCalledWith(
      tx,
      'ws-1',
      data.eventId,
    );
  });

  it('add for a stored comment (late add after edit/remove): unchanged, no counts', async () => {
    c.insertComment.mockResolvedValue(undefined);
    expect(await service.ingest(add(), NOW)).toEqual({
      kind: 'stored',
      workspaceId: 'ws-1',
      action: 'unchanged',
      moderate: false,
    });
    expect(c.incrementDailyCommentStats).not.toHaveBeenCalled();
    expect(c.markWebhookEventProcessed).toHaveBeenCalled();
  });

  it('IG counts go to the linked Page id with platform INSTAGRAM', async () => {
    c.insertComment.mockResolvedValue(row('c1'));
    await service.ingest(job(igPayload()), NOW);
    expect(stats()[0]).toMatchObject({
      pageId: '1000000000001',
      platform: 'INSTAGRAM',
      received: 1,
    });
  });

  it('edited: updates the stored comment, edited +1, moderate', async () => {
    const data = edited();
    q.applyCommentEdit.mockResolvedValue({
      id: 'c1',
      applied: true,
      deletedAt: null,
    });
    expect(await service.ingest(data, NOW)).toMatchObject({
      action: 'updated',
      commentRowId: 'c1',
      moderate: true,
      // The moderation job's version (M5-T12).
      editedAt: AT,
    });
    expect(q.applyCommentEdit).toHaveBeenCalledWith(
      tx,
      'ws-1',
      data.commentId,
      {
        message: 'bKash 017',
        rawPayload: data.rawPayload,
        at: AT,
      },
    );
    expect(c.insertComment).not.toHaveBeenCalled();
    expect(stats()[0]).toMatchObject({ edited: 1 });
    expect(stats()[0]).not.toHaveProperty('received');
  });

  it('edited older than the stored edit, or of a deleted comment: counted, not moderated', async () => {
    q.applyCommentEdit.mockResolvedValueOnce({
      id: 'c1',
      applied: false,
      deletedAt: null,
    });
    expect(await service.ingest(edited(), NOW)).toMatchObject({
      action: 'updated',
      moderate: false,
    });
    q.applyCommentEdit.mockResolvedValueOnce({
      id: 'c1',
      applied: true,
      deletedAt: new Date(),
    });
    expect(await service.ingest(edited(), NOW)).toMatchObject({
      action: 'updated',
      moderate: false,
    });
    expect(stats()).toHaveLength(2);
  });

  it('edited with no row: inserts the edit as a PENDING comment, received + edited', async () => {
    q.applyCommentEdit.mockResolvedValue(undefined);
    c.insertComment.mockResolvedValue(row('c2'));
    expect(await service.ingest(edited(), NOW)).toMatchObject({
      action: 'created',
      commentRowId: 'c2',
      moderate: true,
      editedAt: AT,
    });
    expect(c.insertComment.mock.calls[0]![1]).toMatchObject({
      message: 'bKash 017',
      moderationStage: 'classify',
      editedAt: AT,
      status: 'PENDING',
    });
    expect(stats()[0]).toMatchObject({ received: 1, edited: 1 });
  });

  it('edited racing a concurrent insert: updates the row that won', async () => {
    q.applyCommentEdit
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'c3', applied: true, deletedAt: null });
    c.insertComment.mockResolvedValue(undefined);
    expect(await service.ingest(edited(), NOW)).toMatchObject({
      action: 'updated',
      commentRowId: 'c3',
    });
    expect(q.applyCommentEdit).toHaveBeenCalledTimes(2);
  });

  it('edited of a comment owned by another workspace: unchanged, no counts', async () => {
    q.applyCommentEdit.mockResolvedValue(undefined);
    c.insertComment.mockResolvedValue(undefined);
    expect(await service.ingest(edited(), NOW)).toMatchObject({
      action: 'unchanged',
      moderate: false,
    });
    expect(c.incrementDailyCommentStats).not.toHaveBeenCalled();
  });

  it('remove: marks deleted, removed +1, never moderated', async () => {
    const data = remove();
    q.markCommentDeleted.mockResolvedValue({ id: 'c1' });
    expect(await service.ingest(data, NOW)).toMatchObject({
      action: 'deleted',
      commentRowId: 'c1',
      moderate: false,
    });
    expect(q.markCommentDeleted).toHaveBeenCalledWith(
      tx,
      'ws-1',
      data.commentId,
      AT,
    );
    expect(stats()[0]).toMatchObject({ removed: 1 });
  });

  it('remove with no row: stores a deleted placeholder without text', async () => {
    q.markCommentDeleted.mockResolvedValue(undefined);
    c.insertComment.mockResolvedValue(row('c4'));
    expect(await service.ingest(remove(), NOW)).toMatchObject({
      action: 'placeholder',
      commentRowId: 'c4',
      moderate: false,
    });
    expect(c.insertComment.mock.calls[0]![1]).toMatchObject({
      message: null,
      deletedAt: AT,
      status: 'PENDING',
    });
    expect(stats()[0]).toMatchObject({ removed: 1 });
    expect(stats()[0]).not.toHaveProperty('received');
  });

  it('remove racing an insert updates the winner; another workspace → unchanged', async () => {
    q.markCommentDeleted
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ id: 'c5' });
    c.insertComment.mockResolvedValue(undefined);
    expect(await service.ingest(remove(), NOW)).toMatchObject({
      action: 'deleted',
      commentRowId: 'c5',
    });
    q.markCommentDeleted.mockResolvedValue(undefined);
    expect(await service.ingest(remove(), NOW)).toMatchObject({
      action: 'unchanged',
    });
  });

  it('uses now for the day when Meta sent no usable time', async () => {
    c.insertComment.mockResolvedValue(row('c1'));
    const data = { ...add(), entryTime: null, createdTime: null };
    await service.ingest(data, new Date('2026-11-18T18:30:00Z'));
    expect(stats()[0]).toMatchObject({ day: '2026-11-19' });
  });

  it('propagates DB errors (the worker decides on retries)', async () => {
    const error = new Error('db down');
    c.insertWebhookEvent.mockRejectedValue(error);
    await expect(service.ingest(add(), NOW)).rejects.toBe(error);
  });
});
