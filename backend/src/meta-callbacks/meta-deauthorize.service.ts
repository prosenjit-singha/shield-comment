import { Injectable, Logger } from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../db/database.js';
import {
  deactivateWorkspacePages,
  findConnectionsByFacebookUser,
  lockConnection,
  lockWorkspace,
  revokeConnection,
} from './meta-callbacks.queries.js';

export interface DeauthorizeResult {
  /** Connections of that Facebook user (one per workspace). */
  connections: number;
  /** Connections that actually changed (0 on a repeat). */
  revoked: number;
  /** Pages switched off / token cleared. */
  pages: number;
}

/**
 * Meta Deauthorize callback (Module 4 D6, Module 3 D8): the user removed the app. For **every**
 * connection of that Facebook user (one FB user can connect several workspaces), in one
 * transaction: lock the workspace (`FOR NO KEY UPDATE`, like the Page toggle) → lock the connection
 * (`FOR UPDATE`, re-checked against the user) → status `REVOKED` + user token cleared → all the
 * workspace's Pages off + Page tokens cleared. Idempotent: a repeat changes nothing. An unknown
 * user is not an error. The M4-T5 worker drops comments of REVOKED connections (D9).
 */
@Injectable()
export class MetaDeauthorizeService {
  private readonly logger = new Logger('MetaDeauthorize');

  constructor(@InjectDrizzle() private readonly db: Database) {}

  async deauthorize(
    facebookUserId: string,
    now = new Date(),
  ): Promise<DeauthorizeResult> {
    const result = await this.db.transaction(async (tx) => {
      const refs = await findConnectionsByFacebookUser(tx, facebookUserId);
      const counts: DeauthorizeResult = {
        connections: 0,
        revoked: 0,
        pages: 0,
      };
      // Sequential: one transaction = one pg client.
      for (const ref of refs) {
        if (!(await lockWorkspace(tx, ref.workspaceId))) continue;
        const connection = await lockConnection(
          tx,
          ref.workspaceId,
          facebookUserId,
        );
        if (!connection) continue;
        counts.connections++;
        if (await revokeConnection(tx, ref.workspaceId, connection.id, now)) {
          counts.revoked++;
        }
        counts.pages += await deactivateWorkspacePages(
          tx,
          ref.workspaceId,
          now,
        );
      }
      return counts;
    });
    // Counts only: never the user id or the signed_request.
    this.logger.log(
      `Deauthorize: ${result.connections} connection(s), ${result.revoked} revoked, ${result.pages} page(s) switched off`,
    );
    return result;
  }
}
