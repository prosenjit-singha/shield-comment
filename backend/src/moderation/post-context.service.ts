import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type { CommentPlatform } from '../db/schema/comments.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import { MetaGraphError } from '../meta/meta-graph.errors.js';
import { markConnectionNeedsReauth } from '../meta/page-subscription.queries.js';
import {
  MAX_CAPTION_CHARS,
  MAX_PAGE_NAME_CHARS,
  normalizeText,
} from './classifier-input.js';
import {
  type ContextLevel,
  isContextLevel,
  MAX_STORED_CAPTION_CHARS,
  POST_CONTEXT_TTL_MS,
} from './moderation.constants.js';
import {
  findCachedPostContext,
  findPostContextSource,
  type PostContextSource,
  upsertPostContext,
} from './post-context.queries.js';

/** What `forComment` needs about a comment (a `comments` row has these fields). */
export interface PostContextComment {
  workspaceId: string;
  /** `null` = orphaned by a disconnect (M4-T9). */
  socialPageId: string | null;
  platform: CommentPlatform;
  /** FB post id / IG media id. */
  postId: string;
}

/** The extra data for the classifier (`ClassifierInput.pageName` / `postCaption`). */
export interface PostContext {
  pageName: string | null;
  /** Already cut to the classifier's cap (`MAX_CAPTION_CHARS`). */
  postCaption: string | null;
}

/** Why no caption was sent (logged as a code; the caller only sees `postCaption: null`). */
type NoCaptionReason =
  | 'page_inactive'
  | 'connection_inactive'
  | 'meta_not_configured'
  | 'page_token_missing'
  | 'page_token_undecryptable'
  | 'page_gone';

const NOTHING: PostContext = { pageName: null, postCaption: null };
const FK_VIOLATION = '23503';

function pgCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown }).cause ?? error;
  const code = (cause as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

const forClassifier = (caption: string | null): string | null => {
  if (caption === null) return null;
  const text = normalizeText(caption, MAX_CAPTION_CHARS);
  return text.length > 0 ? text : null;
};

/**
 * The D8 context of one comment (M5-T10): what the classifier may see besides the comment text.
 *
 * - `comment_only` → nothing, no reads.
 * - `page_name` → the Page name from `social_pages.page_name` (scoped by `workspace_id`), no Graph.
 * - `post_caption` → the Page name + the post caption from the `post_contexts` cache: a hit younger
 *   than 24 h is used as is (no Graph call); a stale or missing row is fetched with the Page token
 *   **outside any transaction**, then upserted (a post Meta no longer has is cached as "no text").
 *
 * Never throws for missing data: an orphaned comment, a Page that is off, a connection that is not
 * `ACTIVE`, Meta/cipher unset, a missing or undecryptable token or any Graph failure give
 * `postCaption: null` (the caller charges only for what is sent, D7/D8). `token_invalid` also moves
 * the connection to `NEEDS_REAUTH`. DB errors propagate. Logs ids and kinds only (never the
 * caption, the Page name or a token).
 */
@Injectable()
export class PostContextService {
  private readonly logger = new Logger(PostContextService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
  ) {}

  async forComment(
    comment: PostContextComment,
    level: ContextLevel,
    now: () => Date = () => new Date(),
  ): Promise<PostContext> {
    if (!isContextLevel(level) || level === 'comment_only') return NOTHING;
    if (comment.socialPageId === null) return NOTHING;
    const source = await findPostContextSource(
      this.db,
      comment.workspaceId,
      comment.socialPageId,
    );
    if (!source) return NOTHING;
    const name = normalizeText(source.pageName, MAX_PAGE_NAME_CHARS);
    const pageName = name.length > 0 ? name : null;
    if (level === 'page_name') return { pageName, postCaption: null };
    return { pageName, postCaption: await this.caption(comment, source, now) };
  }

  private async caption(
    comment: PostContextComment,
    source: PostContextSource,
    now: () => Date,
  ): Promise<string | null> {
    if (!source.isActive) return this.none(comment, 'page_inactive');
    if (source.connectionStatus !== 'ACTIVE') {
      return this.none(comment, 'connection_inactive');
    }
    const cached = await findCachedPostContext(
      this.db,
      comment.workspaceId,
      comment.platform,
      comment.postId,
    );
    if (
      cached &&
      now().getTime() - cached.fetchedAt.getTime() < POST_CONTEXT_TTL_MS
    ) {
      return forClassifier(cached.caption);
    }
    if (!this.graph.enabled || !this.cipher.isConfigured) {
      return this.none(comment, 'meta_not_configured');
    }
    const ciphertext = source.encryptedPageAccessToken;
    if (ciphertext === null) return this.none(comment, 'page_token_missing');
    let token: string;
    try {
      token = this.cipher.decrypt(
        ciphertext,
        tokenCipherContext(
          'meta_page_token',
          comment.workspaceId,
          source.pageId,
        ),
      );
    } catch {
      return this.none(comment, 'page_token_undecryptable');
    }

    let fetched: string | null;
    try {
      fetched = await this.graph.getPostCaption(
        comment.platform,
        comment.postId,
        token,
      );
    } catch (error) {
      if (error instanceof MetaGraphError && error.kind === 'not_found') {
        // The post is gone: cache "no text" so its other comments don't ask again for 24 h.
        fetched = null;
      } else {
        await this.graphFailed(comment, source, ciphertext, error, now());
        return null;
      }
    }

    const caption =
      fetched === null ? '' : normalizeText(fetched, MAX_STORED_CAPTION_CHARS);
    try {
      await upsertPostContext(this.db, {
        workspaceId: comment.workspaceId,
        socialPageId: source.pageRowId,
        platform: comment.platform,
        postId: comment.postId,
        caption: caption.length > 0 ? caption : null,
        fetchedAt: now(),
      });
    } catch (error) {
      // The Page was deleted (disconnect / Data Deletion) while Graph answered: send nothing.
      if (pgCode(error) === FK_VIOLATION)
        return this.none(comment, 'page_gone');
      throw error;
    }
    return forClassifier(caption);
  }

  private async graphFailed(
    comment: PostContextComment,
    source: PostContextSource,
    ciphertext: string,
    error: unknown,
    at: Date,
  ): Promise<void> {
    const kind =
      error instanceof MetaGraphError ? error.kind : 'internal_error';
    const code =
      error instanceof MetaGraphError && error.code !== undefined
        ? ` #${error.code}`
        : '';
    this.logger.warn(
      `Post ${comment.postId} (workspace ${comment.workspaceId}): caption read failed (${kind}${code})`,
    );
    if (kind !== 'token_invalid') return;
    const marked = await markConnectionNeedsReauth(this.db, {
      workspaceId: comment.workspaceId,
      pageRowId: source.pageRowId,
      observedPageToken: ciphertext,
      now: at,
    });
    if (marked) {
      this.logger.warn(
        `Workspace ${comment.workspaceId}: Meta connection ACTIVE → NEEDS_REAUTH (Page token rejected)`,
      );
    }
  }

  private none(comment: PostContextComment, reason: NoCaptionReason): null {
    this.logger.debug(
      `Post ${comment.postId} (workspace ${comment.workspaceId}): no caption (${reason})`,
    );
    return null;
  }
}
