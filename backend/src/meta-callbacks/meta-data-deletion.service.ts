import { InjectQueue } from '@nestjs/bullmq';
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { withTimeout } from '../common/async/with-timeout.js';
import type { Database } from '../db/database.js';
import type { MetaDataDeletionStatus } from '../db/schema/index.js';
import { DEFAULT_JOB_OPTIONS, QUEUE_NAMES } from '../queue/queue.constants.js';
import {
  META_CALLBACKS_CONFIG,
  type MetaCallbacksConfig,
} from './meta-callbacks.config.js';
import {
  completeDeletionRequest,
  type DataDeletionRequestRow,
  deleteWorkspaceMetaData,
  findDeletionRequestByCode,
  findPendingDeletionRequest,
  findWorkspacesWithFacebookUserData,
  insertDeletionRequest,
  lockConnection,
  lockDeletionRequest,
  lockWorkspace,
  lockWorkspacePages,
  type WorkspaceDeletionCounts,
} from './meta-callbacks.queries.js';
import {
  META_DATA_DELETION_JOB_NAME,
  type MetaDataDeletionJobData,
  metaDataDeletionJobId,
} from './meta-data-deletion.job.js';

/** Enqueue budget for the callback (Meta waits for the JSON answer). */
export const DATA_DELETION_ENQUEUE_TIMEOUT_MS = 1000;

/** Meta's required answer to a Data Deletion callback. */
export interface DataDeletionCallbackResponse {
  url: string;
  confirmation_code: string;
}

/** Public status lookup (client `/data-deletion?code=`, M4-T12). No ids. */
export interface DataDeletionStatusResponse {
  status: MetaDataDeletionStatus;
  requestedAt: string;
  completedAt: string | null;
}

export type DataDeletionOutcome =
  | ({ kind: 'completed' } & WorkspaceDeletionCounts & {
        connectionsSeen: number;
      })
  | { kind: 'already_completed' }
  | { kind: 'missing' };

/** 16 random bytes, base64url (22 chars; `DATA_DELETION_CODE_PATTERN`). */
export function newConfirmationCode(): string {
  return randomBytes(16).toString('base64url');
}

/**
 * Meta Data Deletion callback (Module 4 D6). `request()` records the request (random confirmation
 * code; a repeat while the user's request is still `PENDING` reuses it) and enqueues the deletion
 * job on `meta-token-check`; `execute()` (the job) deletes the user's connections, Pages and their
 * comments; `status()` answers the public lookup.
 */
@Injectable()
export class MetaDataDeletionService {
  private readonly logger = new Logger('MetaDataDeletion');

  constructor(
    @InjectDrizzle() private readonly db: Database,
    @InjectQueue(QUEUE_NAMES.metaTokenCheck)
    private readonly queue: Queue<MetaDataDeletionJobData>,
    @Inject(META_CALLBACKS_CONFIG) private readonly config: MetaCallbacksConfig,
  ) {}

  /**
   * Stores (or reuses) the user's open request, then enqueues its job (job id per request, so a
   * repeat doesn't add a second job). Queue down / slow → 503 (Meta shows an error, a retry reuses
   * the same request and code).
   */
  async request(facebookUserId: string): Promise<DataDeletionCallbackResponse> {
    const request = await this.openRequest(facebookUserId);
    try {
      await withTimeout(
        this.queue.add(
          META_DATA_DELETION_JOB_NAME,
          { requestId: request.id },
          { ...DEFAULT_JOB_OPTIONS, jobId: metaDataDeletionJobId(request.id) },
        ),
        DATA_DELETION_ENQUEUE_TIMEOUT_MS,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(
        `Data deletion request ${request.id}: enqueue failed (${reason})`,
      );
      throw new ServiceUnavailableException('Data deletion queue unavailable');
    }
    this.logger.log(`Data deletion request ${request.id} queued`);
    return {
      url: `${this.config.clientAppUrl}/data-deletion?code=${encodeURIComponent(request.confirmationCode)}`,
      confirmation_code: request.confirmationCode,
    };
  }

  async status(
    confirmationCode: string,
  ): Promise<DataDeletionStatusResponse | undefined> {
    const row = await findDeletionRequestByCode(this.db, confirmationCode);
    if (!row) return undefined;
    return {
      status: row.status,
      requestedAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
    };
  }

  /**
   * The deletion job, in one transaction: lock the request (`FOR UPDATE`; already `COMPLETED` →
   * nothing to do) → for every workspace holding the user's data (routing read: their connections
   * + comments a disconnect stamped with their id (M4-T9), ordered by workspace): lock the
   * workspace, the connection (re-checked; may be gone) and its Pages, then delete moderation
   * actions → webhook events → comments (the Pages' + the stamped ones) → Pages → connection, all scoped by `workspace_id`
   * → mark the request `COMPLETED`. An unknown user completes with nothing deleted. Daily
   * aggregates stay.
   */
  async execute(
    requestId: string,
    now = new Date(),
  ): Promise<DataDeletionOutcome> {
    return this.db.transaction(async (tx) => {
      const request = await lockDeletionRequest(tx, requestId);
      if (!request) return { kind: 'missing' } as const;
      if (request.status === 'COMPLETED') {
        return { kind: 'already_completed' } as const;
      }
      const totals = {
        connectionsSeen: 0,
        moderationActions: 0,
        webhookEvents: 0,
        comments: 0,
        pages: 0,
        connections: 0,
      };
      const workspaceIds = await findWorkspacesWithFacebookUserData(
        tx,
        request.facebookUserId,
      );
      for (const workspaceId of workspaceIds) {
        if (!(await lockWorkspace(tx, workspaceId))) continue;
        const connection = await lockConnection(
          tx,
          workspaceId,
          request.facebookUserId,
        );
        if (connection) totals.connectionsSeen++;
        const pageIds = connection
          ? await lockWorkspacePages(tx, workspaceId)
          : [];
        const counts = await deleteWorkspaceMetaData(tx, {
          workspaceId,
          connectionId: connection?.id ?? null,
          pageIds,
          facebookUserId: request.facebookUserId,
        });
        totals.moderationActions += counts.moderationActions;
        totals.webhookEvents += counts.webhookEvents;
        totals.comments += counts.comments;
        totals.pages += counts.pages;
        totals.connections += counts.connections;
      }
      await completeDeletionRequest(tx, request.id, now);
      return { kind: 'completed', ...totals } as const;
    });
  }

  /** The user's `PENDING` request, created when there is none (race-safe via the partial index). */
  private async openRequest(
    facebookUserId: string,
  ): Promise<DataDeletionRequestRow> {
    // Two tries: the open request can complete between a conflicting insert and the read.
    for (let attempt = 0; attempt < 2; attempt++) {
      const inserted = await insertDeletionRequest(
        this.db,
        facebookUserId,
        newConfirmationCode(),
      );
      if (inserted) return inserted;
      const pending = await findPendingDeletionRequest(this.db, facebookUserId);
      if (pending) return pending;
    }
    throw new Error('Could not open a data deletion request');
  }
}
