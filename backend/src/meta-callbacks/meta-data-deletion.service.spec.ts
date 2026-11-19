import { ServiceUnavailableException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Database } from '../db/database.js';
import { DATA_DELETION_CODE_PATTERN } from '../db/schema/index.js';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';
import * as queries from './meta-callbacks.queries.js';
import type { DataDeletionRequestRow } from './meta-callbacks.queries.js';
import {
  DATA_DELETION_ENQUEUE_TIMEOUT_MS,
  MetaDataDeletionService,
  newConfirmationCode,
} from './meta-data-deletion.service.js';
import type { MetaDataDeletionJobData } from './meta-data-deletion.job.js';

vi.mock('./meta-callbacks.queries.js', () => ({
  findWorkspacesWithFacebookUserData: vi.fn(),
  lockWorkspace: vi.fn(),
  lockConnection: vi.fn(),
  lockWorkspacePages: vi.fn(),
  deleteWorkspaceMetaData: vi.fn(),
  insertDeletionRequest: vi.fn(),
  findPendingDeletionRequest: vi.fn(),
  findDeletionRequestByCode: vi.fn(),
  lockDeletionRequest: vi.fn(),
  completeDeletionRequest: vi.fn(),
}));

const q = vi.mocked(queries);
const tx = { tx: true };
const transaction = vi.fn((fn: (t: unknown) => unknown) => fn(tx));
const db = { transaction } as unknown as Database;
const add = vi.fn<Queue<MetaDataDeletionJobData>['add']>();
const queue = { add } as unknown as Queue<MetaDataDeletionJobData>;
const NOW = new Date('2026-11-18T12:00:00Z');
const FB = '10000000000001';
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';

function request(
  overrides: Partial<DataDeletionRequestRow> = {},
): DataDeletionRequestRow {
  return {
    id: '0195a1b2-0000-7000-8000-000000000001',
    confirmationCode: CODE,
    facebookUserId: FB,
    status: 'PENDING',
    createdAt: new Date('2026-11-18T10:00:00Z'),
    completedAt: null,
    ...overrides,
  };
}

describe('newConfirmationCode', () => {
  it('is 22 base64url chars and random', () => {
    const a = newConfirmationCode();
    expect(a).toMatch(DATA_DELETION_CODE_PATTERN);
    expect(newConfirmationCode()).not.toBe(a);
  });
});

describe('MetaDataDeletionService', () => {
  const service = new MetaDataDeletionService(db, queue, {
    appSecret: 'x',
    clientAppUrl: 'https://app.example.bd',
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    add.mockResolvedValue({} as never);
  });

  describe('request', () => {
    it('creates a PENDING request, enqueues its job and answers Meta’s shape', async () => {
      q.insertDeletionRequest.mockResolvedValue(request());
      expect(await service.request(FB)).toEqual({
        url: `https://app.example.bd/data-deletion?code=${CODE}`,
        confirmation_code: CODE,
      });
      expect(q.insertDeletionRequest).toHaveBeenCalledWith(
        db,
        FB,
        expect.stringMatching(DATA_DELETION_CODE_PATTERN),
      );
      expect(add).toHaveBeenCalledWith(
        'data-deletion',
        { requestId: request().id },
        { ...DEFAULT_JOB_OPTIONS, jobId: `data-deletion-${request().id}` },
      );
    });

    it('reuses the open request of the same user (same code, same job id)', async () => {
      q.insertDeletionRequest.mockResolvedValue(undefined);
      q.findPendingDeletionRequest.mockResolvedValue(request());
      expect((await service.request(FB)).confirmation_code).toBe(CODE);
      expect(add.mock.calls[0]![2]).toMatchObject({
        jobId: `data-deletion-${request().id}`,
      });
    });

    it('tries again when the open request completed between insert and read', async () => {
      q.insertDeletionRequest
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(request({ confirmationCode: 'x'.repeat(22) }));
      q.findPendingDeletionRequest.mockResolvedValueOnce(undefined);
      expect((await service.request(FB)).confirmation_code).toBe(
        'x'.repeat(22),
      );
      expect(q.insertDeletionRequest).toHaveBeenCalledTimes(2);
    });

    it('enqueue failure → 503 (the request row stays for a retry)', async () => {
      q.insertDeletionRequest.mockResolvedValue(request());
      add.mockRejectedValue(new Error('redis down'));
      await expect(service.request(FB)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('enqueue hang → 503 after the timeout', async () => {
      vi.useFakeTimers();
      q.insertDeletionRequest.mockResolvedValue(request());
      add.mockReturnValue(new Promise(() => {}));
      const pending = service.request(FB);
      const assertion = expect(pending).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await vi.advanceTimersByTimeAsync(DATA_DELETION_ENQUEUE_TIMEOUT_MS);
      await assertion;
    });
  });

  describe('status', () => {
    it('returns status + times, no ids', async () => {
      q.findDeletionRequestByCode.mockResolvedValue(
        request({ status: 'COMPLETED', completedAt: NOW }),
      );
      expect(await service.status(CODE)).toEqual({
        status: 'COMPLETED',
        requestedAt: '2026-11-18T10:00:00.000Z',
        completedAt: NOW.toISOString(),
      });
    });

    it('unknown code → undefined', async () => {
      q.findDeletionRequestByCode.mockResolvedValue(undefined);
      expect(await service.status(CODE)).toBeUndefined();
    });
  });

  describe('execute', () => {
    beforeEach(() => {
      q.lockDeletionRequest.mockResolvedValue(request());
      q.findWorkspacesWithFacebookUserData.mockResolvedValue(['ws-a', 'ws-b']);
      q.lockWorkspace.mockResolvedValue(true);
      q.lockConnection.mockImplementation((_tx, workspaceId) =>
        Promise.resolve({ id: `c-${workspaceId.slice(3)}`, workspaceId }),
      );
      q.lockWorkspacePages.mockImplementation((_tx, ws) =>
        Promise.resolve([`${ws}-p1`, `${ws}-p2`]),
      );
      q.deleteWorkspaceMetaData.mockResolvedValue({
        moderationActions: 1,
        webhookEvents: 3,
        comments: 2,
        pages: 2,
        connections: 1,
      });
    });

    it('deletes per workspace (locks first) and completes the request, in one tx', async () => {
      expect(await service.execute(request().id, NOW)).toEqual({
        kind: 'completed',
        connectionsSeen: 2,
        moderationActions: 2,
        webhookEvents: 6,
        comments: 4,
        pages: 4,
        connections: 2,
      });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(q.findWorkspacesWithFacebookUserData).toHaveBeenCalledWith(tx, FB);
      expect(q.deleteWorkspaceMetaData).toHaveBeenCalledWith(tx, {
        workspaceId: 'ws-a',
        connectionId: 'c-a',
        pageIds: ['ws-a-p1', 'ws-a-p2'],
        facebookUserId: FB,
      });
      expect(q.deleteWorkspaceMetaData).toHaveBeenCalledWith(tx, {
        workspaceId: 'ws-b',
        connectionId: 'c-b',
        pageIds: ['ws-b-p1', 'ws-b-p2'],
        facebookUserId: FB,
      });
      const order = [
        q.lockDeletionRequest.mock.invocationCallOrder[0]!,
        q.lockWorkspace.mock.invocationCallOrder[0]!,
        q.lockConnection.mock.invocationCallOrder[0]!,
        q.lockWorkspacePages.mock.invocationCallOrder[0]!,
        q.deleteWorkspaceMetaData.mock.invocationCallOrder[0]!,
        q.completeDeletionRequest.mock.invocationCallOrder[0]!,
      ];
      expect([...order].sort((x, y) => x - y)).toEqual(order);
      expect(q.completeDeletionRequest).toHaveBeenCalledWith(
        tx,
        request().id,
        NOW,
      );
    });

    it('unknown user → completes with nothing deleted', async () => {
      q.findWorkspacesWithFacebookUserData.mockResolvedValue([]);
      expect(await service.execute(request().id, NOW)).toMatchObject({
        kind: 'completed',
        connections: 0,
        comments: 0,
      });
      expect(q.completeDeletionRequest).toHaveBeenCalled();
    });

    it('no connection of the user any more (disconnected / re-connected by someone else) → only their stamped comments (M4-T9)', async () => {
      q.findWorkspacesWithFacebookUserData.mockResolvedValue(['ws-a']);
      q.lockConnection.mockResolvedValue(undefined);
      q.deleteWorkspaceMetaData.mockResolvedValue({
        moderationActions: 0,
        webhookEvents: 2,
        comments: 1,
        pages: 0,
        connections: 0,
      });
      expect(await service.execute(request().id, NOW)).toEqual({
        kind: 'completed',
        connectionsSeen: 0,
        moderationActions: 0,
        webhookEvents: 2,
        comments: 1,
        pages: 0,
        connections: 0,
      });
      expect(q.lockWorkspace).toHaveBeenCalledWith(tx, 'ws-a');
      expect(q.lockWorkspacePages).not.toHaveBeenCalled();
      expect(q.deleteWorkspaceMetaData).toHaveBeenCalledWith(tx, {
        workspaceId: 'ws-a',
        connectionId: null,
        pageIds: [],
        facebookUserId: FB,
      });
      expect(q.completeDeletionRequest).toHaveBeenCalled();
    });

    it('a workspace that is gone is skipped', async () => {
      q.lockWorkspace.mockImplementation(async (_tx, ws) => ws !== 'ws-a');
      expect(await service.execute(request().id, NOW)).toMatchObject({
        connectionsSeen: 1,
      });
      expect(q.deleteWorkspaceMetaData).toHaveBeenCalledTimes(1);
      expect(q.lockConnection).not.toHaveBeenCalledWith(tx, 'ws-a', FB);
    });

    it('already completed → no deletes', async () => {
      q.lockDeletionRequest.mockResolvedValue(
        request({ status: 'COMPLETED', completedAt: NOW }),
      );
      expect(await service.execute(request().id, NOW)).toEqual({
        kind: 'already_completed',
      });
      expect(q.findWorkspacesWithFacebookUserData).not.toHaveBeenCalled();
      expect(q.completeDeletionRequest).not.toHaveBeenCalled();
    });

    it('missing request → no deletes', async () => {
      q.lockDeletionRequest.mockResolvedValue(undefined);
      expect(await service.execute(request().id, NOW)).toEqual({
        kind: 'missing',
      });
      expect(q.deleteWorkspaceMetaData).not.toHaveBeenCalled();
    });
  });
});
