import { META_LOGIN_SCOPES } from '../meta/meta-graph.config.js';
import type { MetaGraphErrorKind } from '../meta/meta-graph.errors.js';
import {
  decideTokenStatus,
  missingLoginScopes,
  sameInstant,
} from './meta-token-check.rules.js';

const ALL = [...META_LOGIN_SCOPES];
const EXPIRES = new Date('2027-01-15T00:00:00.000Z');
const result = (isValid: boolean, scopes: string[], expiresAt = EXPIRES) =>
  ({ kind: 'result', info: { isValid, scopes, expiresAt } }) as const;
const graphError = (error: MetaGraphErrorKind) =>
  ({ kind: 'error', error }) as const;

describe('decideTokenStatus (D8 mapping table)', () => {
  it.each([
    [
      'valid + every D4 scope',
      result(true, ALL),
      { action: 'set', status: 'ACTIVE', reason: 'valid', missingScopes: [] },
    ],
    [
      'valid + extra scopes',
      result(true, [...ALL, 'email']),
      { action: 'set', status: 'ACTIVE', reason: 'valid' },
    ],
    [
      'valid, no expiry',
      result(true, ALL, null as unknown as Date),
      { action: 'set', status: 'ACTIVE', tokenExpiresAt: null },
    ],
    [
      'valid but instagram_manage_comments missing',
      result(
        true,
        ALL.filter((s) => s !== 'instagram_manage_comments'),
      ),
      {
        action: 'set',
        status: 'NEEDS_REAUTH',
        reason: 'missing_scope',
        missingScopes: ['instagram_manage_comments'],
        tokenExpiresAt: EXPIRES,
      },
    ],
    [
      'valid, no scopes at all',
      result(true, []),
      {
        action: 'set',
        status: 'NEEDS_REAUTH',
        reason: 'missing_scope',
        missingScopes: ALL,
      },
    ],
    [
      'is_valid false',
      result(false, ALL),
      {
        action: 'set',
        status: 'NEEDS_REAUTH',
        reason: 'invalid',
        missingScopes: [],
      },
    ],
    [
      'Graph token_invalid',
      graphError('token_invalid'),
      {
        action: 'set',
        status: 'NEEDS_REAUTH',
        reason: 'graph_token_invalid',
      },
    ],
    [
      'rate_limited',
      graphError('rate_limited'),
      { action: 'leave', reason: 'rate_limited', stop: true },
    ],
    ...(
      [
        'transient',
        'network',
        'permission',
        'invalid_request',
        'unexpected_response',
        'unknown',
      ] as const
    ).map(
      (kind) =>
        [
          kind,
          graphError(kind),
          { action: 'leave', reason: 'graph_error', stop: false },
        ] as const,
    ),
  ] as const)('%s', (_label, outcome, expected) => {
    expect(decideTokenStatus(outcome)).toMatchObject(expected);
  });

  it('keeps the stored expiry (no tokenExpiresAt) for invalid tokens and Graph errors', () => {
    expect(decideTokenStatus(result(false, ALL))).not.toHaveProperty(
      'tokenExpiresAt',
    );
    expect(decideTokenStatus(graphError('token_invalid'))).not.toHaveProperty(
      'tokenExpiresAt',
    );
  });

  it('never decides REVOKED', () => {
    const outcomes = [
      result(true, ALL),
      result(false, []),
      graphError('token_invalid'),
    ];
    for (const outcome of outcomes) {
      const verdict = decideTokenStatus(outcome);
      expect(verdict.action === 'set' && verdict.status).not.toBe('REVOKED');
    }
  });
});

describe('missingLoginScopes', () => {
  it('lists missing D4 scopes in order', () => {
    expect(missingLoginScopes(['pages_show_list'])).toEqual(ALL.slice(1));
    expect(missingLoginScopes(ALL)).toEqual([]);
  });
});

describe('sameInstant', () => {
  it.each([
    [null, null, true],
    [EXPIRES, null, false],
    [null, EXPIRES, false],
    [EXPIRES, new Date(EXPIRES.getTime()), true],
    [EXPIRES, new Date(EXPIRES.getTime() + 1), false],
  ])('%s vs %s → %s', (a, b, same) => {
    expect(sameInstant(a, b)).toBe(same);
  });
});
