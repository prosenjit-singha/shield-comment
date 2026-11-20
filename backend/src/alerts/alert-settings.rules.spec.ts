import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  type AlertSettingsValues,
  applyAlertPatch,
  DEFAULT_ALERT_SETTINGS,
  isEmptyAlertPatch,
  resolveRecipients,
} from './alert-settings.rules.js';
import {
  type AlertRecipient,
  UpdateAlertSettingsDto,
} from './dto/alert-settings.dto.js';

const member = (n: number, role = 'moderator'): AlertRecipient => ({
  memberId: `00000000-0000-4000-8000-00000000000${n}`,
  userId: `10000000-0000-4000-8000-00000000000${n}`,
  name: `M${n}`,
  email: `m${n}@example.com`,
  role,
});
const OWNER = member(1, 'owner');
const ADMIN = member(2, 'admin');
const MOD = member(3);
const MEMBERS = [OWNER, ADMIN, MOD];
const defaults = (): AlertSettingsValues => ({ ...DEFAULT_ALERT_SETTINGS });

function codeOf(fn: () => unknown): { status: number; code: unknown } {
  try {
    fn();
  } catch (e) {
    if (e instanceof BadRequestException || e instanceof ConflictException) {
      const body = e.getResponse() as { code?: unknown };
      return { status: e.getStatus(), code: body.code };
    }
    throw e;
  }
  throw new Error('expected a throw');
}

describe('alert settings rules (M7-T7)', () => {
  it('defaults: alerts off, threshold 10, recipients = owner (D14/D15, reading 7)', () => {
    expect(DEFAULT_ALERT_SETTINGS).toEqual({
      spikeThreshold: 10,
      emailEnabled: false,
      emailRecipientMemberIds: null,
      telegramEnabled: false,
    });
    expect(resolveRecipients(null, MEMBERS)).toEqual([OWNER]);
  });

  it('resolveRecipients keeps member order and drops removed members', () => {
    const gone = '99999999-0000-4000-8000-000000000000';
    expect(
      resolveRecipients([MOD.memberId, gone, OWNER.memberId], MEMBERS),
    ).toEqual([OWNER, MOD]);
    expect(resolveRecipients([], MEMBERS)).toEqual([]);
  });

  it('isEmptyAlertPatch', () => {
    expect(isEmptyAlertPatch({})).toBe(true);
    expect(isEmptyAlertPatch({ spikeThreshold: undefined })).toBe(true);
    expect(isEmptyAlertPatch({ emailEnabled: false })).toBe(false);
  });

  it('merges a patch and keeps unsent fields', () => {
    const next = applyAlertPatch(
      defaults(),
      { spikeThreshold: 25, emailEnabled: true },
      MEMBERS,
      false,
    );
    expect(next).toEqual({
      spikeThreshold: 25,
      emailEnabled: true,
      emailRecipientMemberIds: null,
      telegramEnabled: false,
    });
  });

  it('threshold 1–1,000 else 400 ALERT_THRESHOLD_INVALID', () => {
    for (const t of [1, 1000])
      expect(
        applyAlertPatch(defaults(), { spikeThreshold: t }, MEMBERS, false)
          .spikeThreshold,
      ).toBe(t);
    for (const t of [0, -5, 1001])
      expect(
        codeOf(() =>
          applyAlertPatch(defaults(), { spikeThreshold: t }, MEMBERS, false),
        ),
      ).toEqual({ status: 400, code: 'ALERT_THRESHOLD_INVALID' });
  });

  it('recipients: de-duplicated (case-insensitive), members only, at most 10', () => {
    const next = applyAlertPatch(
      defaults(),
      {
        emailRecipientMemberIds: [
          MOD.memberId,
          MOD.memberId.toUpperCase(),
          ADMIN.memberId,
        ],
      },
      MEMBERS,
      false,
    );
    expect(next.emailRecipientMemberIds).toEqual([
      MOD.memberId,
      ADMIN.memberId,
    ]);
    expect(
      codeOf(() =>
        applyAlertPatch(
          defaults(),
          { emailRecipientMemberIds: ['99999999-0000-4000-8000-000000000000'] },
          MEMBERS,
          false,
        ),
      ),
    ).toEqual({ status: 400, code: 'ALERT_RECIPIENT_NOT_MEMBER' });
    const many = Array.from({ length: 11 }, () => randomUUID());
    const manyMembers = many.map((memberId) => ({ ...MOD, memberId }));
    expect(
      codeOf(() =>
        applyAlertPatch(
          defaults(),
          { emailRecipientMemberIds: many },
          manyMembers,
          false,
        ),
      ),
    ).toEqual({ status: 400, code: 'ALERT_RECIPIENTS_LIMIT' });
  });

  it('email on needs a recipient that still exists (400 ALERT_RECIPIENTS_REQUIRED)', () => {
    expect(
      codeOf(() =>
        applyAlertPatch(
          defaults(),
          { emailEnabled: true, emailRecipientMemberIds: [] },
          MEMBERS,
          false,
        ),
      ),
    ).toEqual({ status: 400, code: 'ALERT_RECIPIENTS_REQUIRED' });
    const stale = { ...defaults(), emailRecipientMemberIds: [MOD.memberId] };
    expect(
      codeOf(() =>
        applyAlertPatch(stale, { emailEnabled: true }, [OWNER], false),
      ),
    ).toEqual({ status: 400, code: 'ALERT_RECIPIENTS_REQUIRED' });
    // Email off with no recipients is fine.
    expect(
      applyAlertPatch(
        defaults(),
        { emailRecipientMemberIds: [] },
        MEMBERS,
        false,
      ).emailRecipientMemberIds,
    ).toEqual([]);
  });

  it('plan gating (D12): Telegram on needs messengerAlerts; off and saved values are never gated', () => {
    expect(
      codeOf(() =>
        applyAlertPatch(defaults(), { telegramEnabled: true }, MEMBERS, false),
      ),
    ).toEqual({ status: 409, code: 'PLAN_FEATURE_UNAVAILABLE' });
    expect(
      applyAlertPatch(defaults(), { telegramEnabled: true }, MEMBERS, true)
        .telegramEnabled,
    ).toBe(true);
    const saved = { ...defaults(), telegramEnabled: true };
    // Plan dropped: other edits keep the saved switch (reading 11), switching off works.
    expect(
      applyAlertPatch(saved, { spikeThreshold: 3 }, MEMBERS, false)
        .telegramEnabled,
    ).toBe(true);
    expect(
      applyAlertPatch(saved, { telegramEnabled: false }, MEMBERS, false)
        .telegramEnabled,
    ).toBe(false);
  });

  it('DTO: types are checked, numeric strings become numbers', async () => {
    const ok = plainToInstance(UpdateAlertSettingsDto, {
      spikeThreshold: '12',
      emailRecipientMemberIds: [OWNER.memberId],
    });
    expect(await validate(ok)).toEqual([]);
    expect(ok.spikeThreshold).toBe(12);
    for (const bad of [
      { spikeThreshold: 1.5 },
      { spikeThreshold: 'ten' },
      { emailEnabled: 'yes' },
      { emailRecipientMemberIds: ['not-a-uuid'] },
      { emailRecipientMemberIds: OWNER.memberId },
      { telegramEnabled: 1 },
    ]) {
      const errors = await validate(
        plainToInstance(UpdateAlertSettingsDto, bad),
      );
      expect(errors.length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});
