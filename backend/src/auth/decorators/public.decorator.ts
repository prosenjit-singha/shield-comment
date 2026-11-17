/**
 * Marks a route (or controller) as open: the global Better Auth `AuthGuard` skips the session
 * check (it still attaches `request.session` when a cookie is present). This is the
 * integration's `@AllowAnonymous()` (metadata key `PUBLIC`), re-exported under our name.
 */
export { AllowAnonymous as Public } from '@thallesp/nestjs-better-auth';
