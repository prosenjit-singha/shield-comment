import type {
  MigrationStatus,
  QueueStats,
  SystemProcessInfo,
} from './dto/system-health.dto.js';

/** One entry of `drizzle/meta/_journal.json`. */
export interface JournalEntry {
  tag: string;
  /** drizzle-kit's folder timestamp; the migrator stores it as `created_at`. */
  when: number;
}

/** What the migrations query returns: row count + the newest row (by `created_at`). */
export interface AppliedMigrations {
  applied: number;
  latest: { hash: string; createdAt: number | null } | null;
}

export const UNKNOWN_MIGRATIONS: MigrationStatus = {
  known: false,
  applied: 0,
  shipped: 0,
  pending: 0,
  latest: null,
};

/** Parses `_journal.json` text; anything malformed → `[]` (the page then shows 0 shipped). */
export function parseJournal(text: string): JournalEntry[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return [];
    const entries = (parsed as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((e: unknown) => {
      if (typeof e !== 'object' || e === null) return [];
      const { tag, when } = e as { tag?: unknown; when?: unknown };
      return typeof tag === 'string' && typeof when === 'number'
        ? [{ tag, when }]
        : [];
    });
  } catch {
    return [];
  }
}

/**
 * Same rule as Drizzle's migrator: a shipped migration is pending when its `when` is newer than the
 * latest applied `created_at` (all of them when nothing is applied).
 */
export function describeMigrations(
  db: AppliedMigrations,
  journal: readonly JournalEntry[],
): MigrationStatus {
  const lastWhen = db.latest?.createdAt ?? null;
  const pending =
    lastWhen === null
      ? journal.length
      : journal.filter((entry) => entry.when > lastWhen).length;
  return {
    known: true,
    applied: db.applied,
    shipped: journal.length,
    pending,
    latest: db.latest
      ? {
          tag: journal.find((e) => e.when === lastWhen)?.tag ?? null,
          hash: db.latest.hash,
          createdAt: new Date(lastWhen ?? 0).toISOString(),
        }
      : null,
  };
}

/** The process facts the page shows, from injectable inputs so the mapping is unit-testable. */
export function describeProcess(input: {
  uptimeSeconds: number;
  memory: Pick<NodeJS.MemoryUsage, 'rss' | 'heapUsed' | 'heapTotal'>;
  version: string;
  nodeVersion: string;
  environment: string;
  now: Date;
}): SystemProcessInfo {
  const uptimeSeconds = Math.floor(input.uptimeSeconds);
  return {
    uptimeSeconds,
    startedAt: new Date(
      input.now.getTime() - input.uptimeSeconds * 1000,
    ).toISOString(),
    version: input.version,
    nodeVersion: input.nodeVersion,
    environment: input.environment,
    memory: {
      rssBytes: input.memory.rss,
      heapUsedBytes: input.memory.heapUsed,
      heapTotalBytes: input.memory.heapTotal,
    },
  };
}

/** Reads `version` from package.json text; `0.0.0` when missing or malformed. */
export function parseVersion(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const version =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;
    return typeof version === 'string' && version ? version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** One `QueuesCard` row from BullMQ `getJobCounts('waiting', 'active', 'failed')` (missing → 0). */
export function queueStats(
  name: string,
  counts: Readonly<Record<string, number | undefined>>,
): QueueStats {
  const count = (key: string) => {
    const value = counts[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  return {
    name,
    waiting: count('waiting'),
    active: count('active'),
    failed: count('failed'),
  };
}
