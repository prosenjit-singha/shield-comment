/**
 * Data Deletion job contract (M4-T6, Module 4 D6). Runs on the `meta-token-check` queue (D3 has no
 * separate deletion queue; that queue's worker dispatches by job name, M4-T7 adds its scheduled
 * jobs there). One job per `meta_data_deletion_requests` row.
 */
export const META_DATA_DELETION_JOB_NAME = 'data-deletion';

export interface MetaDataDeletionJobData {
  /** `meta_data_deletion_requests.id`. */
  requestId: string;
}

/** BullMQ job id: one job per request (a repeated Meta call for an open request dedupes). */
export function metaDataDeletionJobId(requestId: string): string {
  return `data-deletion-${requestId}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The job's data, or `null` when it doesn't fit the contract. */
export function parseMetaDataDeletionJob(
  data: unknown,
): MetaDataDeletionJobData | null {
  if (typeof data !== 'object' || data === null) return null;
  const requestId = (data as { requestId?: unknown }).requestId;
  return typeof requestId === 'string' && UUID.test(requestId)
    ? { requestId }
    : null;
}
