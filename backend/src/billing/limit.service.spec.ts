import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import type { AccountLiveSubscription } from '../wallet/live-subscription.queries.js';
import {
  SEAT_ERROR_CODES,
  seatCheckOf,
  seatsLeftOf,
  WORKSPACE_CREATE_ERROR_CODES,
  workspaceCreateCheck,
} from './limit.service.js';

const plan = (limits: {
  workspaces?: number;
  teamSeats?: number;
}): Pick<AccountLiveSubscription, 'plan'> => ({
  plan: {
    id: '019a0000-0000-7000-8000-0000000000c1',
    slug: 'starter',
    featureConfig: normalizeFeatureConfig({
      limits: {
        connectedPages: 1,
        monthlyComments: 500,
        teamSeats: limits.teamSeats ?? 1,
        workspaces: limits.workspaces ?? 1,
      },
      features: {},
    }),
    trialCommentLimit: 300,
  },
});

describe('workspaceCreateCheck (PW-T5, PW-D10/D11)', () => {
  it('no live plan → no_active_plan (whatever the count)', () => {
    expect(workspaceCreateCheck(null, 0)).toEqual({ kind: 'no_active_plan' });
    expect(workspaceCreateCheck(null, 5)).toEqual({ kind: 'no_active_plan' });
  });

  it('under the limit → ok with limit + count', () => {
    expect(workspaceCreateCheck(plan({ workspaces: 3 }), 2)).toEqual({
      kind: 'ok',
      limit: 3,
      count: 2,
    });
    expect(workspaceCreateCheck(plan({ workspaces: 1 }), 0)).toMatchObject({
      kind: 'ok',
    });
  });

  it('at or over the limit → limit_reached with limit + count', () => {
    expect(workspaceCreateCheck(plan({ workspaces: 1 }), 1)).toEqual({
      kind: 'limit_reached',
      limit: 1,
      count: 1,
    });
    expect(workspaceCreateCheck(plan({ workspaces: 3 }), 4)).toEqual({
      kind: 'limit_reached',
      limit: 3,
      count: 4,
    });
  });

  it('a plan with 0 workspaces (or a malformed limit) refuses', () => {
    expect(workspaceCreateCheck(plan({ workspaces: 0 }), 0)).toMatchObject({
      kind: 'limit_reached',
      limit: 0,
    });
  });

  it('error codes are the plan §3.6 strings', () => {
    expect(WORKSPACE_CREATE_ERROR_CODES).toEqual({
      noActivePlan: 'no_active_plan',
      limitReached: 'workspace_limit_reached',
    });
  });
});

describe('seatsLeftOf (PW-D11, Module 7 D9)', () => {
  it('no live plan → 0', () => {
    expect(seatsLeftOf(null, 0)).toBe(0);
  });

  it('teamSeats − seats used (members incl. the owner + pending invites)', () => {
    expect(seatsLeftOf(plan({ teamSeats: 3 }), 1)).toBe(2);
    expect(seatsLeftOf(plan({ teamSeats: 3 }), 3)).toBe(0);
  });

  it('never below 0 (over the seat count after a downgrade)', () => {
    expect(seatsLeftOf(plan({ teamSeats: 1 }), 4)).toBe(0);
  });
});

describe('seatCheckOf (M7-T5, D9/D10)', () => {
  it('no live plan → no_active_plan', () => {
    expect(seatCheckOf(null, 2)).toEqual({ kind: 'no_active_plan', used: 2 });
  });

  it('Starter (1): the owner alone fills it', () => {
    expect(seatCheckOf(plan({ teamSeats: 1 }), 1)).toEqual({
      kind: 'limit_reached',
      limit: 1,
      used: 1,
    });
  });

  it('Growth (3): owner + 1 pending → ok; owner + 2 → limit_reached', () => {
    expect(seatCheckOf(plan({ teamSeats: 3 }), 2)).toEqual({
      kind: 'ok',
      limit: 3,
      used: 2,
    });
    expect(seatCheckOf(plan({ teamSeats: 3 }), 3).kind).toBe('limit_reached');
  });

  it('over the limit after a downgrade stays refused (D10)', () => {
    expect(seatCheckOf(plan({ teamSeats: 1 }), 5).kind).toBe('limit_reached');
  });

  it('codes', () => {
    expect(SEAT_ERROR_CODES).toEqual({
      noActivePlan: 'NO_ACTIVE_PLAN',
      limitReached: 'SEAT_LIMIT_REACHED',
    });
  });
});
