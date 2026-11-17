import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

/**
 * Per-address connect timeout for Node's happy-eyeballs (`autoSelectFamily`).
 * Node's default is 250 ms. A slow TCP connect (Bangladesh to Neon `us-east-2` took ~350 ms
 * before the project moved to `ap-southeast-1`) makes every address "time out", and `pg` fails
 * with `AggregateError [ETIMEDOUT]` although the host is reachable. 1 s still falls through
 * dead addresses quickly.
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1000;

/** Call once at process start, before the first outbound connection. */
export function relaxHappyEyeballsTimeout(
  ms = AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
): void {
  setDefaultAutoSelectFamilyAttemptTimeout(ms);
}
