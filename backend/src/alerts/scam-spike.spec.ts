import {
  EmailNotConfiguredError,
  EmailSendError,
} from '../email/email.service.js';
import {
  ALERT_COOLDOWN_SECONDS,
  alertCooldownKey,
  alertEmail,
  alertTelegramText,
  channelOutcomes,
  parseScamSpikeJob,
  SCAM_WINDOW_MS,
  scamSpikeJobId,
  sendFailure,
  spikeReached,
  TEST_ALERTS_PER_HOUR,
  testAlertRateKey,
} from './scam-spike.js';
import { TelegramSendError } from './telegram.client.js';

const WS = '0190f000-0000-7000-8000-000000000001';
const APP = 'https://app.shield.test';
// 2026-11-20 08:05 UTC = 14:05 in Dhaka.
const AT = new Date('2026-11-20T08:05:30.000Z');
const COPY = {
  workspaceName: 'Rahim Fashion',
  scamCount: 12,
  threshold: 10,
  at: AT,
};

describe('scam spike rules (D14)', () => {
  it('rolling 60-minute window, 60-minute cool-down, 5 test alerts per hour', () => {
    expect(SCAM_WINDOW_MS).toBe(3_600_000);
    expect(ALERT_COOLDOWN_SECONDS).toBe(3600);
    expect(TEST_ALERTS_PER_HOUR).toBe(5);
    expect(alertCooldownKey(WS)).toBe(`alerts:cooldown:${WS}`);
    expect(testAlertRateKey(WS)).toBe(`alerts:test:${WS}`);
  });

  it('alerts when the count reaches the threshold', () => {
    expect(spikeReached(9, 10)).toBe(false);
    expect(spikeReached(10, 10)).toBe(true);
    expect(spikeReached(11, 10)).toBe(true);
    expect(spikeReached(1, 1)).toBe(true);
  });

  it('job id: 3 parts per workspace + hour bucket; a cool-down later is always a new id', () => {
    const id = scamSpikeJobId(WS, AT);
    expect(id.split(':')).toEqual([
      'scam-spike',
      WS,
      String(Math.floor(AT.getTime() / 3_600_000)),
    ]);
    expect(scamSpikeJobId(WS, new Date(AT.getTime() + 60_000))).toBe(id);
    expect(
      scamSpikeJobId(
        WS,
        new Date(AT.getTime() + ALERT_COOLDOWN_SECONDS * 1000),
      ),
    ).not.toBe(id);
  });

  it('parses job data; anything off → null', () => {
    const data = {
      workspaceId: WS,
      scamCount: 12,
      threshold: 10,
      detectedAt: AT.toISOString(),
    };
    expect(parseScamSpikeJob(data)).toEqual({ ...data, sent: [] });
    expect(parseScamSpikeJob({ ...data, sent: ['email:x'] })?.sent).toEqual([
      'email:x',
    ]);
    for (const bad of [
      null,
      'x',
      { ...data, workspaceId: 'nope' },
      { ...data, scamCount: -1 },
      { ...data, scamCount: 1.5 },
      { ...data, threshold: 0 },
      { ...data, detectedAt: 'yesterday' },
      { ...data, sent: [1] },
    ])
      expect(parseScamSpikeJob(bad)).toBeNull();
  });
});

describe('send failure kinds (alert_deliveries.error_kind)', () => {
  it('Telegram keeps its kind and retryable flag', () => {
    expect(sendFailure(new TelegramSendError('chat_unavailable', 403))).toEqual(
      { kind: 'chat_unavailable', retryable: false },
    );
    expect(sendFailure(new TelegramSendError('rate_limited', 429))).toEqual({
      kind: 'rate_limited',
      retryable: true,
    });
  });

  it('email errors map to the same words', () => {
    expect(sendFailure(new EmailNotConfiguredError())).toEqual({
      kind: 'not_configured',
      retryable: false,
    });
    expect(sendFailure(new EmailSendError('x', null, true))).toEqual({
      kind: 'network',
      retryable: true,
    });
    expect(sendFailure(new EmailSendError('x', 429, true))).toEqual({
      kind: 'rate_limited',
      retryable: true,
    });
    expect(sendFailure(new EmailSendError('x', 503, true))).toEqual({
      kind: 'server_error',
      retryable: true,
    });
    expect(sendFailure(new EmailSendError('x', 422, false))).toEqual({
      kind: 'rejected',
      retryable: false,
    });
    expect(sendFailure(new Error('boom'))).toEqual({
      kind: 'unknown',
      retryable: true,
    });
  });
});

describe('channelOutcomes', () => {
  const ok = (key: string, channel: 'EMAIL' | 'TELEGRAM') =>
    ({ key, channel, ok: true }) as const;
  const fail = (
    key: string,
    channel: 'EMAIL' | 'TELEGRAM',
    kind: string,
    retryable: boolean,
  ) => ({ key, channel, ok: false, kind, retryable }) as const;

  it('one row per channel: SENT when every target got it, FAILED with the first kind', () => {
    expect(
      channelOutcomes(
        [
          ok('email:a', 'EMAIL'),
          ok('email:b', 'EMAIL'),
          ok('telegram:1', 'TELEGRAM'),
          fail('telegram:2', 'TELEGRAM', 'chat_unavailable', false),
        ],
        false,
      ),
    ).toEqual({
      pending: false,
      outcomes: [
        { channel: 'EMAIL', status: 'SENT', errorKind: null },
        {
          channel: 'TELEGRAM',
          status: 'FAILED',
          errorKind: 'chat_unavailable',
        },
      ],
    });
    expect(channelOutcomes([], false)).toEqual({
      pending: false,
      outcomes: [],
    });
  });

  it('a retryable failure is pending until the last attempt', () => {
    const results = [
      ok('email:a', 'EMAIL'),
      fail('telegram:1', 'TELEGRAM', 'server_error', true),
    ];
    expect(channelOutcomes(results, false).pending).toBe(true);
    expect(channelOutcomes(results, true)).toEqual({
      pending: false,
      outcomes: [
        { channel: 'EMAIL', status: 'SENT', errorKind: null },
        { channel: 'TELEGRAM', status: 'FAILED', errorKind: 'server_error' },
      ],
    });
  });
});

describe('alert copy (reading 10: en then bn, no comment text, Dhaka time)', () => {
  it('spike email: counts, threshold, Dhaka time, dashboard link, English before Bangla', () => {
    const email = alertEmail('spike', COPY, APP);
    expect(email.subject).toBe(
      'Scam spike: 12 scam comments in the last hour · স্ক্যাম বেড়েছে: গত এক ঘণ্টায় 12টি স্ক্যাম কমেন্ট',
    );
    expect(email.text).toContain(
      '12 scam comments arrived on "Rahim Fashion" in the last 60 minutes (your alert threshold is 10).',
    );
    expect(email.text).toContain('2026-11-20 14:05 (Dhaka time)');
    expect(email.text).toContain('2026-11-20 14:05 (ঢাকা সময়)');
    expect(email.text).toContain(`Open dashboard: ${APP}/dashboard`);
    expect(email.text).toContain(`ড্যাশবোর্ড খুলুন: ${APP}/dashboard`);
    expect(email.text.indexOf('Scam spike')).toBeLessThan(
      email.text.indexOf('স্ক্যাম বেড়েছে'),
    );
    expect(email.html).toContain('lang="bn"');
  });

  it('test email: says it is a test and links to the alert settings', () => {
    const email = alertEmail('test', COPY, `${APP}/`);
    expect(email.subject).toBe(
      'Test alert from ShieldComment · ShieldComment থেকে পরীক্ষামূলক অ্যালার্ট',
    );
    expect(email.text).toContain('This is a test alert for "Rahim Fashion".');
    expect(email.text).toContain('পরীক্ষামূলক অ্যালার্ট');
    expect(email.text).toContain(`${APP}/settings/alerts`);
  });

  it('Telegram text: plain, English then Bangla, then the link', () => {
    const text = alertTelegramText('spike', COPY, APP);
    const lines = text.split('\n');
    expect(lines[0]).toBe('⚠️ Scam spike: 12 scam comments in the last hour');
    expect(text.indexOf('⚠️ স্ক্যাম বেড়েছে')).toBeGreaterThan(
      text.indexOf('You get at most one alert per hour.'),
    );
    expect(lines.at(-1)).toBe(`${APP}/dashboard`);
    expect(alertTelegramText('test', COPY, APP)).toContain(
      `${APP}/settings/alerts`,
    );
  });

  it('escapes the workspace name in HTML', () => {
    const email = alertEmail(
      'spike',
      { ...COPY, workspaceName: '<b>Shop</b>' },
      APP,
    );
    expect(email.html).not.toContain('<b>Shop</b>');
    expect(email.html).toContain('&lt;b&gt;Shop&lt;/b&gt;');
  });
});
