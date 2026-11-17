import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDrizzle } from '@nestjs/drizzle';
import type { Database } from '../../db/database.js';
import type { AuthRequest } from '../auth-session.js';
import { findPlatformUser } from '../authz-queries.js';

export const SUPER_ADMIN_ROLE = 'super_admin';

/**
 * Super-admin-only routes (`@UseGuards(SuperAdminGuard)`), cross-tenant by design.
 * - Impersonated sessions never pass (`session.impersonatedBy` set), even an admin's own.
 * - `user.role` must be `super_admin` in the session **and** in Postgres: the cookie cache can
 *   hold a stale role for 5 minutes, so a demoted or banned admin loses access immediately.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(@InjectDrizzle() private readonly db: Database) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { session } = context.switchToHttp().getRequest<AuthRequest>();
    if (!session) throw new UnauthorizedException();
    if (
      session.session.impersonatedBy ||
      session.user.role !== SUPER_ADMIN_ROLE
    ) {
      throw new ForbiddenException('Super admin only');
    }
    const current = await findPlatformUser(this.db, session.user.id);
    if (!current || current.banned || current.role !== SUPER_ADMIN_ROLE) {
      throw new ForbiddenException('Super admin only');
    }
    return true;
  }
}
