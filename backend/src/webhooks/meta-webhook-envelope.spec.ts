import {
  entry,
  envelope,
  FB_PAGE_ID,
  FB_POST_ID,
  fbCommentValue,
  fbPayload,
  IG_BUSINESS_ID,
  IG_MEDIA_ID,
  igCommentValue,
  igPayload,
} from '../../test/fixtures/meta-webhook-payloads.js';
import { webhookPayloadHash } from '../comments/comments.queries.js';
import { commentEditHash } from '../queue/queue.constants.js';
import { parseMetaWebhookEnvelope } from './meta-webhook-envelope.js';

const parse = (body: unknown) =>
  parseMetaWebhookEnvelope(Buffer.from(JSON.stringify(body)));

const FB_COMMENT_ID = '3000000000001_4000000000001';
const IG_COMMENT_ID = '18100000000000001';

describe('parseMetaWebhookEnvelope', () => {
  describe('Facebook Page feed', () => {
    it('turns an add into one job with the D3 id and the worker DTO', () => {
      const value = fbCommentValue();
      const result = parse(fbPayload(value));
      expect(result).toEqual({
        object: 'page',
        skipped: {},
        jobs: [
          {
            jobId: `FACEBOOK:${FB_COMMENT_ID}:add`,
            data: {
              eventId: `FACEBOOK:${FB_COMMENT_ID}:add`,
              platform: 'FACEBOOK',
              pageId: FB_PAGE_ID,
              verb: 'add',
              commentId: FB_COMMENT_ID,
              postId: FB_POST_ID,
              parentId: FB_POST_ID,
              authorId: '2000000000001',
              authorName: 'Rahim Uddin',
              message: 'bKash e taka pathan 01700000000',
              createdTime: 1763479990,
              entryTime: 1763480000,
              payloadHash: webhookPayloadHash(value),
              rawPayload: value,
            },
          },
        ],
      });
    });

    it('adds the edit hash of the new message to edited ids', () => {
      const edited = parse(
        fbPayload(fbCommentValue({ verb: 'edited', message: 'new 0180' })),
      );
      const hash = commentEditHash('new 0180');
      expect(edited.jobs[0]!.jobId).toBe(
        `FACEBOOK:${FB_COMMENT_ID}:edited-${hash}`,
      );
      expect(edited.jobs[0]!.data).toMatchObject({
        verb: 'edited',
        message: 'new 0180',
        eventId: edited.jobs[0]!.jobId,
      });
      const other = parse(
        fbPayload(fbCommentValue({ verb: 'edited', message: 'other' })),
      );
      expect(other.jobs[0]!.jobId).not.toBe(edited.jobs[0]!.jobId);
    });

    it('keeps a remove without message (Meta sends none)', () => {
      const value = fbCommentValue({ verb: 'remove' });
      delete value.message;
      const result = parse(fbPayload(value));
      expect(result.jobs).toHaveLength(1);
      expect(result.jobs[0]!.jobId).toBe(`FACEBOOK:${FB_COMMENT_ID}:remove`);
      expect(result.jobs[0]!.data.message).toBeNull();
    });

    it('allows a missing from (privacy rules) and odd author / time values', () => {
      const value = fbCommentValue({
        from: undefined,
        created_time: 'yesterday',
      });
      const result = parse(fbPayload(value));
      expect(result.jobs[0]!.data).toMatchObject({
        authorId: null,
        authorName: null,
        createdTime: null,
      });
      const named = parse(
        fbPayload(fbCommentValue({ from: { id: 'abc', name: 7 } })),
      );
      expect(named.jobs[0]!.data).toMatchObject({
        authorId: null,
        authorName: null,
      });
      expect(
        parse(fbPayload(fbCommentValue({ created_time: '1763479990' })))
          .jobs[0]!.data.createdTime,
      ).toBe(1763479990);
    });

    it.each([
      ['item', { item: 'status' }, 'unknown_item'],
      ['item', { item: 'reaction' }, 'unknown_item'],
      ['verb', { verb: 'hide' }, 'unknown_verb'],
      ['verb', { verb: undefined }, 'unknown_verb'],
    ] as const)('ignores an unknown %s (%j)', (_label, overrides, reason) => {
      const result = parse(fbPayload(fbCommentValue(overrides)));
      expect(result.jobs).toEqual([]);
      expect(result.skipped).toEqual({ [reason]: 1 });
    });

    it('ignores other Page fields (e.g. mention, live_comments)', () => {
      const result = parse(
        envelope('page', [
          entry(FB_PAGE_ID, [
            { field: 'mention', value: fbCommentValue() },
            { field: 'live_comments', value: fbCommentValue() },
            { field: 'comments', value: igCommentValue() },
          ]),
        ]),
      );
      expect(result.jobs).toEqual([]);
      expect(result.skipped).toEqual({ unknown_field: 3 });
    });

    it('skips comments written by the Page itself (D2)', () => {
      const result = parse(
        fbPayload(fbCommentValue({ from: { id: FB_PAGE_ID, name: 'Shop' } })),
      );
      expect(result.jobs).toEqual([]);
      expect(result.skipped).toEqual({ own_comment: 1 });
    });
  });

  describe('Instagram comments', () => {
    it('turns a comment into one add job', () => {
      const value = igCommentValue({ parent_id: '18100000000000000' });
      const result = parse(igPayload(value));
      expect(result).toEqual({
        object: 'instagram',
        skipped: {},
        jobs: [
          {
            jobId: `INSTAGRAM:${IG_COMMENT_ID}:add`,
            data: {
              eventId: `INSTAGRAM:${IG_COMMENT_ID}:add`,
              platform: 'INSTAGRAM',
              igBusinessId: IG_BUSINESS_ID,
              verb: 'add',
              commentId: IG_COMMENT_ID,
              postId: IG_MEDIA_ID,
              parentId: '18100000000000000',
              authorId: '5000000000001',
              authorName: 'karim.shop',
              message: 'Nagad e order korun',
              createdTime: null,
              entryTime: 1763480000,
              payloadHash: webhookPayloadHash(value),
              rawPayload: value,
            },
          },
        ],
      });
    });

    it('skips comments written by the IG account itself (D2)', () => {
      const result = parse(
        igPayload(igCommentValue({ from: { id: IG_BUSINESS_ID } })),
      );
      expect(result.skipped).toEqual({ own_comment: 1 });
      expect(result.jobs).toEqual([]);
    });

    it('ignores other IG fields (mentions, live_comments)', () => {
      const result = parse(
        envelope('instagram', [
          entry(IG_BUSINESS_ID, [
            { field: 'mentions', value: igCommentValue() },
            { field: 'live_comments', value: igCommentValue() },
            { field: 'feed', value: fbCommentValue() },
          ]),
        ]),
      );
      expect(result.skipped).toEqual({ unknown_field: 3 });
    });
  });

  it('handles a mixed batch: several entries and changes, duplicates once', () => {
    const second = fbCommentValue({
      comment_id: '3000000000001_4000000000002',
    });
    const otherPage = '1000000000002';
    const result = parse(
      envelope('page', [
        entry(FB_PAGE_ID, [
          { field: 'feed', value: fbCommentValue() },
          { field: 'feed', value: fbCommentValue({ item: 'post' }) },
          { field: 'feed', value: second },
          { field: 'feed', value: fbCommentValue() },
        ]),
        entry(otherPage, [
          {
            field: 'feed',
            value: fbCommentValue({
              comment_id: '3000000000009_4000000000009',
              post_id: `${otherPage}_3000000000009`,
              verb: 'remove',
            }),
          },
        ]),
      ]),
    );
    expect(result.jobs.map((job) => job.jobId)).toEqual([
      `FACEBOOK:${FB_COMMENT_ID}:add`,
      'FACEBOOK:3000000000001_4000000000002:add',
      'FACEBOOK:3000000000009_4000000000009:remove',
    ]);
    expect(result.jobs[2]!.data).toMatchObject({ pageId: otherPage });
    expect(result.skipped).toEqual({ unknown_item: 1, duplicate: 1 });
  });

  it.each([
    ['comment id', { comment_id: undefined }],
    ['comment id', { comment_id: '12:34' }],
    ['comment id', { comment_id: 'abc' }],
    ['post id', { post_id: undefined }],
    ['post id', { post_id: 'x_1' }],
  ])('ignores a change without a valid %s (%j)', (_label, overrides) => {
    const result = parse(fbPayload(fbCommentValue(overrides)));
    expect(result.jobs).toEqual([]);
    expect(result.skipped).toEqual({ missing_ids: 1 });
  });

  it('ignores an IG change without a media id or comment id', () => {
    expect(
      parse(igPayload(igCommentValue({ media: undefined }))).skipped,
    ).toEqual({ missing_ids: 1 });
    expect(parse(igPayload(igCommentValue({ id: 5 }))).skipped).toEqual({
      missing_ids: 1,
    });
  });

  it('drops an invalid parent id but keeps the comment', () => {
    const result = parse(fbPayload(fbCommentValue({ parent_id: 'nope' })));
    expect(result.jobs[0]!.data.parentId).toBeNull();
  });

  it.each([
    ['missing id', { time: 1, changes: [] }],
    ['non-numeric id', { id: 'page', time: 1, changes: [] }],
    ['no changes (e.g. messaging)', { id: FB_PAGE_ID, messaging: [] }],
    ['not an object', 'x'],
  ])('ignores an entry with %s', (_label, badEntry) => {
    const result = parse(envelope('page', [badEntry as never]));
    expect(result).toEqual({
      object: 'page',
      jobs: [],
      skipped: { invalid_entry: 1 },
    });
  });

  it('keeps entries with a missing time (entryTime null) and skips bad changes', () => {
    const result = parse(
      envelope('page', [
        entry(
          FB_PAGE_ID,
          [{ field: 'feed', value: fbCommentValue() }, 'x' as never],
          null,
        ),
      ]),
    );
    expect(result.jobs[0]!.data.entryTime).toBeNull();
    expect(result.skipped).toEqual({ unknown_field: 1 });
  });

  it.each([
    ['user', 'unknown_object'],
    ['whatsapp_business_account', 'unknown_object'],
    [undefined, 'unknown_object'],
  ])('ignores object %j', (object, reason) => {
    const result = parse({ object, entry: [] });
    expect(result).toEqual({
      object: null,
      jobs: [],
      skipped: { [reason]: 1 },
    });
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['no entry list', { object: 'page', entry: {} }],
  ])('ignores an envelope that is %s', (_label, body) => {
    expect(parse(body).skipped).toEqual({ invalid_envelope: 1 });
  });

  it.each([
    ['form data', 'a=1&b=2'],
    ['truncated JSON', '{"object":"page","entry":['],
    ['empty body', ''],
  ])('reports invalid JSON for %s', (_label, body) => {
    expect(parseMetaWebhookEnvelope(Buffer.from(body))).toEqual({
      object: null,
      jobs: [],
      skipped: { invalid_json: 1 },
    });
  });
});
