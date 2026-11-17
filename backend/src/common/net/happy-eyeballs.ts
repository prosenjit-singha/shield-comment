import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';

/**
 * Per-address connect timeout for Node's happy-eyeballs (`autoSelectFamily`).
 * Node's default is 250 ms, but a TCP connect from Bangladesh to Neon `us-east-2` takes
 * ~350 ms, so every address "times out" and `pg` fails with `AggregateError [ETIMEDOUT]`
 * although the host is reachable. 1 s still falls through dead addresses quickly.
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1000;

/** Call once at process start, before the first outbound connection. */
export function relaxHappyEyeballsTimeout(
  ms = AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
): void {
  setDefaultAutoSelectFamilyAttemptTimeout(ms);
}
