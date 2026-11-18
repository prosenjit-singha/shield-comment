import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
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

export interface MetaPermissions {
  granted: string[];
  /** `declined` and `expired` permissions. */
  declined: string[];
}

type Query = Record<string, string>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

/** Graph ids are JSON strings; numeric strings only (the DB checks the same). */
const isGraphId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9]{1,32}$/.test(value);

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
    const config = this.requireConfig();
    if (!nonEmpty(accessToken)) throw new Error('Token must not be empty');
    return this.get(
      path,
      {
        ...query,
        access_token: accessToken,
        appsecret_proof: appSecretProof(accessToken, config.appSecret),
      },
      [config.appSecret, accessToken],
    );
  }

  /** One GET. `secrets` are scrubbed from error messages. Logs path, status and time only. */
  private async get(
    path: string,
    query: Query,
    secrets: readonly string[],
  ): Promise<unknown> {
    const config = this.requireConfig();
    const url = new URL(`${GRAPH_HOST}/${config.graphApiVersion}/${path}`);
    url.search = new URLSearchParams(query).toString();
    const started = performance.now();
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
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
      `GET /${path} ${res.status} ${Math.round(performance.now() - started)}ms`,
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
