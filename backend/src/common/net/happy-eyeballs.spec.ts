import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import {
  AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  relaxHappyEyeballsTimeout,
} from './happy-eyeballs.js';

describe('relaxHappyEyeballsTimeout', () => {
  it('raises the per-address connect timeout above the 250 ms default', () => {
    const before = getDefaultAutoSelectFamilyAttemptTimeout();
    try {
      relaxHappyEyeballsTimeout();
      expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(
        AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
      );
    } finally {
      relaxHappyEyeballsTimeout(before);
    }
  });
});
