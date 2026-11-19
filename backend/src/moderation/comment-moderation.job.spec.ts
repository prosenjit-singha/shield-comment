import {
  InvalidModerationJobError,
  MODERATE_COMMENT_JOB_NAME,
  moderateCommentJob,
  moderationEditKey,
  moderationJobId,
  parseModerateCommentJob,
} from './comment-moderation.job.js';

const WS = '0190f000-0000-7000-8000-000000000001';
const ROW = '0190f000-0000-7000-8000-0000000000c1';
const AT = new Date('2026-11-19T10:00:00.123Z');

describe('comment-moderation job contract', () => {
  it('edit key: `add` for the original text, `edit-<ms>` for an edit', () => {
    expect(moderationEditKey(null)).toBe('add');
    expect(moderationEditKey(AT)).toBe(`edit-${AT.getTime()}`);
    expect(() => moderationEditKey(new Date('x'))).toThrow();
  });

  it('job id has exactly 3 `:` parts (BullMQ rule) and is stable per version', () => {
    const id = moderationJobId(ROW, AT);
    expect(id).toBe(`moderate:${ROW}:edit-${AT.getTime()}`);
    expect(id.split(':')).toHaveLength(3);
    expect(moderationJobId(ROW, new Date(AT.getTime()))).toBe(id);
    expect(moderationJobId(ROW, null)).toBe(`moderate:${ROW}:add`);
    expect(() => moderationJobId('c1', null)).toThrow();
  });

  it('builds the job with the D3 defaults, ids and the version only', () => {
    const job = moderateCommentJob({
      workspaceId: WS,
      commentRowId: ROW,
      editedAt: AT,
    });
    expect(job).toEqual({
      name: MODERATE_COMMENT_JOB_NAME,
      data: { workspaceId: WS, commentRowId: ROW, editedAt: AT.toISOString() },
      opts: expect.objectContaining({
        jobId: `moderate:${ROW}:edit-${AT.getTime()}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
      }),
    });
    expect(() =>
      moderateCommentJob({
        workspaceId: 'ws',
        commentRowId: ROW,
        editedAt: null,
      }),
    ).toThrow();
  });

  it('parses its own data back (round trip)', () => {
    expect(
      parseModerateCommentJob(
        moderateCommentJob({ workspaceId: WS, commentRowId: ROW, editedAt: AT })
          .data,
      ),
    ).toEqual({ workspaceId: WS, commentRowId: ROW, editedAt: AT });
    expect(
      parseModerateCommentJob({ workspaceId: WS, commentRowId: ROW }),
    ).toEqual({ workspaceId: WS, commentRowId: ROW, editedAt: null });
  });

  it.each([
    [null, 'data'],
    [[], 'data'],
    [{ commentRowId: ROW }, 'workspaceId'],
    [{ workspaceId: WS, commentRowId: 'x' }, 'commentRowId'],
    [{ workspaceId: WS, commentRowId: ROW, editedAt: 'yesterday' }, 'editedAt'],
    [{ workspaceId: WS, commentRowId: ROW, editedAt: 5 }, 'editedAt'],
  ])('rejects %j (%s)', (data, reason) => {
    const error = (() => {
      try {
        parseModerateCommentJob(data);
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(InvalidModerationJobError);
    expect((error as InvalidModerationJobError).reason).toBe(reason);
  });
});
