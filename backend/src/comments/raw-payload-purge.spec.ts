import {
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  RAW_PAYLOAD_RETENTION_DAYS,
  rawPayloadPurgeCutoff,
  runPurgeBatches,
} from './raw-payload-purge.js';

describe('raw_payload purge (D4)', () => {
  it('keeps 30 days', () => {
    expect(RAW_PAYLOAD_RETENTION_DAYS).toBe(30);
    expect(
      rawPayloadPurgeCutoff(new Date('2026-11-19T21:30:00.000Z')).toISOString(),
    ).toBe('2026-10-20T21:30:00.000Z');
  });

  it('batch limits are bounded', () => {
    expect(PURGE_BATCH_SIZE).toBe(1000);
    expect(PURGE_MAX_BATCHES * PURGE_BATCH_SIZE).toBe(200_000);
  });

  describe('runPurgeBatches', () => {
    const batches = (...cleared: number[]) => {
      const fn = vi.fn<(limit: number) => Promise<number>>();
      for (const n of cleared) fn.mockResolvedValueOnce(n);
      return fn;
    };

    it('nothing to purge → one batch', async () => {
      const fn = batches(0);
      expect(await runPurgeBatches(fn, 10, 5)).toEqual({
        purged: 0,
        batches: 1,
        complete: true,
      });
      expect(fn).toHaveBeenCalledWith(10);
    });

    it('stops after the first short batch', async () => {
      const fn = batches(10, 10, 3, 99);
      expect(await runPurgeBatches(fn, 10, 5)).toEqual({
        purged: 23,
        batches: 3,
        complete: true,
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('an exactly full last batch needs one more (empty) batch', async () => {
      const fn = batches(10, 0);
      expect(await runPurgeBatches(fn, 10, 5)).toEqual({
        purged: 10,
        batches: 2,
        complete: true,
      });
    });

    it('stops at maxBatches and reports incomplete', async () => {
      const fn = vi
        .fn<(limit: number) => Promise<number>>()
        .mockResolvedValue(10);
      expect(await runPurgeBatches(fn, 10, 3)).toEqual({
        purged: 30,
        batches: 3,
        complete: false,
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('rejects a bad batch size and passes errors on', async () => {
      await expect(runPurgeBatches(batches(), 0, 1)).rejects.toThrow(
        'batchSize',
      );
      const boom = new Error('db');
      const fn = vi
        .fn<(limit: number) => Promise<number>>()
        .mockRejectedValue(boom);
      await expect(runPurgeBatches(fn, 10, 3)).rejects.toBe(boom);
    });
  });
});
