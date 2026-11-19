import { normalizeFeatureConfig } from '../admin/plan-rules.js';
import { PLAN_LIMIT_KEYS, WALLET_METER_PATTERN } from '../db/schema/index.js';
import {
  isWalletMeter,
  meterGrant,
  WALLET_METER_KEYS,
  WALLET_METERS,
} from './wallet-meters.js';

const config = (monthlyComments: number) =>
  normalizeFeatureConfig({
    limits: { connectedPages: 1, monthlyComments, teamSeats: 1, workspaces: 1 },
  });

describe('WALLET_METERS registry (PW-D3)', () => {
  it('has monthlyComments granted from the plan limit of the same name', () => {
    expect(WALLET_METER_KEYS).toEqual(['monthlyComments']);
    expect(WALLET_METERS.monthlyComments.planLimit).toBe('monthlyComments');
  });

  it('every key matches the SQL meter format and maps to a plan limit key', () => {
    const pattern = new RegExp(WALLET_METER_PATTERN);
    for (const key of WALLET_METER_KEYS) {
      expect(key).toMatch(pattern);
      expect(PLAN_LIMIT_KEYS).toContain(WALLET_METERS[key].planLimit);
    }
  });

  it('isWalletMeter accepts registered keys only', () => {
    expect(isWalletMeter('monthlyComments')).toBe(true);
    expect(isWalletMeter('teamSeats')).toBe(false);
    expect(isWalletMeter('toString')).toBe(false);
    expect(isWalletMeter(1)).toBe(false);
  });
});

describe('meterGrant', () => {
  it('a paid period grants the plan limit (trial column ignored)', () => {
    expect(
      meterGrant(
        'monthlyComments',
        { featureConfig: config(5000), trialCommentLimit: 300 },
        false,
      ),
    ).toBe(5000);
  });

  it('a trial period grants trial_comment_limit (PW-D12), 0 included', () => {
    expect(
      meterGrant(
        'monthlyComments',
        { featureConfig: config(5000), trialCommentLimit: 300 },
        true,
      ),
    ).toBe(300);
    expect(
      meterGrant(
        'monthlyComments',
        { featureConfig: config(5000), trialCommentLimit: 0 },
        true,
      ),
    ).toBe(0);
  });

  it('a trial with trial_comment_limit null falls back to the plan limit', () => {
    expect(
      meterGrant(
        'monthlyComments',
        { featureConfig: config(5000), trialCommentLimit: null },
        true,
      ),
    ).toBe(5000);
  });

  it('a plan without the key (normalised) grants 0', () => {
    expect(
      meterGrant(
        'monthlyComments',
        { featureConfig: normalizeFeatureConfig({}), trialCommentLimit: null },
        false,
      ),
    ).toBe(0);
  });
});
