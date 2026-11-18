import {
  entry,
  envelope,
  fbCommentValue,
  fbPayload,
  igPayload,
} from '../../test/fixtures/meta-webhook-payloads.js';
import type { CommentIngestJobData } from '../webhooks/comment-ingest.job.js';
import { parseMetaWebhookEnvelope } from '../webhooks/meta-webhook-envelope.js';
import {
  decideIngestRoute,
  describeIngestError,
  errorCode,
  type IngestRoute,
  ingestEventInstant,
  ingestRoutingId,
  InvalidIngestJobError,
  isPermanentDbError,
  parseCommentIngestJob,
} from './comment-ingest.rules.js';

const NAME = 'comment-change';

/** Job data exactly as the receiver (M4-T4) builds it. */
function jobFrom(payload: Record<string, unknown>): CommentIngestJobData {
  const [job] = parseMetaWebhookEnvelope(JSON.stringify(payload)).jobs;
  if (!job) throw new Error('fixture produced no job');
  return job.data;
}

const route = (overrides: Partial<IngestRoute> = {}): IngestRoute => ({
  workspaceId: 'ws-1',
  socialPageId: 'page-row-1',
  pageId: '1000000000001',
  isActive: true,
  connectionStatus: 'ACTIVE',
  ...overrides,
});

describe('decideIngestRoute (D4/D9)', () => {
  it.each([
    ['unknown Page', undefined, 'unknown_page'],
    ['inactive Page', route({ isActive: false }), 'inactive_page'],
    [
      'REVOKED connection',
      route({ connectionStatus: 'REVOKED' }),
      'connection_revoked',
    ],
    [
      'REVOKED wins over inactive',
      route({ connectionStatus: 'REVOKED', isActive: false }),
      'connection_revoked',
    ],
    ['no connection row', route({ connectionStatus: null }), 'no_connection'],
  ])('%s → drop %s', (_label, input, reason) => {
    expect(decideIngestRoute(input)).toEqual({ kind: 'drop', reason });
  });

  it.each([['ACTIVE'], ['NEEDS_REAUTH']] as const)(
    'active Page + %s connection → ingest',
    (status) => {
      const r = route({ connectionStatus: status });
      expect(decideIngestRoute(r)).toEqual({ kind: 'ingest', route: r });
    },
  );
});

describe('ingestRoutingId', () => {
  it('is the Page id for FB and the IG business id for IG', () => {
    expect(ingestRoutingId(jobFrom(fbPayload()))).toBe('1000000000001');
    expect(ingestRoutingId(jobFrom(igPayload()))).toBe('17841400000000001');
  });
});

describe('ingestEventInstant', () => {
  const now = new Date('2026-11-18T12:00:00.500Z');
  const sec = (iso: string) => new Date(iso).getTime() / 1000;

  it('prefers entry.time, then created_time, then now', () => {
    expect(
      ingestEventInstant(
        {
          entryTime: sec('2026-11-18T10:00:00Z'),
          createdTime: sec('2026-11-17T10:00:00Z'),
        },
        now,
      ).toISOString(),
    ).toBe('2026-11-18T10:00:00.000Z');
    expect(
      ingestEventInstant(
        { entryTime: null, createdTime: sec('2026-11-17T10:00:00Z') },
        now,
      ).toISOString(),
    ).toBe('2026-11-17T10:00:00.000Z');
    expect(
      ingestEventInstant({ entryTime: null, createdTime: null }, now),
    ).toBe(now);
  });

  it('skips implausible timestamps (ms, before 2004, > 1 day ahead)', () => {
    expect(
      ingestEventInstant(
        { entryTime: Date.now(), createdTime: sec('2026-11-18T09:00:00Z') },
        now,
      ).toISOString(),
    ).toBe('2026-11-18T09:00:00.000Z');
    expect(
      ingestEventInstant({ entryTime: 1000, createdTime: null }, now),
    ).toBe(now);
    expect(
      ingestEventInstant(
        { entryTime: sec('2026-11-19T13:00:00Z'), createdTime: null },
        now,
      ),
    ).toBe(now);
    // Within a day of skew is still trusted; fractions are floored.
    expect(
      ingestEventInstant(
        { entryTime: sec('2026-11-19T11:00:00Z') + 0.7, createdTime: null },
        now,
      ).toISOString(),
    ).toBe('2026-11-19T11:00:00.000Z');
  });

  it('defaults to the current time', () => {
    vi.useFakeTimers({ now });
    try {
      expect(
        ingestEventInstant({ entryTime: null, createdTime: null }).getTime(),
      ).toBe(now.getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('parseCommentIngestJob', () => {
  it('accepts the receiver jobs (FB add/edited/remove, IG add)', () => {
    for (const payload of [
      fbPayload(),
      fbPayload(fbCommentValue({ verb: 'edited', message: 'new text' })),
      fbPayload(fbCommentValue({ verb: 'remove', message: undefined })),
      igPayload(),
      envelope('page', [
        entry(
          '1000000000001',
          [{ field: 'feed', value: fbCommentValue() }],
          'x',
        ),
      ]),
    ]) {
      const data = jobFrom(payload);
      expect(parseCommentIngestJob(NAME, data)).toBe(data);
    }
  });

  const valid = () => jobFrom(fbPayload());
  const reject = (name: string, data: unknown, reason: string) => {
    try {
      parseCommentIngestJob(name, data);
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidIngestJobError);
      expect((error as InvalidIngestJobError).reason).toBe(reason);
      return;
    }
    throw new Error('expected a rejection');
  };

  it('rejects another job name and non-object data', () => {
    reject('other', valid(), 'unknown job name other');
    reject(NAME, null, 'data is not an object');
    reject(NAME, [valid()], 'data is not an object');
  });

  it.each([
    ['platform', { platform: 'TIKTOK' }, 'platform'],
    ['page id', { pageId: 'abc' }, 'pageId'],
    ['missing page id', { pageId: undefined }, 'pageId'],
    ['verb', { verb: 'hide' }, 'verb'],
    ['comment id', { commentId: '1;drop' }, 'commentId'],
    ['post id', { postId: 7 }, 'postId'],
    ['event id format', { eventId: 'nope' }, 'eventId'],
    [
      'event id of another comment',
      { eventId: 'FACEBOOK:999_999:add' },
      'eventId',
    ],
    [
      'event id of another verb',
      { eventId: 'FACEBOOK:3000000000001_4000000000001:remove' },
      'eventId',
    ],
    [
      'event id of another platform',
      { eventId: 'INSTAGRAM:3000000000001_4000000000001:add' },
      'eventId',
    ],
    ['message type', { message: 5 }, 'message'],
    ['author name type', { authorName: {} }, 'authorName'],
    ['parent id type', { parentId: 1 }, 'parentId'],
    ['author id format', { authorId: 'u1' }, 'authorId'],
    ['created time', { createdTime: 'yesterday' }, 'createdTime'],
    ['entry time', { entryTime: Number.NaN }, 'entryTime'],
    ['payload hash', { payloadHash: 'abc' }, 'payloadHash'],
    ['raw payload', { rawPayload: 'x' }, 'rawPayload'],
  ])('rejects a bad %s', (_label, patch, reason) => {
    reject(NAME, { ...valid(), ...patch }, reason);
  });

  it('checks the IG routing id and the edited event id', () => {
    reject(NAME, { ...jobFrom(igPayload()), igBusinessId: '' }, 'igBusinessId');
    const edited = jobFrom(
      fbPayload(fbCommentValue({ verb: 'edited', message: 'x' })),
    );
    reject(
      NAME,
      { ...edited, eventId: edited.eventId.replace(/edited-.*/, 'add') },
      'eventId',
    );
  });
});

describe('error split', () => {
  const pg = (code: string) =>
    Object.assign(new Error('Failed query: insert … params: secret text'), {
      name: 'DrizzleQueryError',
      cause: Object.assign(new Error('pg says'), { code }),
    });

  it.each([
    ['22001', true],
    ['22P02', true],
    ['23502', true],
    ['23514', true],
    ['42703', true],
    ['23505', false],
    ['23503', false],
    ['40001', false],
    ['40P01', false],
    ['57P01', false],
    ['08006', false],
  ])('pg %s permanent = %s', (code, permanent) => {
    expect(isPermanentDbError(pg(code))).toBe(permanent);
  });

  it('treats non-SQL errors as retryable', () => {
    const conn = Object.assign(new Error('connect ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    expect(isPermanentDbError(conn)).toBe(false);
    expect(isPermanentDbError(new Error('boom'))).toBe(false);
    expect(isPermanentDbError('string')).toBe(false);
  });

  it('finds the code in the cause chain', () => {
    expect(errorCode(pg('23514'))).toBe('23514');
    expect(errorCode(new Error('x'))).toBeUndefined();
  });

  it('describes errors without DB messages (no comment text in logs)', () => {
    expect(describeIngestError(pg('23514'))).toBe('DrizzleQueryError 23514');
    expect(describeIngestError(new TypeError('x'))).toBe('TypeError');
    expect(describeIngestError(new InvalidIngestJobError('verb'))).toBe(
      'Invalid comment-ingest job: verb',
    );
    expect(describeIngestError('weird')).toBe('string');
  });
});
