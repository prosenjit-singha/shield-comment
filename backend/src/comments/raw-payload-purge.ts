import { Injectable } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import { and, asc, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db/database.js';
import { comments } from '../db/schema/index.js';

/** Module 4 D4: `raw_payload` is cleared once a comment row is older than this. */
export const RAW_PAYLOAD_RETENTION_DAYS = 30;
/** Rows per UPDATE (short row locks; the ingest worker keeps running). */
export const PURGE_BATCH_SIZE = 1_000;
/** Batches per run (≤ 200,000 rows a day); anything left waits for the next run. */
export const PURGE_MAX_BATCHES = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rows created before this instant lose their `raw_payload`. */
export function rawPayloadPurgeCutoff(now: Date): Date {
  return new Date(now.getTime() - RAW_PAYLOAD_RETENTION_DAYS * DAY_MS);
}

export interface PurgeBatchesResult {
  purged: number;
  batches: number;
  /** `false` = stopped at `maxBatches` with rows possibly left. */
  complete: boolean;
}

/**
 * Runs `purgeBatch(limit)` until a batch clears fewer than `batchSize` rows or `maxBatches` ran.
 * Pure loop (unit-tested); `purgeBatch` returns how many rows it cleared.
 */
export async function runPurgeBatches(
  purgeBatch: (limit: number) => Promise<number>,
  batchSize: number,
  maxBatches: number,
): Promise<PurgeBatchesResult> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  let purged = 0;
  for (let batches = 1; batches <= maxBatches; batches++) {
    const cleared = await purgeBatch(batchSize);
    purged += cleared;
    if (cleared < batchSize) return { purged, batches, complete: true };
  }
  return { purged, batches: maxBatches, complete: false };
}

/**
 * Clears `raw_payload` on up to `limit` comments created before `cutoff` that still carry one,
 * oldest first (served by the partial index `comments_raw_payload_purge_index`). Rows locked by
 * the ingest worker are skipped (`SKIP LOCKED`) and picked up by the next batch or run. Text,
 * author, status and `updated_at` stay as they are (maintenance, not a content change).
 *
 * **System-wide on purpose**: this is the one recorded exception to the workspace-scoping rule
 * (M4-T7, D4 retention applies to every workspace alike); it reads and writes ids + `raw_payload`
 * only.
 */
export async function purgeRawPayloadBatch(
  db: Pick<Database, 'select' | 'update'>,
  cutoff: Date,
  limit: number,
): Promise<number> {
  const batch = db
    .select({ id: comments.id })
    .from(comments)
    .where(and(isNotNull(comments.rawPayload), lt(comments.createdAt, cutoff)))
    .orderBy(asc(comments.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  const rows = await db
    .update(comments)
    .set({ rawPayload: null, updatedAt: sql`${comments.updatedAt}` })
    .where(inArray(comments.id, batch))
    .returning({ id: comments.id });
  return rows.length;
}

export interface RawPayloadPurgeOutcome extends PurgeBatchesResult {
  kind: 'raw_payload_purge';
  cutoff: string;
}

/** Daily `raw_payload` purge (M4-T7, Module 4 D4), run by the `meta-token-check` worker. */
@Injectable()
export class RawPayloadPurgeService {
  batchSize = PURGE_BATCH_SIZE;
  maxBatches = PURGE_MAX_BATCHES;

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async run(now = new Date()): Promise<RawPayloadPurgeOutcome> {
    const cutoff = rawPayloadPurgeCutoff(now);
    const result = await runPurgeBatches(
      (limit) => purgeRawPayloadBatch(this.db, cutoff, limit),
      this.batchSize,
      this.maxBatches,
    );
    return {
      kind: 'raw_payload_purge',
      cutoff: cutoff.toISOString(),
      ...result,
    };
  }
}
