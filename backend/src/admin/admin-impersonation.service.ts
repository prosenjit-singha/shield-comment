import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { EnvironmentVariables } from '../config/env.validation.js';
import type { Database } from '../db/database.js';
import {
  recordImpersonationToken,
  resolveImpersonationTarget,
} from '../impersonation/impersonation-queries.js';
import {
  generateImpersonationToken,
  impersonationRedirectUrl,
} from '../impersonation/impersonation-token.js';

export const DEFAULT_CLIENT_APP_URL = 'http://app.localhost:5174';

/**
 * Issues 1-click impersonation tokens (M1-T3). Only the token's sha256 goes to
 * `impersonation_audit_logs`; the plain token is returned once, inside `redirectUrl`.
 */
@Injectable()
export class AdminImpersonationService {
  private readonly clientOrigin: string;

  constructor(
    @InjectDrizzle() private readonly db: Database,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.clientOrigin =
      config.get('CLIENT_APP_URL', { infer: true }) ?? DEFAULT_CLIENT_APP_URL;
  }

  /**
   * 404 unknown/malformed workspace · 409 suspended or no unbanned owner (no token, no audit row)
   * · otherwise `{ token, redirectUrl }`, valid for 60 s, single use.
   */
  async issue(workspaceId: string, adminId: string, ipAddress: string | null) {
    const now = new Date();
    const target = await resolveImpersonationTarget(this.db, workspaceId, now);
    if (!target.ok) {
      if (target.reason === 'not_found')
        throw new NotFoundException('Workspace not found');
      throw new ConflictException(
        target.reason === 'suspended'
          ? 'Workspace is suspended'
          : 'Workspace has no owner that can be impersonated',
      );
    }
    const token = generateImpersonationToken();
    await recordImpersonationToken(this.db, {
      token,
      adminId,
      workspaceId: target.workspaceId,
      ipAddress,
      now,
    });
    return {
      token,
      redirectUrl: impersonationRedirectUrl(this.clientOrigin, token),
    };
  }
}

/** Caller IP for the audit row: the resolved client IP, same as Better Auth's (M9-T1). */
export { clientIp as requestIp } from '../common/http/client-ip.js';
