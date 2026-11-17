import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/**
 * Marks a route (or controller) as open. No global guard is registered between SW-T2 and
 * SW-T4; the Better Auth session guard added in SW-T4 must honour this key.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
