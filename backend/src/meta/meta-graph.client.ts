import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CommentPlatform } from '../db/schema/comments.js';
import { META_APP_CONFIG, type MetaAppConfig } from './meta-graph.config.js';
import {
  graphErrorFromResponse,
  MetaGraphError,
  MetaNotConfiguredError,
} from './meta-graph.errors.js';

const DIALOG_HOST = 'https://www.facebook.com';
const GRAPH_HOST = 'https://graph.facebook.com';
const DEFAULT_TIMEOUT_MS = 10_000;
/** `/me/accounts` page size and the most pages we follow (100 × 50 = 5,000 Pages). */
const ACCOUNTS_PAGE_SIZE = 100;
const MAX_ACCOUNT_PAGES = 50;
const ACCOUNT_FIELDS =
  'id,name,access_token,instagram_business_account{id,username}';
/**
 * `subscribed_fields` for `POST /{page-id}/subscribed_apps` (Module 4 D2: `feed`). Instagram
 * `comments` arrive through the app's `instagram` webhook object for the IG account linked to the
 * Page; Meta only asks that the app be installed on that Page with **any** Page field, so `feed`
 * covers both (M4-T8).
 */
export const PAGE_SUBSCRIBED_FIELDS = 'feed';

export interface MetaAccessToken {
  accessToken: string;
  /** `null` when Meta sent no `expires_in` (or 0 = no expiry). */
  expiresAt: Date | null;
}

export interface MetaUser {
  id: string;
  name: string | null;
}

export interface MetaPageAccount {
  /** Facebook Page id. */
  id: string;
  name: string;
  /** Page access token (non-expiring when fetched with a long-lived user token). */
  accessToken: string;
  /** Linked Instagram Business account, if any. */
  instagram: { id: string; username: string | null } | null;
}

/** `GET /debug_token` result for a user token (M4-T7, Module 4 D8). */
export interface MetaTokenDebugInfo {
  isValid: boolean;
  /** `null` when Meta reports no expiry (`expires_at` 0 or missing). */
  expiresAt: Date | null;
  /** Permissions the token carries (may be empty for an invalid token). */
  scopes: string[];
}

export interface MetaPermissions {
  granted: string[];
  /** `declined` and `expired` permissions. */
  declined: string[];
}

/** Meta id of a reply we posted (`POST …/comments` or `…/replies` answers `{ id }`). */
export interface MetaReply {
  id: string;
}

type Query = Record<string, string>;
type HttpMethod = 'GET' | 'POST' | 'DELETE';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** Graph ids are JSON strings; numeric strings only (the DB checks the same). */
const isGraphId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,32}$/.test(value);

/**
 * FB/IG comment id: numeric, or numeric parts joined by `_` (FB `<postId>_<commentId>`); the same
 * rule as `comments.comment_id` and `moderation_actions.reply_comment_id`.
 */
const isCommentId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,32}(_[0-9]{1,32}){0,2}$/.test(value);

/**
 * FB post id (`<pageId>_<postId>`) or IG media id (numeric): the same rule as `comments.post_id`
 * (`comments_post_id_format`), so every stored post id passes.
 */
const isPostId = isCommentId;

function unexpected(what: string): MetaGraphError {
  return new MetaGraphError('unexpected_response', `Meta Graph: ${what}`, {
    status: 200,
  });
}

/** `appsecret_proof` = hex HMAC-SHA256 of the access token keyed with the app secret (D1). */
export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/**
 * The only way the backend talks to Meta (M3-T3). Plain `fetch`, pinned Graph version, typed errors.
 * Every call made with a user/Page token sends `appsecret_proof` (decision D1, "Require App Secret"
 * is on in the app). Tokens, the app secret and request URLs are never logged or put in errors.
 * e2e tests override this provider; unit tests stub `fetch`.
 */
@Injectable()
export class MetaGraphClient {
  private readonly logger = new Logger(MetaGraphClient.name);

  constructor(
    @Inject(META_APP_CONFIG) private readonly config: MetaAppConfig | null,
  ) {}

  get enabled(): boolean {
    return this.config !== null;
  }

  get graphApiVersion(): string | null {
    return this.config?.graphApiVersion ?? null;
  }

  /**
   * Facebook Login for Business dialog. Scopes come from the `config_id` configuration (D4), so no
   * `scope` param. `state` is created and checked by the caller (M3-T4).
   */
  buildLoginUrl(state: string): string {
    const config = this.requireConfig();
    if (!nonEmpty(state)) throw new Error('OAuth state must not be empty');
    const url = new URL(
      `${DIALOG_HOST}/${config.graphApiVersion}/dialog/oauth`,
    );
    url.search = new URLSearchParams({
      client_id: config.appId,
      redirect_uri: config.redirectUri,
      state,
      config_id: config.loginConfigId,
      response_type: 'code',
      override_default_response_type: 'true',
    }).toString();
    return url.toString();
  }

  /** OAuth `code` → short-lived user token (`redirect_uri` must match the dialog's). */
  async exchangeCode(code: string): Promise<MetaAccessToken> {
    const config = this.requireConfig();
    if (!nonEmpty(code)) throw new Error('OAuth code must not be empty');
    const body = await this.get(
      'oauth/access_token',
      {
        client_id: config.appId,
        redirect_uri: config.redirectUri,
        client_secret: config.appSecret,
        code,
      },
      [config.appSecret, code],
    );
    return this.parseToken(body);
  }

  /** Short-lived → long-lived (≈60-day) user token (`fb_exchange_token`, decision D4). */
  async exchangeForLongLivedToken(
    shortLivedToken: string,
  ): Promise<MetaAccessToken> {
    const config = this.requireConfig();
    if (!nonEmpty(shortLivedToken)) throw new Error('Token must not be empty');
    const body = await this.get(
      'oauth/access_token',
      {
        grant_type: 'fb_exchange_token',
        client_id: config.appId,
        client_secret: config.appSecret,
        fb_exchange_token: shortLivedToken,
      },
      [config.appSecret, shortLivedToken],
    );
    return this.parseToken(body);
  }

  /** `GET /me` (app-scoped user id + name). */
  async getMe(userToken: string): Promise<MetaUser> {
    const body = await this.getWithToken(
      'me',
      { fields: 'id,name' },
      userToken,
    );
    if (!isRecord(body) || !isGraphId(body.id))
      throw unexpected('bad /me body');
    return { id: body.id, name: nonEmpty(body.name) ? body.name : null };
  }

  /**
   * `GET /me/accounts` with every result page (cursor paging). Each Page carries its token and the
   * linked IG Business account. Throws instead of returning a partial list: page sync (M3-T5) marks
   * missing Pages inactive, so a truncated list would wrongly switch Pages off.
   */
  async getPages(userToken: string): Promise<MetaPageAccount[]> {
    const pages: MetaPageAccount[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_ACCOUNT_PAGES; page++) {
      const body = await this.getWithToken(
        'me/accounts',
        {
          fields: ACCOUNT_FIELDS,
          limit: String(ACCOUNTS_PAGE_SIZE),
          ...(after ? { after } : {}),
        },
        userToken,
      );
      if (!isRecord(body) || !Array.isArray(body.data)) {
        throw unexpected('bad /me/accounts body');
      }
      for (const item of body.data) pages.push(this.parsePage(item));
      const paging = isRecord(body.paging) ? body.paging : {};
      const cursors = isRecord(paging.cursors) ? paging.cursors : {};
      // Graph sends `next` only when another page exists; `after` alone can repeat on the last page.
      if (!nonEmpty(paging.next) || !nonEmpty(cursors.after)) return pages;
      after = cursors.after;
    }
    throw unexpected(
      `more than ${MAX_ACCOUNT_PAGES * ACCOUNTS_PAGE_SIZE} Pages`,
    );
  }

  /** `GET /me/permissions`: what the user actually granted (they can untick some). */
  async getPermissions(userToken: string): Promise<MetaPermissions> {
    const body = await this.getWithToken('me/permissions', {}, userToken);
    if (!isRecord(body) || !Array.isArray(body.data)) {
      throw unexpected('bad /me/permissions body');
    }
    const result: MetaPermissions = { granted: [], declined: [] };
    for (const item of body.data) {
      if (!isRecord(item) || !nonEmpty(item.permission)) continue;
      if (item.status === 'granted') result.granted.push(item.permission);
      else result.declined.push(item.permission);
    }
    return result;
  }

  /**
   * `GET /debug_token?input_token=<user token>` with the app access token `app_id|app_secret`
   * (M4-T7, D8). No `appsecret_proof`: the app token already carries the secret, and "Require App
   * Secret" only asks for a proof on user/Page-token calls. An invalid or expired user token is a
   * 200 with `is_valid: false` (not an error); Graph errors (e.g. a rejected app token) throw
   * `MetaGraphError` like every other call. Neither token nor secret reaches logs or errors.
   */
  async debugToken(userToken: string): Promise<MetaTokenDebugInfo> {
    const config = this.requireConfig();
    if (!nonEmpty(userToken)) throw new Error('Token must not be empty');
    const appToken = `${config.appId}|${config.appSecret}`;
    const body = await this.get(
      'debug_token',
      { input_token: userToken, access_token: appToken },
      // The app token first: it contains the secret, so scrubbing the secret first would leave the id.
      [appToken, config.appSecret, userToken],
    );
    const data = isRecord(body) && isRecord(body.data) ? body.data : null;
    if (!data || typeof data.is_valid !== 'boolean') {
      throw unexpected('bad /debug_token body');
    }
    const expiresAt =
      typeof data.expires_at === 'number' &&
      Number.isFinite(data.expires_at) &&
      data.expires_at > 0
        ? new Date(data.expires_at * 1000)
        : null;
    const scopes = Array.isArray(data.scopes)
      ? data.scopes.filter(nonEmpty)
      : [];
    return { isValid: data.is_valid, expiresAt, scopes };
  }

  /**
   * `POST /{page-id}/subscribed_apps` with the **Page** token (+ `appsecret_proof`) and
   * `subscribed_fields=feed` (M4-T8, D2/D10): installs the app on the Page so Meta sends its
   * webhooks. Idempotent on Meta's side. Anything but `{ success: true }` is `unexpected_response`.
   * Parameters go in a form body, not the URL.
   */
  async subscribePageApp(pageId: string, pageToken: string): Promise<void> {
    const body = await this.withPageToken(
      'POST',
      pageId,
      { subscribed_fields: PAGE_SUBSCRIBED_FIELDS },
      pageToken,
    );
    if (!isRecord(body) || body.success !== true) {
      throw unexpected('subscribed_apps did not answer success');
    }
  }

  /**
   * `DELETE /{page-id}/subscribed_apps` with the Page token (+ `appsecret_proof`): stops the Page's
   * webhooks for this app (M4-T8 switch-off, best effort at the caller). `{ success: true }` only.
   */
  async unsubscribePageApp(pageId: string, pageToken: string): Promise<void> {
    const body = await this.withPageToken('DELETE', pageId, {}, pageToken);
    if (!isRecord(body) || body.success !== true) {
      throw unexpected('subscribed_apps delete did not answer success');
    }
  }

  /**
   * `DELETE /me/permissions` with the **user** token (+ `appsecret_proof`): revokes every
   * permission the user granted this app, i.e. logs the app out of their Facebook account (M4-T9
   * disconnect, Module 4 D7; best effort at the caller). Meta answers `{ success: true }`; anything
   * else is `unexpected_response`. Parameters go in the query, like every DELETE.
   */
  async revokePermissions(userToken: string): Promise<void> {
    const body = await this.requestWithToken(
      'DELETE',
      'me/permissions',
      {},
      userToken,
    );
    if (!isRecord(body) || body.success !== true) {
      throw unexpected('permissions delete did not answer success');
    }
  }

  /**
   * Hides a comment from everyone but its author and the Page (M5-T9, Module 5 D3/D10/D11):
   * FB `POST /{comment-id}` form `is_hidden=true`, IG `POST /{ig-comment-id}` form `hide=true`,
   * with the **Page** token + `appsecret_proof`. Meta answers `{ success: true }` (anything else is
   * `unexpected_response`); hiding a hidden comment is fine. A comment that no longer exists is
   * `not_found`.
   */
  async hideComment(
    platform: CommentPlatform,
    commentId: string,
    pageToken: string,
  ): Promise<void> {
    await this.setCommentHidden(platform, commentId, true, pageToken);
  }

  /** The reverse of `hideComment`: form `is_hidden=false` (FB) / `hide=false` (IG). */
  async unhideComment(
    platform: CommentPlatform,
    commentId: string,
    pageToken: string,
  ): Promise<void> {
    await this.setCommentHidden(platform, commentId, false, pageToken);
  }

  /**
   * `DELETE /{comment-id}` (FB and IG) with the Page token + proof in the query (M5-T9). Meta
   * answers `{ success: true }`; an already deleted comment is `not_found` (the caller treats that
   * as done).
   */
  async deleteComment(commentId: string, pageToken: string): Promise<void> {
    const body = await this.requestWithToken(
      'DELETE',
      this.commentPath(commentId),
      {},
      pageToken,
    );
    if (!isRecord(body) || body.success !== true) {
      throw unexpected('comment delete did not answer success');
    }
  }

  /**
   * Replies to a comment as the Page (M5-T9, D6): FB `POST /{comment-id}/comments`, IG
   * `POST /{ig-comment-id}/replies`, form `message` + Page token + proof. Meta answers `{ id }` of
   * the new reply. Not idempotent on Meta's side: the caller makes sure it runs once.
   */
  async replyToComment(
    platform: CommentPlatform,
    commentId: string,
    message: string,
    pageToken: string,
  ): Promise<MetaReply> {
    if (message.trim().length === 0) {
      throw new Error('Reply message must not be empty');
    }
    const edge = platform === 'INSTAGRAM' ? 'replies' : 'comments';
    const body = await this.requestWithToken(
      'POST',
      `${this.commentPath(commentId)}/${edge}`,
      { message },
      pageToken,
    );
    if (!isRecord(body) || !isCommentId(body.id)) {
      throw unexpected(`${edge} did not answer an id`);
    }
    return { id: body.id };
  }

  /**
   * The post's text for the D8 `post_caption` context level (M5-T10): FB `GET /{post-id}`
   * `fields=message`, IG `GET /{media-id}` `fields=caption`, with the **Page** token + proof in the
   * query. Returns the text, or `null` when the post has none (field missing, `null` or blank).
   * Any other body (no object, non-string field) is `unexpected_response`. Never logged.
   */
  async getPostCaption(
    platform: CommentPlatform,
    postId: string,
    pageToken: string,
  ): Promise<string | null> {
    if (!isPostId(postId)) throw new Error('Post id must be a Graph post id');
    const field = platform === 'INSTAGRAM' ? 'caption' : 'message';
    const body = await this.requestWithToken(
      'GET',
      postId,
      { fields: field },
      pageToken,
    );
    if (!isRecord(body) || Array.isArray(body)) {
      throw unexpected(`bad post body (${field})`);
    }
    const value = body[field];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw unexpected(`post ${field} is not text`);
    }
    return value.trim().length > 0 ? value : null;
  }

  private async setCommentHidden(
    platform: CommentPlatform,
    commentId: string,
    hidden: boolean,
    pageToken: string,
  ): Promise<void> {
    const field = platform === 'INSTAGRAM' ? 'hide' : 'is_hidden';
    const body = await this.requestWithToken(
      'POST',
      this.commentPath(commentId),
      { [field]: hidden ? 'true' : 'false' },
      pageToken,
    );
    if (!isRecord(body) || body.success !== true) {
      throw unexpected(`comment ${field} did not answer success`);
    }
  }

  /** The id becomes a URL segment, so it is checked first. */
  private commentPath(commentId: string): string {
    if (!isCommentId(commentId)) {
      throw new Error('Comment id must be a Graph comment id');
    }
    return commentId;
  }

  private parseToken(body: unknown): MetaAccessToken {
    if (!isRecord(body) || !nonEmpty(body.access_token)) {
      throw unexpected('no access_token in the token response');
    }
    const expiresIn = body.expires_in;
    const expiresAt =
      typeof expiresIn === 'number' &&
      Number.isFinite(expiresIn) &&
      expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000)
        : null;
    return { accessToken: body.access_token, expiresAt };
  }

  private parsePage(item: unknown): MetaPageAccount {
    if (
      !isRecord(item) ||
      !isGraphId(item.id) ||
      typeof item.name !== 'string' ||
      !nonEmpty(item.access_token)
    ) {
      // Without `access_token` the user lacks a task on the Page; still a bad body for us.
      throw unexpected('bad Page in /me/accounts');
    }
    const ig = item.instagram_business_account;
    let instagram: MetaPageAccount['instagram'] = null;
    if (ig !== undefined && ig !== null) {
      if (!isRecord(ig) || !isGraphId(ig.id)) {
        throw unexpected('bad instagram_business_account');
      }
      instagram = {
        id: ig.id,
        username: nonEmpty(ig.username) ? ig.username : null,
      };
    }
    return {
      id: item.id,
      name: item.name,
      accessToken: item.access_token,
      instagram,
    };
  }

  private getWithToken(
    path: string,
    query: Query,
    accessToken: string,
  ): Promise<unknown> {
    return this.requestWithToken('GET', path, query, accessToken);
  }

  /** `/{page-id}/subscribed_apps` with a Page token (the id is checked: it becomes a URL segment). */
  private withPageToken(
    method: 'POST' | 'DELETE',
    pageId: string,
    params: Query,
    pageToken: string,
  ): Promise<unknown> {
    if (!isGraphId(pageId)) throw new Error('Page id must be a Graph id');
    return this.requestWithToken(
      method,
      `${pageId}/subscribed_apps`,
      params,
      pageToken,
    );
  }

  private requestWithToken(
    method: HttpMethod,
    path: string,
    params: Query,
    accessToken: string,
  ): Promise<unknown> {
    const config = this.requireConfig();
    if (!nonEmpty(accessToken)) throw new Error('Token must not be empty');
    return this.request(
      method,
      path,
      {
        ...params,
        access_token: accessToken,
        appsecret_proof: appSecretProof(accessToken, config.appSecret),
      },
      [config.appSecret, accessToken],
    );
  }

  private get(
    path: string,
    query: Query,
    secrets: readonly string[],
  ): Promise<unknown> {
    return this.request('GET', path, query, secrets);
  }

  /**
   * One Graph call. GET/DELETE send `params` in the query string, POST as a form body.
   * `secrets` are scrubbed from error messages. Logs method, path, status and time only.
   */
  private async request(
    method: HttpMethod,
    path: string,
    params: Query,
    secrets: readonly string[],
  ): Promise<unknown> {
    const config = this.requireConfig();
    const url = new URL(`${GRAPH_HOST}/${config.graphApiVersion}/${path}`);
    const encoded = new URLSearchParams(params).toString();
    const init: RequestInit = {
      method,
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    };
    if (method === 'POST') {
      init.headers = {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      };
      init.body = encoded;
    } else {
      url.search = encoded;
    }
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      // Never pass the original error on: some fetch errors include the URL (tokens in the query).
      const reason =
        error instanceof Error && error.name === 'TimeoutError'
          ? `timed out after ${DEFAULT_TIMEOUT_MS} ms`
          : 'request failed';
      throw new MetaGraphError('network', `Meta Graph /${path}: ${reason}`);
    }
    const body: unknown = await res.json().catch(() => undefined);
    this.logger.debug(
      `${method} /${path} ${res.status} ${Math.round(performance.now() - started)}ms`,
    );
    if (!res.ok) throw graphErrorFromResponse(res.status, body, secrets);
    if (body === undefined) throw unexpected(`non-JSON body from /${path}`);
    return body;
  }

  private requireConfig(): MetaAppConfig {
    if (!this.config) throw new MetaNotConfiguredError();
    return this.config;
  }
}
