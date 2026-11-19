import { APIError } from 'better-auth';
import {
  WORKSPACE_CREATE_ERROR_CODES,
  type WorkspaceCreateCheck,
} from '../billing/limit.service.js';

/**
 * The `/organization/create` before-hook's answer (PW-T5, plan §3.6): `ok` passes; otherwise a
 * Better Auth 403 whose JSON body is `{ message, code, details? }`:
 * - `no_active_plan`: the creator's billing account has no live plan;
 * - `workspace_limit_reached` + `details { limit, count }`: the account has `limits.workspaces`.
 */
export function assertWorkspaceCreateAllowed(
  check: WorkspaceCreateCheck,
): void {
  if (check.kind === 'ok') return;
  if (check.kind === 'no_active_plan') {
    throw new APIError('FORBIDDEN', {
      message:
        'Your plan has ended, so you can’t create a workspace. Choose a plan first.',
      code: WORKSPACE_CREATE_ERROR_CODES.noActivePlan,
    });
  }
  throw new APIError('FORBIDDEN', {
    message: `Your plan allows ${check.limit} workspace${check.limit === 1 ? '' : 's'} and you have ${check.count}. Upgrade your plan to add another.`,
    code: WORKSPACE_CREATE_ERROR_CODES.limitReached,
    details: { limit: check.limit, count: check.count },
  });
}
