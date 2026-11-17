import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '../../generated/prisma/client.js';

export const ROLES_KEY = 'auth:roles';

/** Restricts a route to these platform roles (checked by the global `RolesGuard`). */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
