import { APIError } from 'better-auth';
import { assertWorkspaceCreateAllowed } from './workspace-limit.js';

function thrown(fn: () => void): APIError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(APIError);
    return e as APIError;
  }
  throw new Error('expected an APIError');
}

describe('assertWorkspaceCreateAllowed (PW-T5)', () => {
  it('ok passes', () => {
    expect(() =>
      assertWorkspaceCreateAllowed({ kind: 'ok', limit: 3, count: 1 }),
    ).not.toThrow();
  });

  it('no_active_plan → 403 with code, no details', () => {
    const error = thrown(() =>
      assertWorkspaceCreateAllowed({ kind: 'no_active_plan' }),
    );
    expect(error.statusCode).toBe(403);
    expect(error.body).toMatchObject({ code: 'no_active_plan' });
    expect(error.body).not.toHaveProperty('details');
    expect(error.body?.message).toMatch(/plan/i);
  });

  it('limit_reached → 403 workspace_limit_reached + details { limit, count }', () => {
    const error = thrown(() =>
      assertWorkspaceCreateAllowed({
        kind: 'limit_reached',
        limit: 1,
        count: 1,
      }),
    );
    expect(error.statusCode).toBe(403);
    expect(error.body).toMatchObject({
      code: 'workspace_limit_reached',
      details: { limit: 1, count: 1 },
    });
    expect(error.body?.message).toMatch(/1 workspace and you have 1/);
    const plural = thrown(() =>
      assertWorkspaceCreateAllowed({
        kind: 'limit_reached',
        limit: 3,
        count: 3,
      }),
    );
    expect(plural.body?.message).toMatch(/3 workspaces/);
  });
});
