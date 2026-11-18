/**
 * `GET /api/admin/system/health` takes no parameters. An empty DTO still goes through the global
 * ValidationPipe (`forbidNonWhitelisted`), so any query param → 400.
 */
export class SystemHealthQueryDto {}

export type ProbeStatus = 'up' | 'down';

/** One dependency probe (reuses `HealthService`: `select 1` / Redis `PING`, 3 s timeout each). */
export interface DependencyProbe {
  status: ProbeStatus;
  /** Round-trip in ms (2 decimals). `null` only when the probe failed or timed out (`down`). */
  latencyMs: number | null;
}

/** The Node process serving this request (one replica). */
export interface SystemProcessInfo {
  uptimeSeconds: number;
  /** ISO time the process started (now − uptime). */
  startedAt: string;
  /** `backend/package.json` version. */
  version: string;
  /** e.g. `v24.11.0`. */
  nodeVersion: string;
  /** `NODE_ENV` (development / production / test). */
  environment: string;
  memory: {
    rssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
}

/**
 * BullMQ queue counts. The list is `[]` until the moderation queues exist (Module 4+), which then
 * fill it with one row per queue.
 */
export interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  failed: number;
}

/** Latest row of `drizzle.__drizzle_migrations`, matched to this build's journal by `created_at`. */
export interface LatestMigration {
  /** Journal tag, e.g. `0005_support_tickets`. `null` when the DB has a migration this build doesn't ship. */
  tag: string | null;
  hash: string;
  /** The migration's journal timestamp (`created_at` = drizzle-kit `when`), ISO. Drizzle stores no apply time. */
  createdAt: string;
}

export interface MigrationStatus {
  /** `false` when the DB is down or the journal table can't be read: counts are 0, `latest` null. */
  known: boolean;
  /** Rows in `drizzle.__drizzle_migrations`. */
  applied: number;
  /** Migrations shipped in this build (`drizzle/meta/_journal.json`). */
  shipped: number;
  /** Shipped migrations newer than the latest applied one (what the `migrate` service would run). */
  pending: number;
  latest: LatestMigration | null;
}

/** `GET /api/admin/system/health` (A6, M2-T10). Always 200; down dependencies are in the body. */
export interface SystemHealthResponse {
  /** `ok` when DB and Redis are both up, else `degraded`. */
  status: 'ok' | 'degraded';
  checkedAt: string;
  database: DependencyProbe;
  redis: DependencyProbe;
  process: SystemProcessInfo;
  queues: QueueStats[];
  migrations: MigrationStatus;
}
