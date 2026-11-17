import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthenticatedRequest } from '../auth.types.js';

/**
 * Super-admin-only routes (`@UseGuards(SuperAdminGuard)`). Stricter than `@Roles`:
 * - impersonation tokens never pass, even though they are signed by us;
 * - the role is re-read from the database, so a demoted admin loses access immediately.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!user || user.impersonatedBy || user.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super admin only');
    }
    const current = await this.prisma.user.findUnique({
      where: { id: user.sub },
      select: { role: true },
    });
    if (current?.role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Super admin only');
    }
    return true;
  }
}
