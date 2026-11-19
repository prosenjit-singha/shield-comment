import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { UpdateModerationPolicyDto } from './dto/moderation-policy.dto.js';
import {
  applyPolicyPatch,
  assertPolicyPatchAllowed,
  isEmptyPolicyPatch,
  policyColumns,
  samePolicy,
} from './moderation-policy.rules.js';
import { defaultModerationPolicy } from './moderation.queries.js';

const WS = '019a0000-0000-7000-8000-000000000001';

/** Same options as the global ValidationPipe (src/app.setup.ts). */
async function check(plain: Record<string, unknown>) {
  const dto = plainToInstance(UpdateModerationPolicyDto, plain);
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: false,
  });
  return { dto, fields: errors.flatMap((e) => paths(e)) };
}

function paths(error: ValidationError, prefix = ''): string[] {
  const path = prefix ? `${prefix}.${error.property}` : error.property;
  const own = error.constraints ? [path] : [];
  return [...own, ...(error.children ?? []).flatMap((c) => paths(c, path))];
}

const EN = 'Thanks! Please message our Page.';
const BN = 'ধন্যবাদ! আমাদের পেজে মেসেজ দিন।';

describe('UpdateModerationPolicyDto', () => {
  it('accepts a full valid body and trims texts', async () => {
    const { dto, fields } = await check({
      mode: 'REVIEW',
      confidenceThreshold: 0.875,
      aiContextLevel: 'post_caption',
      categories: {
        SAFE_INQUIRY: {
          action: 'NONE',
          autoReply: true,
          replyEn: `  ${EN}  `,
          replyBn: `\n${BN}\t`,
        },
        SCAM_PHISHING: { action: 'DELETE' },
      },
    });
    expect(fields).toEqual([]);
    expect(dto.categories?.SAFE_INQUIRY?.replyEn).toBe(EN);
    expect(dto.categories?.SAFE_INQUIRY?.replyBn).toBe(BN);
  });

  it('accepts an empty body (the service answers 400 "nothing to update")', async () => {
    expect((await check({})).fields).toEqual([]);
  });

  it.each([
    [{ mode: 'auto' }, 'mode'],
    [{ mode: null }, 'mode'],
    [{ confidenceThreshold: 0.49 }, 'confidenceThreshold'],
    [{ confidenceThreshold: 1.01 }, 'confidenceThreshold'],
    [{ confidenceThreshold: 0.8125 }, 'confidenceThreshold'],
    [{ confidenceThreshold: '0.9' }, 'confidenceThreshold'],
    [{ confidenceThreshold: null }, 'confidenceThreshold'],
    [{ aiContextLevel: 'everything' }, 'aiContextLevel'],
    [{ categories: [] }, 'categories'],
    [{ categories: { UNKNOWN: { action: 'HIDE' } } }, 'categories.UNKNOWN'],
    [{ categories: { SCAM_PHISHING: null } }, 'categories.SCAM_PHISHING'],
    [
      { categories: { SCAM_PHISHING: { action: 'BAN' } } },
      'categories.SCAM_PHISHING.action',
    ],
    [
      { categories: { SCAM_PHISHING: { autoReply: 'true' } } },
      'categories.SCAM_PHISHING.autoReply',
    ],
    [
      { categories: { SCAM_PHISHING: { replyEn: '   ' } } },
      'categories.SCAM_PHISHING.replyEn',
    ],
    [
      { categories: { SCAM_PHISHING: { replyBn: 'x'.repeat(501) } } },
      'categories.SCAM_PHISHING.replyBn',
    ],
    [
      { categories: { SCAM_PHISHING: { replyBn: 5 } } },
      'categories.SCAM_PHISHING.replyBn',
    ],
    [
      { categories: { SCAM_PHISHING: { extra: 1 } } },
      'categories.SCAM_PHISHING.extra',
    ],
    [{ workspaceId: WS }, 'workspaceId'],
    [{ updatedAt: '2026-11-19' }, 'updatedAt'],
  ])('%j → 400 on %s', async (body, field) => {
    expect((await check(body)).fields).toContain(field);
  });

  it('accepts the range ends, 500-char texts and null texts', async () => {
    for (const confidenceThreshold of [0.5, 1, 0.8]) {
      expect((await check({ confidenceThreshold })).fields).toEqual([]);
    }
    const { fields } = await check({
      categories: {
        SPAM_IRRELEVANT: { replyEn: 'x'.repeat(500), replyBn: null },
      },
    });
    expect(fields).toEqual([]);
  });
});

describe('policy patch rules', () => {
  const base = () => defaultModerationPolicy(WS);

  it('isEmptyPolicyPatch', () => {
    expect(isEmptyPolicyPatch({})).toBe(true);
    expect(isEmptyPolicyPatch({ categories: {} })).toBe(true);
    expect(isEmptyPolicyPatch({ categories: { SAFE_INQUIRY: {} } })).toBe(true);
    expect(isEmptyPolicyPatch({ mode: 'AUTO' })).toBe(false);
    expect(
      isEmptyPolicyPatch({ categories: { SAFE_INQUIRY: { replyEn: null } } }),
    ).toBe(false);
  });

  it('applyPolicyPatch keeps unsent fields and clears null texts', () => {
    const current = base();
    current.categories.SAFE_INQUIRY = {
      action: 'NONE',
      autoReply: false,
      replyEn: EN,
      replyBn: BN,
    };
    const next = applyPolicyPatch(current, {
      confidenceThreshold: 0.9,
      categories: {
        SAFE_INQUIRY: { replyEn: null },
        SCAM_PHISHING: { action: 'DELETE' },
      },
    });
    expect(next.mode).toBe('AUTO');
    expect(next.confidenceThreshold).toBe(0.9);
    expect(next.aiContextLevel).toBe('comment_only');
    expect(next.categories.SAFE_INQUIRY).toEqual({
      action: 'NONE',
      autoReply: false,
      replyEn: null,
      replyBn: BN,
    });
    expect(next.categories.SCAM_PHISHING.action).toBe('DELETE');
    expect(next.categories.ABUSIVE_TOXIC).toEqual(
      current.categories.ABUSIVE_TOXIC,
    );
    // The input is not mutated.
    expect(current.categories.SAFE_INQUIRY.replyEn).toBe(EN);
  });

  it('samePolicy: no-op patches compare equal', () => {
    const current = base();
    expect(
      samePolicy(current, applyPolicyPatch(current, { mode: 'AUTO' })),
    ).toBe(true);
    expect(
      samePolicy(
        current,
        applyPolicyPatch(current, {
          confidenceThreshold: 0.8,
          categories: { SCAM_PHISHING: { action: 'HIDE', autoReply: false } },
        }),
      ),
    ).toBe(true);
    expect(
      samePolicy(current, applyPolicyPatch(current, { mode: 'REVIEW' })),
    ).toBe(false);
    expect(
      samePolicy(
        current,
        applyPolicyPatch(current, {
          categories: { ABUSIVE_TOXIC: { replyBn: BN } },
        }),
      ),
    ).toBe(false);
  });

  describe('assertPolicyPatchAllowed', () => {
    const on = { autoReplyTemplates: true };
    const off = { autoReplyTemplates: false };

    it('409 PLAN_FEATURE_UNAVAILABLE when switching on without the feature', () => {
      const patch = {
        categories: {
          SAFE_INQUIRY: { autoReply: true, replyEn: EN, replyBn: BN },
        },
      };
      const next = applyPolicyPatch(base(), patch);
      expect(() => assertPolicyPatchAllowed(patch, next, off)).toThrow(
        ConflictException,
      );
      try {
        assertPolicyPatchAllowed(patch, next, off);
      } catch (error) {
        expect((error as ConflictException).getResponse()).toMatchObject({
          code: 'PLAN_FEATURE_UNAVAILABLE',
          details: { feature: 'autoReplyTemplates' },
        });
      }
      expect(() => assertPolicyPatchAllowed(patch, next, on)).not.toThrow();
    });

    it('texts and other fields may be edited without the feature', () => {
      const patch = {
        mode: 'REVIEW' as const,
        categories: { SAFE_INQUIRY: { autoReply: false, replyEn: EN } },
      };
      expect(() =>
        assertPolicyPatchAllowed(patch, applyPolicyPatch(base(), patch), off),
      ).not.toThrow();
    });

    it('a switch already on (e.g. after a downgrade) does not block other edits', () => {
      const current = base();
      current.categories.SAFE_INQUIRY = {
        action: 'NONE',
        autoReply: true,
        replyEn: EN,
        replyBn: BN,
      };
      const patch = { confidenceThreshold: 0.9 };
      expect(() =>
        assertPolicyPatchAllowed(patch, applyPolicyPatch(current, patch), off),
      ).not.toThrow();
    });

    it('400 AUTO_REPLY_TEXTS_REQUIRED when a switch ends on without both texts', () => {
      for (const patch of [
        { categories: { SPAM_IRRELEVANT: { autoReply: true } } },
        { categories: { SPAM_IRRELEVANT: { autoReply: true, replyEn: EN } } },
        { categories: { SPAM_IRRELEVANT: { autoReply: true, replyBn: BN } } },
      ]) {
        const next = applyPolicyPatch(base(), patch);
        try {
          assertPolicyPatchAllowed(patch, next, on);
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(BadRequestException);
          expect((error as BadRequestException).getResponse()).toMatchObject({
            code: 'AUTO_REPLY_TEXTS_REQUIRED',
            details: { category: 'SPAM_IRRELEVANT' },
          });
        }
      }
    });

    it('400 when a text is cleared while its switch stays on', () => {
      const current = base();
      current.categories.SAFE_INQUIRY = {
        action: 'NONE',
        autoReply: true,
        replyEn: EN,
        replyBn: BN,
      };
      const patch = { categories: { SAFE_INQUIRY: { replyBn: null } } };
      expect(() =>
        assertPolicyPatchAllowed(patch, applyPolicyPatch(current, patch), on),
      ).toThrow(BadRequestException);
    });

    it('the plan check comes first', () => {
      const patch = { categories: { SAFE_INQUIRY: { autoReply: true } } };
      expect(() =>
        assertPolicyPatchAllowed(patch, applyPolicyPatch(base(), patch), off),
      ).toThrow(ConflictException);
    });
  });

  it('policyColumns flattens every category', () => {
    const columns = policyColumns(base());
    expect(columns).toMatchObject({
      mode: 'AUTO',
      confidenceThreshold: 0.8,
      aiContextLevel: 'comment_only',
      safeInquiryAction: 'NONE',
      scamPhishingAction: 'HIDE',
      abusiveToxicAutoReply: false,
      competitorPoachReplyEn: null,
      spamIrrelevantReplyBn: null,
    });
    expect(Object.keys(columns)).toHaveLength(3 + 5 * 4);
  });
});
