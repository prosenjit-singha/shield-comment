import type { AiProvider } from '../../ai-gateway/ai-provider.js';

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
 * BullMQ counts, one row per registered queue (M4-T1: `comment-ingest`, `comment-moderation`,
 * `meta-token-check`; PW-T3: `billing`). A queue whose counts fail (Redis down) is left out.
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
  /** AI moderation usage (M5-T13). `null` when the usage read failed or the DB is down. */
  ai: AiUsageReport | null;
}

/** Usage numbers of one provider + model, or the window total (D14, M5-T13). */
export interface AiUsageStats {
  /** Classification requests (retries included). */
  calls: number;
  failedCalls: number;
  /** Failed calls by machine-code kind (e.g. `timeout`, `rate_limited`); `{}` when none. */
  failuresByKind: Record<string, number>;
  inputTokens: number;
  outputTokens: number;
  /** Mean provider latency per call (ms, rounded); `null` without calls. */
  avgLatencyMs: number | null;
  /** Slowest call (ms); `null` without calls. */
  maxLatencyMs: number | null;
  /**
   * List-price estimate in USD (6 decimals). Per model: `null` when the price table has no entry.
   * Total: the priced models only; `null` when every model with calls is unpriced.
   */
  estimatedCostUsd: number | null;
  /** `estimatedCostUsd` × `usdToBdtRate`, rounded to 2 decimals (same `null` rule). */
  estimatedCostBdt: number | null;
}

/** USD per 1M tokens used for the estimate. */
export interface AiModelPrice {
  input: number;
  output: number;
}

export interface AiModelUsage extends AiUsageStats {
  provider: AiProvider;
  model: string;
  /** The price the estimate used, `null` = unknown model (cost `null`). */
  priceUsdPer1M: AiModelPrice | null;
}

/** One window of Dhaka days (inclusive). */
export interface AiUsageWindow {
  from: string;
  to: string;
  totals: AiUsageStats & {
    /** Models with calls but no price: their cost is left out of the total. */
    unpricedModels: number;
  };
  /** One row per provider + model with rows in the window, sorted by provider then model. */
  models: AiModelUsage[];
}

/**
 * The A6 "AI moderation" card (D14): platform-wide `daily_ai_usage`, today and the last 7 Dhaka
 * days (today included).
 */
export interface AiUsageReport {
  timezone: 'Asia/Dhaka';
  /** `AI_COST_USD_TO_BDT`. */
  usdToBdtRate: number;
  today: AiUsageWindow;
  last7Days: AiUsageWindow;
}
