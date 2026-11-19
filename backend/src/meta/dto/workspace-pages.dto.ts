import type { MetaConnectionStatus } from '../../db/schema/index.js';

/**
 * Response shapes of the workspace pages API (M3-T6, user decisions D5/D10 2026-11-18) and of
 * Meta disconnect (M4-T9, Module 4 D7/D9). Tokens, ciphertexts and the Facebook user id are never
 * part of them; `hasToken` only says whether one is stored.
 */

/** One connected Facebook Page (+ its linked Instagram Business account, if any). */
export interface WorkspacePage {
  id: string;
  /** Facebook Page id. */
  pageId: string;
  pageName: string;
  igBusinessId: string | null;
  igUsername: string | null;
  /** Moderation on/off. */
  isActive: boolean;
  /** `false` when the Page was missing on the last re-connect: it can't be switched on until reconnected. */
  hasToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The live plan's `connectedPages` limit (no live plan = 0, PW-T5) and how many Pages are on across
 * **all** workspaces of the billing account (pooled, PW-D11; only this workspace when it has no
 * account).
 */
export interface WorkspacePageLimit {
  limit: number;
  activeCount: number;
}

/**
 * The workspace's Meta connection (M4-T9, Module 4 D9). `NEEDS_REAUTH` = Meta rejected the token:
 * webhooks are still ingested, Pages can be switched off but not on (409
 * `CONNECTION_NEEDS_REAUTH`); `REVOKED` = the user removed the app (Deauthorize): nothing is
 * ingested. Either way the UI shows Reconnect.
 */
export interface WorkspaceMetaConnection {
  status: MetaConnectionStatus;
  statusChangedAt: Date;
  /** When the long-lived user token expires; `null` = no expiry reported (or REVOKED). */
  tokenExpiresAt: Date | null;
}

/** `GET /api/workspaces/:workspaceId/pages` (sorted by `pageName`, then `pageId`). */
export interface WorkspacePagesResponse {
  items: WorkspacePage[];
  pageLimit: WorkspacePageLimit;
  /** `null` = Meta was never connected (or was disconnected). */
  connection: WorkspaceMetaConnection | null;
}

/** `PATCH …/pages/:id/toggle`: same value again = `changed: false` (no write, `updatedAt` kept). */
export interface TogglePageResponse {
  page: WorkspacePage;
  changed: boolean;
}

/** `code` of the 409s / 502 from `PATCH …/pages/:id/toggle` (error body `{ …, code, details? }`). */
export const PAGE_TOGGLE_ERROR_CODES = {
  /**
   * 409 (M4-T9, D9): switching on while the connection is not `ACTIVE` (`NEEDS_REAUTH`, `REVOKED`
   * or no connection row): reconnect Facebook first. Checked before the token and limit checks.
   */
  connectionNeedsReauth: 'CONNECTION_NEEDS_REAUTH',
  /**
   * Activating past the live plan's `connectedPages`, counted across all workspaces of the billing
   * account (PW-T5, PW-D11); `details` = `WorkspacePageLimit` (pooled).
   */
  limitReached: 'PAGE_LIMIT_REACHED',
  /**
   * 409 (PW-T5, PW-D7/D9): activating while the workspace's billing account has no live plan (no
   * account, trial or term over). Checked where the limit is; switching off always works.
   */
  noActivePlan: 'NO_ACTIVE_PLAN',
  /** Activating a Page without a stored token (missing on re-connect): reconnect Meta first. */
  tokenMissing: 'PAGE_TOKEN_MISSING',
  /** 502 (M4-T8, D10): Graph `subscribed_apps` failed on switch-on; nothing changed. */
  subscribeFailed: 'META_SUBSCRIBE_FAILED',
} as const;

/**
 * `DELETE /api/workspaces/:workspaceId/meta/connection` (M4-T9, D7). Idempotent: nothing to
 * delete → `disconnected: false` and zero counts.
 */
export interface MetaDisconnectResponse {
  /** `true` = a connection row and/or Pages were deleted. */
  disconnected: boolean;
  /** `social_pages` rows deleted (their `page_id`/`ig_business_id` are free for any workspace). */
  pagesDeleted: number;
  /** Comments of those Pages kept with no Page link (stamped for a later Data Deletion). */
  commentsKept: number;
}
