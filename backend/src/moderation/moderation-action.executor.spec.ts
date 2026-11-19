import { Logger } from '@nestjs/common';
import type { TokenCipherService } from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type { MetaGraphClient } from '../meta/meta-graph.client.js';
import { MetaGraphError } from '../meta/meta-graph.errors.js';
import * as pageQueries from '../meta/page-subscription.queries.js';
import {
  type ExecuteModerationActionInput,
  ModerationActionExecutor,
} from './moderation-action.executor.js';
import * as actionQueries from './moderation-action.queries.js';
import * as queries from './moderation.queries.js';

vi.mock('./moderation-action.queries.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./moderation-action.queries.js')>();
  return {
    ...actual,
    findActionTarget: vi.fn(),
    stampCommentOverride: vi.fn(),
    applyActionToComment: vi.fn(),
  };
});

vi.mock('./moderation.queries.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./moderation.queries.js')>();
  return {
    ...actual,
    insertModerationAction: vi.fn(),
    completeModerationAction: vi.fn(),
    reopenModerationAction: vi.fn(),
    findAutoReplyAction: vi.fn(),
  };
});

vi.mock('../meta/page-subscription.queries.js', () => ({
  markConnectionNeedsReauth: vi.fn(),
}));

const aq = vi.mocked(actionQueries);
const q = vi.mocked(queries);
const pq = vi.mocked(pageQueries);

const WS = '019a0000-0000-7000-8000-000000000001';
const COMMENT = '019a0000-0000-7000-8000-0000000000c1';
const PAGE_ROW = '019a0000-0000-7000-8000-0000000000a1';
const USER = '019a0000-0000-7000-8000-0000000000b1';
const ACTION = '019a0000-0000-7000-8000-0000000000d1';
const FB_COMMENT = '1010000000000001_2020000000000002';
const PAGE_ID = '1010000000000001';
const CIPHERTEXT = 'v1:ciphertext';
const TOKEN = 'EAAGpageTokenAbcdefghijklmnopqrstuvwxyz0123';
const AT = new Date('2026-11-19T10:00:00.000Z');
const REPLY_TEXT = 'Inbox e details pathachhi';

function target(
  patch: Partial<actionQueries.ActionTarget> = {},
): actionQueries.ActionTarget {
  return {
    id: COMMENT,
    workspaceId: WS,
    metaCommentId: FB_COMMENT,
    platform: 'FACEBOOK',
    status: 'PENDING',
    deletedAt: null,
    overriddenAt: null,
    page: {
      id: PAGE_ROW,
      pageId: PAGE_ID,
      isActive: true,
      encryptedPageAccessToken: CIPHERTEXT,
    },
    connectionStatus: 'ACTIVE',
    ...patch,
  };
}

function actionRow(
  patch: Partial<queries.ModerationActionRow> = {},
): queries.ModerationActionRow {
  return {
    id: ACTION,
    workspaceId: WS,
    commentId: COMMENT,
    action: 'HIDE',
    source: 'AUTO',
    userId: null,
    state: 'PENDING',
    errorKind: null,
    replyCommentId: null,
    completedAt: null,
    createdAt: AT,
    updatedAt: AT,
    ...patch,
  };
}

const graphError = (
  kind: ConstructorParameters<typeof MetaGraphError>[0],
  code?: number,
) => new MetaGraphError(kind, `Meta Graph 400: ${kind}`, { status: 400, code });

function setup() {
  const tx = { tag: 'tx' };
  const state = { inTx: false, transactions: 0 };
  const db = {
    tag: 'db',
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => {
      state.transactions++;
      state.inTx = true;
      try {
        return await fn(tx);
      } finally {
        state.inTx = false;
      }
    },
  };
  // Every Graph call checks that no transaction is open while it runs.
  const outsideTx = () => {
    if (state.inTx) throw new Error('Graph call inside a transaction');
  };
  const graph = {
    enabled: true,
    hideComment: vi.fn(async () => outsideTx()),
    unhideComment: vi.fn(async () => outsideTx()),
    deleteComment: vi.fn(async () => outsideTx()),
    replyToComment: vi.fn(async () => {
      outsideTx();
      return { id: '2020000000000002_3030000000000003' };
    }),
  };
  const cipher = {
    isConfigured: true,
    decrypt: vi.fn((): string => TOKEN),
  };
  const executor = new ModerationActionExecutor(
    db as unknown as Database,
    graph as unknown as MetaGraphClient,
    cipher as unknown as TokenCipherService,
  );
  const run = (input: ExecuteModerationActionInput) =>
    executor.execute(input, () => AT);
  return { executor, run, db, tx, graph, cipher, state };
}

const auto = (
  action: 'HIDE' | 'UNHIDE' | 'DELETE',
): ExecuteModerationActionInput => ({
  workspaceId: WS,
  commentId: COMMENT,
  action,
  source: 'AUTO',
});
const autoReply: ExecuteModerationActionInput = {
  workspaceId: WS,
  commentId: COMMENT,
  action: 'REPLY',
  source: 'AUTO',
  replyText: REPLY_TEXT,
};

const logSpies = [
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined),
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined),
];

beforeEach(() => {
  vi.resetAllMocks();
  for (const spy of logSpies) spy.mockImplementation(() => undefined);
  aq.findActionTarget.mockResolvedValue(target());
  aq.stampCommentOverride.mockResolvedValue(true);
  aq.applyActionToComment.mockResolvedValue(true);
  q.insertModerationAction.mockImplementation(async (_tx, values) =>
    actionRow({
      action: values.action,
      source: values.source,
      userId: values.source === 'USER' ? values.userId : null,
    }),
  );
  q.completeModerationAction.mockImplementation(
    async (_tx, _ws, _id, outcome) => actionRow({ state: outcome.state }),
  );
  q.findAutoReplyAction.mockResolvedValue(undefined);
  q.reopenModerationAction.mockResolvedValue(
    actionRow({ action: 'REPLY', state: 'PENDING' }),
  );
  pq.markConnectionNeedsReauth.mockResolvedValue(true);
});

afterEach(() => {
  // Logs carry ids and kinds only: never the token, ciphertext or reply text.
  for (const spy of logSpies) {
    for (const args of spy.mock.calls) {
      const line = args.map(String).join(' ');
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(CIPHERTEXT);
      expect(line).not.toContain(REPLY_TEXT);
    }
    spy.mockClear();
  }
});

afterAll(() => {
  for (const spy of logSpies) spy.mockRestore();
});

describe('ModerationActionExecutor', () => {
  describe('skip rules (no Graph call, no row)', () => {
    it.each([
      ['comment_not_found', undefined],
      ['comment_deleted', target({ deletedAt: AT })],
      ['comment_deleted', target({ status: 'DELETED' })],
      ['human_override', target({ overriddenAt: AT })],
      ['page_disconnected', target({ page: null })],
      [
        'page_inactive',
        target({
          page: {
            id: PAGE_ROW,
            pageId: PAGE_ID,
            isActive: false,
            encryptedPageAccessToken: CIPHERTEXT,
          },
        }),
      ],
      ['connection_inactive', target({ connectionStatus: 'NEEDS_REAUTH' })],
      ['connection_inactive', target({ connectionStatus: 'REVOKED' })],
      ['connection_inactive', target({ connectionStatus: null })],
      [
        'page_token_missing',
        target({
          page: {
            id: PAGE_ROW,
            pageId: PAGE_ID,
            isActive: true,
            encryptedPageAccessToken: null,
          },
        }),
      ],
    ] as const)('%s', async (reason, found) => {
      const { run, graph, state } = setup();
      aq.findActionTarget.mockResolvedValue(found);
      for (const input of [auto('HIDE'), auto('DELETE'), autoReply]) {
        await expect(run(input)).resolves.toEqual({
          outcome: 'skipped',
          reason,
        });
      }
      expect(graph.hideComment).not.toHaveBeenCalled();
      expect(graph.deleteComment).not.toHaveBeenCalled();
      expect(graph.replyToComment).not.toHaveBeenCalled();
      expect(state.transactions).toBe(0);
      expect(q.insertModerationAction).not.toHaveBeenCalled();
    });

    it('reads the comment scoped by workspace', async () => {
      const { run } = setup();
      await run(auto('HIDE'));
      expect(aq.findActionTarget).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'db' }),
        WS,
        COMMENT,
      );
    });

    it('a member may still act on a human-stamped comment', async () => {
      const { run, graph } = setup();
      aq.findActionTarget.mockResolvedValue(target({ overriddenAt: AT }));
      const result = await run({
        workspaceId: WS,
        commentId: COMMENT,
        action: 'UNHIDE',
        source: 'USER',
        userId: USER,
      });
      expect(result).toMatchObject({ outcome: 'succeeded' });
      expect(graph.unhideComment).toHaveBeenCalledTimes(1);
    });

    it('Meta or the cipher unset → meta_not_configured', async () => {
      for (const unset of ['graph', 'cipher'] as const) {
        const { run, graph, cipher } = setup();
        if (unset === 'graph') graph.enabled = false;
        else cipher.isConfigured = false;
        await expect(run(auto('HIDE'))).resolves.toEqual({
          outcome: 'skipped',
          reason: 'meta_not_configured',
        });
        expect(graph.hideComment).not.toHaveBeenCalled();
      }
    });

    it('an undecryptable Page token → page_token_undecryptable', async () => {
      const { run, graph, cipher } = setup();
      cipher.decrypt.mockImplementation(() => {
        throw new Error('bad tag');
      });
      await expect(run(auto('HIDE'))).resolves.toEqual({
        outcome: 'skipped',
        reason: 'page_token_undecryptable',
      });
      expect(graph.hideComment).not.toHaveBeenCalled();
      expect(q.insertModerationAction).not.toHaveBeenCalled();
    });

    it('decrypts with the Page token context', async () => {
      const { run, cipher } = setup();
      await run(auto('HIDE'));
      expect(cipher.decrypt).toHaveBeenCalledWith(
        CIPHERTEXT,
        `meta_page_token:${WS}:${PAGE_ID}`,
      );
    });

    it('rejects an empty reply text before any read', async () => {
      const { run } = setup();
      await expect(run({ ...autoReply, replyText: '  ' })).rejects.toThrow(
        'replyText',
      );
      expect(aq.findActionTarget).not.toHaveBeenCalled();
    });
  });

  describe('PENDING → Graph (outside any tx) → SUCCEEDED + comment status', () => {
    it.each([
      ['HIDE', 'hideComment', 'HIDDEN'],
      ['UNHIDE', 'unhideComment', 'VISIBLE'],
      ['DELETE', 'deleteComment', 'DELETED'],
    ] as const)('%s', async (action, method, status) => {
      const { run, graph, state } = setup();
      const result = await run(auto(action));
      expect(result).toEqual({
        outcome: 'succeeded',
        actionId: ACTION,
        commentStatus: status,
        replyCommentId: null,
        alreadyGone: false,
      });
      expect(q.insertModerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        { workspaceId: WS, commentId: COMMENT, action, source: 'AUTO' },
      );
      expect(graph[method]).toHaveBeenCalledTimes(1);
      if (action === 'DELETE') {
        expect(graph.deleteComment).toHaveBeenCalledWith(FB_COMMENT, TOKEN);
      } else {
        expect(graph[method]).toHaveBeenCalledWith(
          'FACEBOOK',
          FB_COMMENT,
          TOKEN,
        );
      }
      expect(q.completeModerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        WS,
        ACTION,
        { state: 'SUCCEEDED', replyCommentId: undefined },
        AT,
      );
      expect(aq.applyActionToComment).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        WS,
        COMMENT,
        action,
        AT,
      );
      expect(aq.stampCommentOverride).not.toHaveBeenCalled();
      // One tx to open the row, one to finish it; the Graph call ran between them.
      expect(state.transactions).toBe(2);
    });

    it('passes the Instagram platform through', async () => {
      const { run, graph } = setup();
      aq.findActionTarget.mockResolvedValue(
        target({ platform: 'INSTAGRAM', metaCommentId: '17890000000000003' }),
      );
      await run(auto('HIDE'));
      expect(graph.hideComment).toHaveBeenCalledWith(
        'INSTAGRAM',
        '17890000000000003',
        TOKEN,
      );
    });

    it('USER actions log the member and stamp overridden_at in the opening tx', async () => {
      const { run } = setup();
      const result = await run({
        workspaceId: WS,
        commentId: COMMENT,
        action: 'HIDE',
        source: 'USER',
        userId: USER,
      });
      expect(result).toMatchObject({ outcome: 'succeeded' });
      expect(q.insertModerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        {
          workspaceId: WS,
          commentId: COMMENT,
          action: 'HIDE',
          source: 'USER',
          userId: USER,
        },
      );
      expect(aq.stampCommentOverride).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        WS,
        COMMENT,
        AT,
      );
    });

    it('a vanished comment at insert time → comment_not_found, no Graph call', async () => {
      const { run, graph } = setup();
      q.insertModerationAction.mockResolvedValue(undefined);
      await expect(run(auto('HIDE'))).resolves.toEqual({
        outcome: 'skipped',
        reason: 'comment_not_found',
      });
      expect(graph.hideComment).not.toHaveBeenCalled();
    });
  });

  describe('Graph failures', () => {
    it.each([
      ['rate_limited', true],
      ['transient', true],
      ['network', true],
      ['permission', false],
      ['invalid_request', false],
      ['unknown', false],
    ] as const)('%s → FAILED, retryable %s', async (kind, retryable) => {
      const { run, graph } = setup();
      graph.hideComment.mockRejectedValue(graphError(kind));
      await expect(run(auto('HIDE'))).resolves.toEqual({
        outcome: 'failed',
        actionId: ACTION,
        errorKind: kind,
        retryable,
        connectionMarked: false,
      });
      expect(q.completeModerationAction).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        ACTION,
        { state: 'FAILED', errorKind: kind },
        AT,
      );
      expect(aq.applyActionToComment).not.toHaveBeenCalled();
      expect(pq.markConnectionNeedsReauth).not.toHaveBeenCalled();
    });

    it('token_invalid → FAILED + connection NEEDS_REAUTH (conditioned on the used ciphertext)', async () => {
      const { run, graph } = setup();
      graph.unhideComment.mockRejectedValue(graphError('token_invalid', 190));
      await expect(run(auto('UNHIDE'))).resolves.toEqual({
        outcome: 'failed',
        actionId: ACTION,
        errorKind: 'token_invalid',
        retryable: false,
        connectionMarked: true,
      });
      expect(pq.markConnectionNeedsReauth).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'db' }),
        {
          workspaceId: WS,
          pageRowId: PAGE_ROW,
          observedPageToken: CIPHERTEXT,
          now: AT,
        },
      );
    });

    it('not_found on DELETE = already gone: SUCCEEDED + DELETED', async () => {
      const { run, graph } = setup();
      graph.deleteComment.mockRejectedValue(graphError('not_found', 100));
      await expect(run(auto('DELETE'))).resolves.toEqual({
        outcome: 'succeeded',
        actionId: ACTION,
        commentStatus: 'DELETED',
        replyCommentId: null,
        alreadyGone: true,
      });
      expect(q.completeModerationAction).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        ACTION,
        { state: 'SUCCEEDED' },
        AT,
      );
      expect(aq.applyActionToComment).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        COMMENT,
        'DELETE',
        AT,
      );
    });

    it.each(['HIDE', 'UNHIDE'] as const)(
      'not_found on %s = FAILED not_found (not retryable)',
      async (action) => {
        const { run, graph } = setup();
        graph.hideComment.mockRejectedValue(graphError('not_found', 100));
        graph.unhideComment.mockRejectedValue(graphError('not_found', 100));
        await expect(run(auto(action))).resolves.toMatchObject({
          outcome: 'failed',
          errorKind: 'not_found',
          retryable: false,
        });
        expect(aq.applyActionToComment).not.toHaveBeenCalled();
      },
    );

    it('a non-Graph error marks the row FAILED internal_error and is rethrown', async () => {
      const { run, graph } = setup();
      graph.hideComment.mockRejectedValue(new Error('boom'));
      await expect(run(auto('HIDE'))).rejects.toThrow('boom');
      expect(q.completeModerationAction).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        ACTION,
        { state: 'FAILED', errorKind: 'internal_error' },
        AT,
      );
    });
  });

  describe('REPLY (D6: never sent twice)', () => {
    it('first auto-reply: inserts the AUTO row, posts, stores the reply id; no status change', async () => {
      const { run, graph } = setup();
      const result = await run(autoReply);
      expect(result).toEqual({
        outcome: 'succeeded',
        actionId: ACTION,
        commentStatus: null,
        replyCommentId: '2020000000000002_3030000000000003',
        alreadyGone: false,
      });
      expect(q.findAutoReplyAction).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        WS,
        COMMENT,
      );
      expect(graph.replyToComment).toHaveBeenCalledWith(
        'FACEBOOK',
        FB_COMMENT,
        REPLY_TEXT,
        TOKEN,
      );
      expect(q.completeModerationAction).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        ACTION,
        {
          state: 'SUCCEEDED',
          replyCommentId: '2020000000000002_3030000000000003',
        },
        AT,
      );
    });

    it.each(['SUCCEEDED', 'PENDING'] as const)(
      'an existing %s auto-reply → already_replied, nothing sent',
      async (existingState) => {
        const { run, graph } = setup();
        q.findAutoReplyAction.mockResolvedValue(
          actionRow({ action: 'REPLY', state: existingState }),
        );
        await expect(run(autoReply)).resolves.toEqual({
          outcome: 'skipped',
          reason: 'already_replied',
        });
        expect(graph.replyToComment).not.toHaveBeenCalled();
        expect(q.insertModerationAction).not.toHaveBeenCalled();
        expect(q.reopenModerationAction).not.toHaveBeenCalled();
      },
    );

    it('a FAILED auto-reply is reopened and retried (same row)', async () => {
      const { run, graph } = setup();
      q.findAutoReplyAction.mockResolvedValue(
        actionRow({
          action: 'REPLY',
          state: 'FAILED',
          errorKind: 'rate_limited',
        }),
      );
      await expect(run(autoReply)).resolves.toMatchObject({
        outcome: 'succeeded',
        actionId: ACTION,
      });
      expect(q.reopenModerationAction).toHaveBeenCalledWith(
        expect.objectContaining({ tag: 'tx' }),
        WS,
        ACTION,
        AT,
      );
      expect(q.insertModerationAction).not.toHaveBeenCalled();
      expect(graph.replyToComment).toHaveBeenCalledTimes(1);
    });

    it('a concurrent retry reopened the FAILED row first → already_replied', async () => {
      const { run, graph } = setup();
      q.findAutoReplyAction.mockResolvedValue(
        actionRow({ action: 'REPLY', state: 'FAILED', errorKind: 'network' }),
      );
      q.reopenModerationAction.mockResolvedValue(undefined);
      await expect(run(autoReply)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'already_replied',
      });
      expect(graph.replyToComment).not.toHaveBeenCalled();
    });

    it('a racing insert (unique violation) → already_replied', async () => {
      const { run, graph } = setup();
      q.insertModerationAction.mockRejectedValue(
        Object.assign(new Error('insert failed'), {
          cause: { code: '23505' },
        }),
      );
      await expect(run(autoReply)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'already_replied',
      });
      expect(graph.replyToComment).not.toHaveBeenCalled();
    });

    it('other DB errors while opening propagate', async () => {
      const { run } = setup();
      q.insertModerationAction.mockRejectedValue(
        Object.assign(new Error('db down'), { cause: { code: '08006' } }),
      );
      await expect(run(autoReply)).rejects.toThrow('db down');
    });

    it('a 2xx without a reply id counts as sent (SUCCEEDED, no id): never retried', async () => {
      const { run, graph } = setup();
      graph.replyToComment.mockRejectedValue(graphError('unexpected_response'));
      await expect(run(autoReply)).resolves.toEqual({
        outcome: 'succeeded',
        actionId: ACTION,
        commentStatus: null,
        replyCommentId: null,
        alreadyGone: false,
      });
    });

    it('not_found on REPLY = FAILED not_found', async () => {
      const { run, graph } = setup();
      graph.replyToComment.mockRejectedValue(graphError('not_found', 100));
      await expect(run(autoReply)).resolves.toMatchObject({
        outcome: 'failed',
        errorKind: 'not_found',
        retryable: false,
      });
    });

    it('never replies to a deleted comment', async () => {
      const { run, graph } = setup();
      aq.findActionTarget.mockResolvedValue(target({ deletedAt: AT }));
      await expect(run(autoReply)).resolves.toEqual({
        outcome: 'skipped',
        reason: 'comment_deleted',
      });
      expect(graph.replyToComment).not.toHaveBeenCalled();
    });

    it('a member reply is a new USER row each time and stamps the comment', async () => {
      const { run, graph } = setup();
      await run({
        workspaceId: WS,
        commentId: COMMENT,
        action: 'REPLY',
        source: 'USER',
        userId: USER,
        replyText: REPLY_TEXT,
      });
      expect(q.findAutoReplyAction).not.toHaveBeenCalled();
      expect(q.insertModerationAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'REPLY', source: 'USER' }),
      );
      expect(aq.stampCommentOverride).toHaveBeenCalled();
      expect(graph.replyToComment).toHaveBeenCalledTimes(1);
    });
  });
});
