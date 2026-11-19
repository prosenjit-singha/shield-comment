import {
  ALL_QUEUE_NAMES,
  bullRootOptions,
  commentEditHash,
  commentJobId,
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAMES,
} from './queue.constants.js';

describe('queue constants (D3)', () => {
  it('names the three D3 queues + billing (PW-T3)', () => {
    expect(QUEUE_NAMES).toEqual({
      commentIngest: 'comment-ingest',
      commentModeration: 'comment-moderation',
      metaTokenCheck: 'meta-token-check',
      billing: 'billing',
    });
    expect(ALL_QUEUE_NAMES).toEqual([
      'comment-ingest',
      'comment-moderation',
      'meta-token-check',
      'billing',
    ]);
    // BullMQ rejects queue names with `:`.
    for (const name of ALL_QUEUE_NAMES) expect(name).not.toContain(':');
  });

  it('default job options: 5 attempts, exponential 2 s, bounded history', () => {
    expect(DEFAULT_JOB_OPTIONS).toEqual({
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600, count: 1000 },
      removeOnFail: { age: 604800, count: 1000 },
    });
  });

  it('root options: REDIS_URL connection with maxRetriesPerRequest null + the defaults', () => {
    const options = bullRootOptions('rediss://default:pw@redis.example:6380');
    expect(options.connection).toEqual({
      url: 'rediss://default:pw@redis.example:6380',
      maxRetriesPerRequest: null,
    });
    expect(options.defaultJobOptions).toEqual(DEFAULT_JOB_OPTIONS);
    // A copy: BullMQ may mutate options it is given.
    expect(options.defaultJobOptions).not.toBe(DEFAULT_JOB_OPTIONS);
  });

  describe('commentJobId', () => {
    it('builds <platform>:<commentId>:<verb> (3 parts, which BullMQ accepts)', () => {
      const id = commentJobId('FACEBOOK', '123456_789', 'add');
      expect(id).toBe('FACEBOOK:123456_789:add');
      expect(id.split(':')).toHaveLength(3);
      expect(commentJobId('INSTAGRAM', '17890', 'remove')).toBe(
        'INSTAGRAM:17890:remove',
      );
    });

    it.each([
      ['', '1_2', 'add', 'platform'],
      ['FACEBOOK', '', 'add', 'commentId'],
      ['FACEBOOK', '1_2', '', 'verb'],
      ['FACE:BOOK', '1_2', 'add', 'platform'],
      ['FACEBOOK', '1:2', 'add', 'commentId'],
      ['FACEBOOK', '1_2', 'ed:ited', 'verb'],
    ])('rejects %j / %j / %j (bad %s)', (platform, commentId, verb, label) => {
      expect(() => commentJobId(platform, commentId, verb)).toThrow(
        `Invalid ${label} for a comment job id`,
      );
    });

    it('adds the edit hash to edited ids, still 3 parts', () => {
      const hash = commentEditHash('new text');
      const id = commentJobId('FACEBOOK', '1_2', 'edited', hash);
      expect(id).toBe(`FACEBOOK:1_2:edited-${hash}`);
      expect(id.split(':')).toHaveLength(3);
    });

    it.each([
      ['edited', undefined],
      ['edited', 'abc'],
      ['edited', 'G'.repeat(16)],
      ['edited', 'a'.repeat(17)],
      ['add', 'a'.repeat(16)],
      ['remove', 'a'.repeat(16)],
    ])('rejects verb %j with edit hash %j', (verb, hash) => {
      expect(() => commentJobId('FACEBOOK', '1_2', verb, hash)).toThrow(
        'Invalid editHash for a comment job id',
      );
    });
  });

  describe('commentEditHash', () => {
    it('is 16 lower-case hex chars, stable per message, different per edit', () => {
      const hash = commentEditHash('bKash 01700000000');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
      expect(commentEditHash('bKash 01700000000')).toBe(hash);
      expect(commentEditHash('bKash 01800000000')).not.toBe(hash);
    });

    it('treats a missing message as empty text', () => {
      expect(commentEditHash(null)).toBe(commentEditHash(''));
    });
  });
});
