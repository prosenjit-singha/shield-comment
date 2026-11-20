import { BadRequestException } from '@nestjs/common';

/**
 * Dashboard date ranges and buckets (M2-T5, user decisions 2026-11-18).
 *
 * - Presets `7d` / `30d` / `90d` = that many Dhaka days ending today (daily buckets); `12m` = the
 *   current Dhaka month and the 11 before it (monthly buckets, the last one partial). Default `30d`.
 * - Custom `from`/`to` = inclusive Dhaka calendar dates (`YYYY-MM-DD`). ≤ 92 days → daily buckets,
 *   longer → monthly, at most 24 calendar months. `from ≤ to ≤ today`, `from ≥ 2020-01-01`.
 * - Buckets cut at Asia/Dhaka midnight (UTC+6, no DST since 2009, so a fixed offset matches
 *   Postgres' `AT TIME ZONE 'Asia/Dhaka'` for every date we accept). Keys: `YYYY-MM-DD` / `YYYY-MM`.
 */

export const DASHBOARD_TIMEZONE = 'Asia/Dhaka';
/** Asia/Dhaka is UTC+06:00 all year. */
export const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;

export const DASHBOARD_RANGES = ['7d', '30d', '90d', '12m'] as const;
export type DashboardPreset = (typeof DASHBOARD_RANGES)[number];
export type DashboardRangeName = DashboardPreset | 'custom';
export const DEFAULT_DASHBOARD_RANGE: DashboardPreset = '30d';

export type Granularity = 'day' | 'month';

/** A custom range of up to this many days (inclusive) uses daily buckets. */
export const MAX_DAILY_SPAN_DAYS = 92;
/** A custom range may cover at most this many calendar months. */
export const MAX_SPAN_MONTHS = 24;
/** Earliest accepted custom `from`. */
export const MIN_DASHBOARD_DATE = '2020-01-01';

export const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

const DAY_MS = 86_400_000;
const PRESET_DAYS: Record<Exclude<DashboardPreset, '12m'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

export interface DashboardRangeQuery {
  range?: DashboardPreset;
  from?: string;
  to?: string;
}

export interface ResolvedRange {
  range: DashboardRangeName;
  granularity: Granularity;
  /** First Dhaka day, inclusive (`YYYY-MM-DD`). */
  from: string;
  /** Last Dhaka day, inclusive (`YYYY-MM-DD`). */
  to: string;
  /** `from` 00:00 Dhaka as a UTC instant. */
  start: Date;
  /** The day after `to`, 00:00 Dhaka, as a UTC instant (exclusive bound). */
  end: Date;
}

/** `YYYY-MM-DD` → UTC midnight of that calendar date, or `undefined` if it isn't a real date. */
function parseDateKey(key: string): number | undefined {
  if (!DATE_KEY.test(key)) return undefined;
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  const t = Date.UTC(y, m - 1, d);
  return new Date(t).toISOString().slice(0, 10) === key ? t : undefined;
}

const keyOf = (utcMidnight: number) =>
  new Date(utcMidnight).toISOString().slice(0, 10);

/** The Dhaka bucket key of an instant: `YYYY-MM-DD` (day) or `YYYY-MM` (month). */
export function dhakaBucketKey(instant: Date, granularity: Granularity) {
  const local = new Date(instant.getTime() + DHAKA_OFFSET_MS).toISOString();
  return granularity === 'day' ? local.slice(0, 10) : local.slice(0, 7);
}

/** 00:00 Asia/Dhaka on a calendar date, as a UTC instant. */
export function dhakaMidnight(dateKey: string): Date {
  const t = parseDateKey(dateKey);
  if (t === undefined) throw new Error(`Invalid date key: ${dateKey}`);
  return new Date(t - DHAKA_OFFSET_MS);
}

export function addDays(dateKey: string, days: number): string {
  const t = parseDateKey(dateKey);
  if (t === undefined) throw new Error(`Invalid date key: ${dateKey}`);
  return keyOf(t + days * DAY_MS);
}

/** First day of the month `months` away from `dateKey`'s month. */
function monthStart(dateKey: string, months = 0): string {
  const [y, m] = dateKey.split('-').map(Number) as [number, number];
  return keyOf(Date.UTC(y, m - 1 + months, 1));
}

/** Calendar months touched by `[from, to]`, both ends included. */
function monthsSpanned(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}

export function daysSpanned(from: string, to: string): number {
  return (parseDateKey(to)! - parseDateKey(from)!) / DAY_MS + 1;
}

function resolved(
  range: DashboardRangeName,
  granularity: Granularity,
  from: string,
  to: string,
): ResolvedRange {
  return {
    range,
    granularity,
    from,
    to,
    start: dhakaMidnight(from),
    end: dhakaMidnight(addDays(to, 1)),
  };
}

/**
 * Turns the validated query into concrete Dhaka dates + UTC bounds. Field formats were checked by
 * `DashboardStatsQueryDto`; the cross-field rules live here and answer 400. `maxMonths` = the
 * calendar-month cap of a custom range (workspace analytics use 12, M6-T6 D11).
 */
export function resolveDashboardRange(
  query: DashboardRangeQuery,
  now: Date,
  maxMonths = MAX_SPAN_MONTHS,
): ResolvedRange {
  const today = dhakaBucketKey(now, 'day');
  const { from, to } = query;

  if (from === undefined && to === undefined) {
    const preset = query.range ?? DEFAULT_DASHBOARD_RANGE;
    if (preset === '12m')
      return resolved(preset, 'month', monthStart(today, -11), today);
    return resolved(
      preset,
      'day',
      addDays(today, 1 - PRESET_DAYS[preset]),
      today,
    );
  }

  if (query.range !== undefined)
    throw new BadRequestException('Use either range or from/to, not both');
  if (from === undefined || to === undefined)
    throw new BadRequestException('from and to must be sent together');
  if (parseDateKey(from) === undefined)
    throw new BadRequestException('from must be a valid date (YYYY-MM-DD)');
  if (parseDateKey(to) === undefined)
    throw new BadRequestException('to must be a valid date (YYYY-MM-DD)');
  if (from > to) throw new BadRequestException('from must not be after to');
  if (from < MIN_DASHBOARD_DATE)
    throw new BadRequestException(
      `from must not be before ${MIN_DASHBOARD_DATE}`,
    );
  if (to > today)
    throw new BadRequestException(
      `to must not be after today (${DASHBOARD_TIMEZONE})`,
    );
  if (monthsSpanned(from, to) > maxMonths)
    throw new BadRequestException(
      `The range may cover at most ${maxMonths} months`,
    );

  const granularity: Granularity =
    daysSpanned(from, to) <= MAX_DAILY_SPAN_DAYS ? 'day' : 'month';
  return resolved('custom', granularity, from, to);
}

/** Every bucket key of the range, oldest first (empty buckets included). */
export function bucketKeys(range: ResolvedRange): string[] {
  const keys: string[] = [];
  if (range.granularity === 'day') {
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) keys.push(d);
  } else {
    const last = range.to.slice(0, 7);
    for (
      let m = monthStart(range.from);
      m.slice(0, 7) <= last;
      m = monthStart(m, 1)
    )
      keys.push(m.slice(0, 7));
  }
  return keys;
}
