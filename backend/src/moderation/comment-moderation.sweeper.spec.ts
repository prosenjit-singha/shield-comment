import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { Database } from '../db/database.js';
import { DEFAULT_JOB_OPTIONS } from '../queue/queue.constants.js';
import * as queries from './comment-moderation.queries.js';
import {
  ModerationJobSchedulers,
  ModerationSweeper,
  type SweepQueue,
} from './comment-moderation.sweeper.js';

const WS = '0190f000-0000-7000-8000-000000000001';
const row = (n: number) => `0190f000-0000-7000-8000-00000000000${n}`;
const NOW = new Date('2026-11-19T12:00:00.000Z');

describe('ModerationSweeper (D2)', () => {
  const add = vi.fn<SweepQueue['add']>();
  const getJobState = vi.fn<SweepQueue['getJobState']>();
  const remove = vi.fn<SweepQueue['remove']>();
  const sweeper = new ModerationSweeper(
    {} as Database,
    {
      add,
      getJobState,
      remove,
    } as unknown as SweepQueue,
  );
  let candidates: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    add.mockReset().mockResolvedValue({} as never);
    getJobState.mockReset();
    remove.mockReset().mockResolvedValue(1);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    candidates = vi.spyOn(queries, 'findSweepCandidates');
  });
  afterEach(() => vi.restoreAllMocks());

  it('asks for < 24 h comments idle ≥ 5 min, 500 at most', async () => {
    candidates.mockResolvedValue([]);
    await expect(sweeper.sweep(NOW)).resolves.toEqual({
      candidates: 0,
      requeued: 0,
      queued: 0,
    });
    expect(candidates).toHaveBeenCalledWith(expect.anything(), {
      since: new Date('2026-11-18T12:00:00.000Z'),
      idleBefore: new Date('2026-11-19T11:55:00.000Z'),
      limit: 500,
    });
    expect(add).not.toHaveBeenCalled();
  });

  it('re-adds missing/failed/completed jobs under the hand-off id, leaves live ones alone', async () => {
    const edited = new Date('2026-11-19T09:00:00.000Z');
    candidates.mockResolvedValue([
      { id: row(1), workspaceId: WS, editedAt: null },
      { id: row(2), workspaceId: WS, editedAt: edited },
      { id: row(3), workspaceId: WS, editedAt: null },
      { id: row(4), workspaceId: WS, editedAt: null },
      { id: row(5), workspaceId: WS, editedAt: null },
    ]);
    getJobState
      .mockResolvedValueOnce('unknown')
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('waiting')
      .mockResolvedValueOnce('completed')
      .mockResolvedValueOnce('failed');
    remove
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await expect(sweeper.sweep(NOW)).resolves.toEqual({
      candidates: 5,
      requeued: 3,
      queued: 2,
    });
    expect(remove.mock.calls.map(([id]) => id)).toEqual([
      `moderate:${row(2)}:edit-${edited.getTime()}`,
      `moderate:${row(4)}:add`,
      `moderate:${row(5)}:add`,
    ]);
    expect(add.mock.calls.map(([, , opts]) => opts?.jobId)).toEqual([
      `moderate:${row(1)}:add`,
      `moderate:${row(2)}:edit-${edited.getTime()}`,
      `moderate:${row(4)}:add`,
    ]);
    expect(add.mock.calls[1]?.[1]).toEqual({
      workspaceId: WS,
      commentRowId: row(2),
      editedAt: edited.toISOString(),
    });
  });
});

describe('ModerationJobSchedulers', () => {
  const upsert = vi.fn<Queue['upsertJobScheduler']>();
  let logs: string[];
  const create = () =>
    new ModerationJobSchedulers({
      upsertJobScheduler: upsert,
    } as unknown as Queue);

  beforeEach(() => {
    upsert.mockReset();
    logs = [];
    for (const level of ['log', 'warn'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((message) => {
        logs.push(`${level}: ${String(message)}`);
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it('upserts the 15-minute sweep in Asia/Dhaka (one attempt per tick)', async () => {
    upsert.mockResolvedValue(undefined as never);
    await create().register();
    expect(upsert.mock.calls).toEqual([
      [
        'comment-moderation-sweep',
        { pattern: '*/15 * * * *', tz: 'Asia/Dhaka' },
        {
          name: 'moderation-sweep',
          data: {},
          opts: { ...DEFAULT_JOB_OPTIONS, attempts: 1 },
        },
      ],
    ]);
    expect(logs).toEqual([
      'log: Job scheduler registered: comment-moderation-sweep',
    ]);
  });

  it('never blocks boot: warns when Redis does not answer in time', async () => {
    upsert.mockReturnValue(new Promise(() => {}));
    await create().register(5);
    expect(logs[0]).toMatch(
      /^warn: Job scheduler not registered yet \(Redis did not answer within 5 ms/,
    );
  });
});
