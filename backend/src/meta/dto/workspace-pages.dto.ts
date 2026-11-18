/**
 * Response shapes of the workspace pages API (M3-T6, user decisions D5/D10 2026-11-18).
 * Tokens and ciphertexts are never part of them; `hasToken` only says whether one is stored.
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

/** The workspace's `connectedPages` plan limit (no plan = the Free plan) and how many Pages are on. */
export interface WorkspacePageLimit {
  limit: number;
  activeCount: number;
}

/** `GET /api/workspaces/:workspaceId/pages` (sorted by `pageName`, then `pageId`). */
export interface WorkspacePagesResponse {
  items: WorkspacePage[];
  pageLimit: WorkspacePageLimit;
}

/** `PATCH …/pages/:id/toggle`: same value again = `changed: false` (no write, `updatedAt` kept). */
export interface TogglePageResponse {
  page: WorkspacePage;
  changed: boolean;
}

/** `code` of the 409s from `PATCH …/pages/:id/toggle` (error body `{ …, code, details? }`). */
export const PAGE_TOGGLE_ERROR_CODES = {
  /** Activating past the plan's `connectedPages`; `details` = `WorkspacePageLimit`. */
  limitReached: 'PAGE_LIMIT_REACHED',
  /** Activating a Page without a stored token (missing on re-connect): reconnect Meta first. */
  tokenMissing: 'PAGE_TOKEN_MISSING',
} as const;
