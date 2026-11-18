import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { AuthSession, WorkspaceContext } from '../auth/auth-session.js';
import {
  TokenCipherService,
  tokenCipherContext,
} from '../crypto/token-cipher.service.js';
import type { Database } from '../db/database.js';
import type { MetaDisconnectResponse } from './dto/workspace-pages.dto.js';
import {
  type DisconnectConnectionRow,
  type DisconnectPageRow,
  deleteWorkspaceConnection,
  deleteWorkspacePages,
  facebookUserStillConnected,
  findDisconnectConnection,
  findDisconnectPages,
  keepPageComments,
} from './meta-disconnect.queries.js';
import { MetaGraphClient } from './meta-graph.client.js';
import { MetaGraphError } from './meta-graph.errors.js';
import { findWorkspacePlanId } from './social-pages.queries.js';

/** A token decrypted before the transaction, tied to the ciphertext it came from. */
interface DecryptedToken {
  ciphertext: string;
  token: string;
}

interface DisconnectTxResult {
  connection: DisconnectConnectionRow | undefined;
  connectionDeleted: boolean;
  /** The Pages deleted in the transaction (locked rows). */
  pages: DisconnectPageRow[];
  pagesDeleted: number;
  commentsKept: number;
  /** The Facebook user still has a token-holding connection in another workspace. */
  userStillConnected: boolean;
}

function errorLabel(error: unknown): string {
  if (error instanceof MetaGraphError) {
    return `${error.kind}${error.code === undefined ? '' : ` #${error.code}`}`;
  }
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Meta disconnect (M4-T9, Module 4 D7 + decision 2026-11-19 "Keep FB user id on comments").
 *
 * 1. Read the connection + Pages (scoped) and decrypt the user + Page tokens **before** the
 *    transaction (Pages are gone after it; an undecryptable token only skips its Graph call).
 * 2. One transaction: workspace `FOR NO KEY UPDATE` (same lock as the Page toggle) → connection
 *    `FOR UPDATE` → Pages `FOR UPDATE` → stamp the Pages' comments with the connection's Facebook
 *    user id → delete the Pages (comments keep their row, `social_page_id` → null by FK; the
 *    `page_id`/`ig_business_id` claims are free) → delete the connection.
 * 3. After commit, best effort and sequential: `DELETE /{page-id}/subscribed_apps` per deleted
 *    Page, then `DELETE /me/permissions` (skipped while the same Facebook user still has another
 *    workspace connected). Failures are logged with ids + error kind and never change the response;
 *    Meta or the cipher unset → no Graph call at all.
 *
 * Idempotent: nothing to delete → `{ disconnected: false, … 0 }`.
 */
@Injectable()
export class MetaDisconnectService {
  private readonly logger = new Logger(MetaDisconnectService.name);

  constructor(
    @InjectDrizzle() private readonly db: Database,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipherService,
  ) {}

  /** Meta app + token cipher configured (else the Graph clean-up is skipped). */
  get configured(): boolean {
    return this.graph.enabled && this.cipher.isConfigured;
  }

  async disconnect(
    session: AuthSession,
    workspace: WorkspaceContext,
  ): Promise<MetaDisconnectResponse> {
    if (session.session.impersonatedBy) {
      // D7: like connect, an impersonating admin must not change the client's Facebook link.
      throw new ForbiddenException(
        'Disconnecting Meta is not allowed while impersonating',
      );
    }
    const workspaceId = workspace.id;
    const configured = this.configured;

    // 1. Decrypt before the transaction.
    const [snapshotConnection, snapshotPages] = await Promise.all([
      findDisconnectConnection(this.db, workspaceId),
      findDisconnectPages(this.db, workspaceId),
    ]);
    const userToken =
      configured && snapshotConnection
        ? this.decryptUserToken(workspaceId, snapshotConnection)
        : null;
    const pageTokens = new Map<string, DecryptedToken>();
    if (configured) {
      for (const page of snapshotPages) {
        const token = this.decryptPageToken(workspaceId, page);
        if (token) pageTokens.set(page.id, token);
      }
    }

    // 2. One transaction.
    const result = await this.deleteInTx(workspaceId);
    const disconnected = result.connectionDeleted || result.pagesDeleted > 0;
    if (disconnected) {
      this.logger.log(
        `Workspace ${workspaceId}: Meta disconnected (${result.pagesDeleted} page(s) deleted, ${result.commentsKept} comment(s) kept)`,
      );
    }

    // 3. Best-effort Graph clean-up after commit.
    if (configured) {
      await this.cleanUpOnMeta(workspaceId, result, pageTokens, userToken);
    }
    return {
      disconnected,
      pagesDeleted: result.pagesDeleted,
      commentsKept: result.commentsKept,
    };
  }

  private deleteInTx(workspaceId: string): Promise<DisconnectTxResult> {
    return this.db.transaction(async (tx) => {
      const empty: DisconnectTxResult = {
        connection: undefined,
        connectionDeleted: false,
        pages: [],
        pagesDeleted: 0,
        commentsKept: 0,
        userStillConnected: false,
      };
      // Sequential: one transaction = one pg client. Lock order = the Page toggle's.
      if (!(await findWorkspacePlanId(tx, workspaceId, true))) return empty;
      const connection = await findDisconnectConnection(tx, workspaceId, true);
      const pages = await findDisconnectPages(tx, workspaceId, true);
      const pageRowIds = pages.map((page) => page.id);
      const commentsKept = await keepPageComments(
        tx,
        workspaceId,
        pageRowIds,
        connection?.facebookUserId ?? null,
      );
      const pagesDeleted = await deleteWorkspacePages(
        tx,
        workspaceId,
        pageRowIds,
      );
      const connectionDeleted = connection
        ? await deleteWorkspaceConnection(tx, workspaceId, connection.id)
        : false;
      const userStillConnected = connection
        ? await facebookUserStillConnected(tx, connection.facebookUserId)
        : false;
      return {
        connection,
        connectionDeleted,
        pages,
        pagesDeleted,
        commentsKept,
        userStillConnected,
      };
    });
  }

  /** Never throws: every failure is logged with ids + kind only. */
  private async cleanUpOnMeta(
    workspaceId: string,
    result: DisconnectTxResult,
    pageTokens: Map<string, DecryptedToken>,
    userToken: DecryptedToken | null,
  ): Promise<void> {
    for (const page of result.pages) {
      const token = pageTokens.get(page.id);
      // No token, undecryptable, or replaced between the read and the lock (re-connect): skip.
      if (!token || token.ciphertext !== page.encryptedPageAccessToken) {
        continue;
      }
      try {
        await this.graph.unsubscribePageApp(page.pageId, token.token);
      } catch (error) {
        this.logger.warn(
          `Page ${page.id} (workspace ${workspaceId}): unsubscribe on disconnect failed (${errorLabel(error)})`,
        );
      }
    }

    const connection = result.connection;
    if (
      !result.connectionDeleted ||
      !connection ||
      !userToken ||
      userToken.ciphertext !== connection.encryptedUserAccessToken
    ) {
      return;
    }
    if (result.userStillConnected) {
      this.logger.log(
        `Workspace ${workspaceId}: Meta permissions kept (the Facebook user still has another workspace connected)`,
      );
      return;
    }
    try {
      await this.graph.revokePermissions(userToken.token);
    } catch (error) {
      this.logger.warn(
        `Workspace ${workspaceId}: Meta permissions revoke on disconnect failed (${errorLabel(error)})`,
      );
    }
  }

  private decryptUserToken(
    workspaceId: string,
    connection: DisconnectConnectionRow,
  ): DecryptedToken | null {
    const ciphertext = connection.encryptedUserAccessToken;
    if (ciphertext === null) return null;
    try {
      return {
        ciphertext,
        token: this.cipher.decrypt(
          ciphertext,
          tokenCipherContext(
            'meta_user_token',
            workspaceId,
            connection.facebookUserId,
          ),
        ),
      };
    } catch {
      this.logger.warn(
        `Connection ${connection.id} (workspace ${workspaceId}): user token cannot be decrypted; permissions revoke skipped`,
      );
      return null;
    }
  }

  private decryptPageToken(
    workspaceId: string,
    page: DisconnectPageRow,
  ): DecryptedToken | null {
    const ciphertext = page.encryptedPageAccessToken;
    if (ciphertext === null) return null;
    try {
      return {
        ciphertext,
        token: this.cipher.decrypt(
          ciphertext,
          tokenCipherContext('meta_page_token', workspaceId, page.pageId),
        ),
      };
    } catch {
      this.logger.warn(
        `Page ${page.id} (workspace ${workspaceId}): Page token cannot be decrypted; unsubscribe skipped`,
      );
      return null;
    }
  }
}
