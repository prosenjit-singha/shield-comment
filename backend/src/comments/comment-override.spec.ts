import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MODERATION_SKIP_REASONS,
  type ModerationActionResult,
} from '../moderation/moderation-action.executor.js';
import { overrideError, toOverrideInput } from './comment-override.js';
import { CommentOverrideDto } from './dto/comment-override.dto.js';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(CommentOverrideDto, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return { dto, fields: errors.map((e) => e.property) };
}

const asHttp = (result: ModerationActionResult) => {
  const error = overrideError(result);
  expect(error).toBeInstanceOf(HttpException);
  return {
    status: error!.getStatus(),
    body: error!.getResponse() as Record<string, unknown>,
  };
};

describe('CommentOverrideDto', () => {
  it.each(['HIDE', 'UNHIDE', 'DELETE', 'KEEP'])(
    'accepts %s without replyText',
    async (action) => {
      expect((await check({ action })).fields).toEqual([]);
    },
  );

  it('trims a REPLY text and accepts 1–500 chars (Bangla too)', async () => {
    const { dto, fields } = await check({
      action: 'REPLY',
      replyText: '  ধন্যবাদ! Inbox korun.  ',
    });
    expect(fields).toEqual([]);
    expect(dto.replyText).toBe('ধন্যবাদ! Inbox korun.');
    expect(
      (await check({ action: 'REPLY', replyText: 'ক'.repeat(500) })).fields,
    ).toEqual([]);
  });

  it.each([
    [{}],
    [{ action: 'hide' }],
    [{ action: 'NONE' }],
    [{ action: 'REPLY' }],
    [{ action: 'REPLY', replyText: '   ' }],
    [{ action: 'REPLY', replyText: 'x'.repeat(501) }],
    [{ action: 'REPLY', replyText: 42 }],
    [{ action: 'HIDE', replyText: 'hello' }],
    [{ action: 'KEEP', replyText: '' }],
    [{ action: 'HIDE', userId: 'someone-else' }],
  ])('rejects %j', async (plain) => {
    expect((await check(plain)).fields.length).toBeGreaterThan(0);
  });
});

describe('toOverrideInput', () => {
  it('maps a member request to a USER executor input', () => {
    expect(
      toOverrideInput('w', 'c', 'u', { action: 'REPLY', replyText: 'Hi' }),
    ).toEqual({
      workspaceId: 'w',
      commentId: 'c',
      source: 'USER',
      userId: 'u',
      action: 'REPLY',
      replyText: 'Hi',
    });
    expect(toOverrideInput('w', 'c', 'u', { action: 'KEEP' })).toEqual({
      workspaceId: 'w',
      commentId: 'c',
      source: 'USER',
      userId: 'u',
      action: 'KEEP',
    });
  });
});

describe('overrideError', () => {
  it('is null on success', () => {
    expect(
      overrideError({
        outcome: 'succeeded',
        actionId: 'a',
        commentStatus: 'VISIBLE',
        replyCommentId: null,
        alreadyGone: false,
      }),
    ).toBeNull();
  });

  it('a Graph failure → 502 META_ACTION_FAILED with errorKind + retryable', () => {
    expect(
      asHttp({
        outcome: 'failed',
        actionId: 'a',
        errorKind: 'rate_limited',
        retryable: true,
        connectionMarked: false,
      }),
    ).toEqual({
      status: 502,
      body: expect.objectContaining({
        code: 'META_ACTION_FAILED',
        details: { errorKind: 'rate_limited', retryable: true },
      }),
    });
  });

  it('comment_not_found → 404, meta_not_configured → 503', () => {
    expect(
      asHttp({ outcome: 'skipped', reason: 'comment_not_found' }).status,
    ).toBe(404);
    expect(
      asHttp({ outcome: 'skipped', reason: 'meta_not_configured' }),
    ).toEqual({
      status: 503,
      body: expect.objectContaining({ code: 'META_NOT_CONFIGURED' }),
    });
  });

  it.each(
    MODERATION_SKIP_REASONS.filter(
      (r) => r !== 'comment_not_found' && r !== 'meta_not_configured',
    ),
  )('%s → 409 with the upper-case code and a message', (reason) => {
    const { status, body } = asHttp({ outcome: 'skipped', reason });
    expect(status).toBe(409);
    expect(body.code).toBe(reason.toUpperCase());
    expect(body.message).toEqual(expect.any(String));
  });
});
