import { Logger } from '@nestjs/common';
import type { TokenCipherService } from '../crypto/token-cipher.service.js';
import { tokenCipherContext } from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type { MetaGraphClient } from '../meta/meta-graph.client.js';
import { MetaGraphError } from '../meta/meta-graph.errors.js';
import * as pageQueries from '../meta/page-subscription.queries.js';
import { MAX_CAPTION_CHARS } from './classifier-input.js';
import {
  MAX_STORED_CAPTION_CHARS,
  POST_CONTEXT_TTL_MS,
} from './moderation.constants.js';
import * as queries from './post-context.queries.js';
import {
  type PostContextComment,
  PostContextService,
} from './post-context.service.js';

vi.mock('./post-context.queries.js', () => ({
  findPostContextSource: vi.fn(),
  findCachedPostContext: vi.fn(),
  upsertPostContext: vi.fn(),
}));

vi.mock('../meta/page-subscription.queries.js', () => ({
  markConnectionNeedsReauth: vi.fn(),
}));

const q = vi.mocked(queries);
const pq = vi.mocked(pageQueries);

const WS = '019a0000-0000-7000-8000-000000000001';
const PAGE_ROW = '019a0000-0000-7000-8000-0000000000a1';
const PAGE_ID = '1010000000000001';
const FB_POST = '1010000000000001_2020000000000002';
const IG_MEDIA = '17890000000000003';
const CIPHERTEXT = 'v1:ciphertext';
const TOKEN = 'EAAGpageTokenAbcdefghijklmnopqrstuvwxyz0123';
const AT = new Date('2026-11-19T10:00:00.000Z');
const CAPTION = 'ঈদ অফার! Premium cotton panjabi 1,250 taka';

const comment = (
  patch: Partial<PostContextComment> = {},
): PostContextComment => ({
  workspaceId: WS,
  socialPageId: PAGE_ROW,
  platform: 'FACEBOOK',
  postId: FB_POST,
  ...patch,
});

function source(
  patch: Partial<queries.PostContextSource> = {},
): queries.PostContextSource {
  return {
    pageRowId: PAGE_ROW,
    pageId: PAGE_ID,
    pageName: 'Deshi Fashion BD',
    isActive: true,
    encryptedPageAccessToken: CIPHERTEXT,
    connectionStatus: 'ACTIVE',
    ...patch,
  };
}

const graphError = (
  kind: ConstructorParameters<typeof MetaGraphError>[0],
  code?: number,
) => new MetaGraphError(kind, `Meta Graph 400: ${kind}`, { status: 400, code });

function setup() {
  const state = { inTx: false };
  const db = {
    tag: 'db',
    transaction: async <T>(fn: (t: unknown) => Promise<T>) => {
      state.inTx = true;
      try {
        return await fn({});
      } finally {
        state.inTx = false;
      }
    },
  };
  const graph = {
    enabled: true,
    getPostCaption: vi.fn(async (): Promise<string | null> => {
      if (state.inTx) throw new Error('Graph call inside a transaction');
      return CAPTION;
    }),
  };
  const cipher = {
    isConfigured: true,
    decrypt: vi.fn((): string => TOKEN),
  };
  const service = new PostContextService(
    db as unknown as Database,
    graph as unknown as MetaGraphClient,
    cipher as unknown as TokenCipherService,
  );
  return { db, graph, cipher, service };
}

describe('PostContextService (M5-T10, D8)', () => {
  const logs: string[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    logs.length = 0;
    for (const level of ['log', 'warn', 'debug', 'error'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation(
        (message: unknown) => {
          logs.push(String(message));
        },
      );
    }
    q.findPostContextSource.mockResolvedValue(source());
    q.findCachedPostContext.mockResolvedValue(undefined);
    q.upsertPostContext.mockResolvedValue(undefined);
    pq.markConnectionNeedsReauth.mockResolvedValue(true);
  });
  afterEach(() => {
    // Logs carry ids and kinds only: never the caption, the Page name or a token.
    for (const line of logs) {
      expect(line).not.toContain('panjabi');
      expect(line).not.toContain('Deshi');
      expect(line).not.toContain(TOKEN);
    }
    vi.restoreAllMocks();
  });

  describe('levels', () => {
    it('comment_only → both null, no reads, no Graph', async () => {
      const { service, graph } = setup();
      await expect(
        service.forComment(comment(), 'comment_only'),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(q.findPostContextSource).not.toHaveBeenCalled();
      expect(q.findCachedPostContext).not.toHaveBeenCalled();
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('an unknown level is treated as comment_only', async () => {
      const { service } = setup();
      await expect(
        service.forComment(comment(), 'everything' as never),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(q.findPostContextSource).not.toHaveBeenCalled();
    });

    it('page_name → the Page name (scoped read), no cache, no Graph', async () => {
      const { service, graph } = setup();
      await expect(service.forComment(comment(), 'page_name')).resolves.toEqual(
        { pageName: 'Deshi Fashion BD', postCaption: null },
      );
      expect(q.findPostContextSource).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        PAGE_ROW,
      );
      expect(q.findCachedPostContext).not.toHaveBeenCalled();
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('page_name: the name is normalised and capped at 200 chars', async () => {
      const { service } = setup();
      q.findPostContextSource.mockResolvedValue(
        source({ pageName: `  Deshi\n\tFashion ${'x'.repeat(300)}` }),
      );
      const { pageName } = await service.forComment(comment(), 'page_name');
      expect(pageName!.startsWith('Deshi Fashion x')).toBe(true);
      expect(Array.from(pageName!)).toHaveLength(200);
    });

    it('page_name / post_caption: an orphaned comment (no Page) → both null, no reads', async () => {
      const { service, graph } = setup();
      for (const level of ['page_name', 'post_caption'] as const) {
        await expect(
          service.forComment(comment({ socialPageId: null }), level),
        ).resolves.toEqual({ pageName: null, postCaption: null });
      }
      expect(q.findPostContextSource).not.toHaveBeenCalled();
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('a Page that is not this workspace’s (or gone) → both null', async () => {
      const { service, graph } = setup();
      q.findPostContextSource.mockResolvedValue(undefined);
      await expect(
        service.forComment(comment(), 'post_caption'),
      ).resolves.toEqual({ pageName: null, postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });
  });

  describe('post_caption: cache', () => {
    it('missing → Graph (platform, post id, decrypted Page token) → upsert → caption', async () => {
      const { service, graph, cipher } = setup();
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toEqual({
        pageName: 'Deshi Fashion BD',
        postCaption: CAPTION,
      });
      expect(q.findCachedPostContext).toHaveBeenCalledWith(
        expect.anything(),
        WS,
        'FACEBOOK',
        FB_POST,
      );
      expect(cipher.decrypt).toHaveBeenCalledWith(
        CIPHERTEXT,
        tokenCipherContext('meta_page_token', WS, PAGE_ID),
      );
      expect(graph.getPostCaption).toHaveBeenCalledWith(
        'FACEBOOK',
        FB_POST,
        TOKEN,
      );
      expect(q.upsertPostContext).toHaveBeenCalledWith(expect.anything(), {
        workspaceId: WS,
        socialPageId: PAGE_ROW,
        platform: 'FACEBOOK',
        postId: FB_POST,
        caption: CAPTION,
        fetchedAt: AT,
      });
      expect(q.upsertPostContext.mock.invocationCallOrder[0]!).toBeGreaterThan(
        graph.getPostCaption.mock.invocationCallOrder[0]!,
      );
    });

    it('IG media uses the INSTAGRAM platform', async () => {
      const { service, graph } = setup();
      await service.forComment(
        comment({ platform: 'INSTAGRAM', postId: IG_MEDIA }),
        'post_caption',
        () => AT,
      );
      expect(graph.getPostCaption).toHaveBeenCalledWith(
        'INSTAGRAM',
        IG_MEDIA,
        TOKEN,
      );
    });

    it('fresh hit (< 24 h) → cached caption, no Graph, no write, no decrypt', async () => {
      const { service, graph, cipher } = setup();
      q.findCachedPostContext.mockResolvedValue({
        caption: CAPTION,
        fetchedAt: new Date(AT.getTime() - POST_CONTEXT_TTL_MS + 1),
      });
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toEqual({
        pageName: 'Deshi Fashion BD',
        postCaption: CAPTION,
      });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
      expect(cipher.decrypt).not.toHaveBeenCalled();
      expect(q.upsertPostContext).not.toHaveBeenCalled();
    });

    it('fresh hit of "no text" → null without a Graph call', async () => {
      const { service, graph } = setup();
      q.findCachedPostContext.mockResolvedValue({
        caption: null,
        fetchedAt: AT,
      });
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toEqual({ pageName: 'Deshi Fashion BD', postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('stale (exactly 24 h) → Graph again + refreshed row', async () => {
      const { service, graph } = setup();
      q.findCachedPostContext.mockResolvedValue({
        caption: 'old caption',
        fetchedAt: new Date(AT.getTime() - POST_CONTEXT_TTL_MS),
      });
      graph.getPostCaption.mockResolvedValue('new caption');
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: 'new caption' });
      expect(graph.getPostCaption).toHaveBeenCalledTimes(1);
      expect(q.upsertPostContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ caption: 'new caption', fetchedAt: AT }),
      );
    });

    it('Graph says "no text" → cached as null, caption null', async () => {
      const { service, graph } = setup();
      graph.getPostCaption.mockResolvedValue(null);
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toEqual({ pageName: 'Deshi Fashion BD', postCaption: null });
      expect(q.upsertPostContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ caption: null }),
      );
    });

    it('stores ≤ 2,000 normalised chars and returns ≤ the classifier cap', async () => {
      const { service, graph } = setup();
      graph.getPostCaption.mockResolvedValue(
        `  Line one\n\nLine two ${'অ'.repeat(3000)}`,
      );
      const { postCaption } = await service.forComment(
        comment(),
        'post_caption',
        () => AT,
      );
      const stored = q.upsertPostContext.mock.calls[0]![1].caption!;
      expect(stored.startsWith('Line one Line two অ')).toBe(true);
      expect(Array.from(stored)).toHaveLength(MAX_STORED_CAPTION_CHARS);
      expect(Array.from(postCaption!)).toHaveLength(MAX_CAPTION_CHARS);
      expect(stored.startsWith(postCaption!)).toBe(true);
    });

    it('a cached caption longer than the classifier cap is cut too', async () => {
      const { service } = setup();
      q.findCachedPostContext.mockResolvedValue({
        caption: 'ক'.repeat(MAX_STORED_CAPTION_CHARS),
        fetchedAt: AT,
      });
      const { postCaption } = await service.forComment(
        comment(),
        'post_caption',
        () => AT,
      );
      expect(Array.from(postCaption!)).toHaveLength(MAX_CAPTION_CHARS);
    });
  });

  describe('post_caption: no caption (caller charges only what is sent)', () => {
    it.each([
      ['Page off', { isActive: false }],
      ['connection NEEDS_REAUTH', { connectionStatus: 'NEEDS_REAUTH' }],
      ['connection REVOKED', { connectionStatus: 'REVOKED' }],
      ['no connection', { connectionStatus: null }],
    ] as const)(
      '%s → Page name only; no cache read, no Graph',
      async (_label, patch) => {
        const { service, graph } = setup();
        q.findPostContextSource.mockResolvedValue(source(patch));
        q.findCachedPostContext.mockResolvedValue({
          caption: CAPTION,
          fetchedAt: AT,
        });
        await expect(
          service.forComment(comment(), 'post_caption', () => AT),
        ).resolves.toEqual({ pageName: 'Deshi Fashion BD', postCaption: null });
        expect(q.findCachedPostContext).not.toHaveBeenCalled();
        expect(graph.getPostCaption).not.toHaveBeenCalled();
      },
    );

    it('Meta unset or cipher unset → null, no Graph', async () => {
      for (const patch of [{ graph: false }, { cipher: false }]) {
        const { service, graph, cipher } = setup();
        graph.enabled = !('graph' in patch);
        cipher.isConfigured = !('cipher' in patch);
        await expect(
          service.forComment(comment(), 'post_caption', () => AT),
        ).resolves.toMatchObject({ postCaption: null });
        expect(graph.getPostCaption).not.toHaveBeenCalled();
      }
    });

    it('Page token missing → null, no Graph', async () => {
      const { service, graph } = setup();
      q.findPostContextSource.mockResolvedValue(
        source({ encryptedPageAccessToken: null }),
      );
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
    });

    it('undecryptable token → null, no Graph, connection untouched', async () => {
      const { service, graph, cipher } = setup();
      cipher.decrypt.mockImplementation(() => {
        throw new Error('bad tag');
      });
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
      expect(graph.getPostCaption).not.toHaveBeenCalled();
      expect(pq.markConnectionNeedsReauth).not.toHaveBeenCalled();
    });

    it.each([
      'rate_limited',
      'transient',
      'network',
      'permission',
      'invalid_request',
      'unexpected_response',
      'unknown',
    ] as const)(
      'Graph %s → null, nothing cached, connection untouched',
      async (kind) => {
        const { service, graph } = setup();
        graph.getPostCaption.mockRejectedValue(graphError(kind, 2));
        await expect(
          service.forComment(comment(), 'post_caption', () => AT),
        ).resolves.toEqual({ pageName: 'Deshi Fashion BD', postCaption: null });
        expect(q.upsertPostContext).not.toHaveBeenCalled();
        expect(pq.markConnectionNeedsReauth).not.toHaveBeenCalled();
        expect(logs).toContainEqual(
          expect.stringContaining(`caption read failed (${kind} #2)`),
        );
      },
    );

    it('a non-Graph error from the client → null (internal_error), nothing cached', async () => {
      const { service, graph } = setup();
      graph.getPostCaption.mockRejectedValue(new Error('boom'));
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
      expect(q.upsertPostContext).not.toHaveBeenCalled();
      expect(logs).toContainEqual(expect.stringContaining('internal_error'));
    });

    it('token_invalid → null + connection NEEDS_REAUTH (conditioned on the observed token)', async () => {
      const { service, graph } = setup();
      graph.getPostCaption.mockRejectedValue(graphError('token_invalid', 190));
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
      expect(pq.markConnectionNeedsReauth).toHaveBeenCalledWith(
        expect.anything(),
        {
          workspaceId: WS,
          pageRowId: PAGE_ROW,
          observedPageToken: CIPHERTEXT,
          now: AT,
        },
      );
      expect(q.upsertPostContext).not.toHaveBeenCalled();
      expect(logs).toContainEqual(expect.stringContaining('NEEDS_REAUTH'));
    });

    it('not_found (post deleted) → cached as "no text", null', async () => {
      const { service, graph } = setup();
      graph.getPostCaption.mockRejectedValue(graphError('not_found', 100));
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
      expect(q.upsertPostContext).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ caption: null, fetchedAt: AT }),
      );
    });

    it('the Page was deleted while Graph answered (FK violation) → null', async () => {
      const { service } = setup();
      q.upsertPostContext.mockRejectedValue(
        Object.assign(new Error('insert failed'), {
          cause: { code: '23503' },
        }),
      );
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).resolves.toMatchObject({ postCaption: null });
    });

    it('other DB errors propagate', async () => {
      const { service } = setup();
      q.upsertPostContext.mockRejectedValue(new Error('connection lost'));
      await expect(
        service.forComment(comment(), 'post_caption', () => AT),
      ).rejects.toThrow('connection lost');
    });
  });

  it('never opens a transaction (the Graph call checks)', async () => {
    const { service, db } = setup();
    const spy = vi.spyOn(db, 'transaction');
    await service.forComment(comment(), 'post_caption', () => AT);
    expect(spy).not.toHaveBeenCalled();
  });
});
