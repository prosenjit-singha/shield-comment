import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { UpdateModerationPolicyDto } from './dto/moderation-policy.dto.js';
import {
  applyPolicyPatch,
  assertPolicyPatchAllowed,
  assertRulesPatchAllowed,
  isEmptyPolicyPatch,
  normalizeRulesPatch,
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
    expect(columns).toMatchObject({
      blockedKeywords: [],
      blockUrls: false,
      blockPhoneNumbers: false,
      allowedDomains: [],
      keywordRuleAction: 'HIDE',
      urlRuleAction: 'HIDE',
      phoneRuleAction: 'HIDE',
    });
    expect(Object.keys(columns)).toHaveLength(3 + 5 * 4 + 7);
  });
});

describe('static rules (M6-T1, D2/D4/D5/D6)', () => {
  const base = () => defaultModerationPolicy(WS);
  const codeOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      const error = e as BadRequestException;
      return { status: error.getStatus(), ...(error.getResponse() as object) };
    }
    throw new Error('did not throw');
  };

  it('DTO accepts a full rules body', async () => {
    const { fields } = await check({
      rules: {
        blockedKeywords: ['bkash', 'বিকাশ নম্বর'],
        blockUrls: true,
        blockPhoneNumbers: false,
        allowedDomains: ['shop.example.com'],
        actions: { keyword: 'DELETE', url: 'HIDE', phone: 'HIDE' },
      },
    });
    expect(fields).toEqual([]);
  });

  it.each([
    [{ rules: [] }, 'rules'],
    [{ rules: null }, 'rules'],
    [{ rules: { blockedKeywords: 'bkash' } }, 'rules.blockedKeywords'],
    [{ rules: { blockedKeywords: ['ok', 5] } }, 'rules.blockedKeywords'],
    [{ rules: { blockedKeywords: null } }, 'rules.blockedKeywords'],
    [{ rules: { blockUrls: 'true' } }, 'rules.blockUrls'],
    [{ rules: { blockPhoneNumbers: null } }, 'rules.blockPhoneNumbers'],
    [{ rules: { allowedDomains: [null] } }, 'rules.allowedDomains'],
    [{ rules: { actions: { keyword: 'NONE' } } }, 'rules.actions.keyword'],
    [{ rules: { actions: { email: 'HIDE' } } }, 'rules.actions.email'],
    [{ rules: { regex: ['.*'] } }, 'rules.regex'],
  ])('%j → 400 on %s', async (body, field) => {
    expect((await check(body)).fields).toContain(field);
  });

  it('isEmptyPolicyPatch looks inside rules and rules.actions', () => {
    expect(isEmptyPolicyPatch({ rules: {} })).toBe(true);
    expect(isEmptyPolicyPatch({ rules: { actions: {} } })).toBe(true);
    expect(isEmptyPolicyPatch({ rules: { blockedKeywords: [] } })).toBe(false);
    expect(isEmptyPolicyPatch({ rules: { actions: { url: 'DELETE' } } })).toBe(
      false,
    );
  });

  it('normalizeRulesPatch: NFKC + lower-case + whitespace, de-duplicated, Bangla as typed', () => {
    expect(
      normalizeRulesPatch({
        blockedKeywords: [
          '  Free   BKASH ',
          'free bkash',
          'ＢＫＡＳＨ',
          'বিকাশ  নম্বর',
          'bkash',
        ],
        allowedDomains: ['WWW.Shop.com', 'shop.com', 'daraz.com.bd'],
        blockUrls: true,
      }),
    ).toEqual({
      blockedKeywords: ['free bkash', 'bkash', 'বিকাশ নম্বর'],
      allowedDomains: ['shop.com', 'daraz.com.bd'],
      blockUrls: true,
    });
    expect(normalizeRulesPatch({ blockedKeywords: [] })).toEqual({
      blockedKeywords: [],
    });
  });

  it.each([
    [
      { blockedKeywords: ['ok', '   '] },
      'BLOCKED_KEYWORD_INVALID',
      { keyword: '   ' },
    ],
    [
      { blockedKeywords: ['x'.repeat(51)] },
      'BLOCKED_KEYWORD_INVALID',
      { keyword: 'x'.repeat(51) },
    ],
    [
      { blockedKeywords: Array.from({ length: 201 }, (_, i) => `k${i}`) },
      'BLOCKED_KEYWORDS_LIMIT',
      { max: 200 },
    ],
    [
      { allowedDomains: ['https://x.com'] },
      'ALLOWED_DOMAIN_INVALID',
      { domain: 'https://x.com' },
    ],
    [
      { allowedDomains: Array.from({ length: 21 }, (_, i) => `d${i}.com`) },
      'ALLOWED_DOMAINS_LIMIT',
      { max: 20 },
    ],
  ])('case %#: 400 with a code', (rules, code, details) => {
    expect(codeOf(() => normalizeRulesPatch(rules))).toMatchObject({
      status: 400,
      code,
      details,
    });
  });

  it('limits count after de-duplication and code points (50 Bangla code points ok)', () => {
    // 200 distinct + a case variant of one of them = 200 after de-duplication.
    const keywords = [...Array.from({ length: 200 }, (_, i) => `k${i}`), 'K0'];
    expect(
      normalizeRulesPatch({ blockedKeywords: keywords }).blockedKeywords,
    ).toHaveLength(200);
    expect(
      normalizeRulesPatch({ blockedKeywords: ['ক'.repeat(50)] })
        .blockedKeywords,
    ).toEqual(['ক'.repeat(50)]);
  });

  it('applyPolicyPatch replaces lists, merges actions; samePolicy compares rules', () => {
    const current = base();
    const next = applyPolicyPatch(current, {
      rules: {
        blockedKeywords: ['bkash'],
        blockPhoneNumbers: true,
        actions: { phone: 'DELETE' },
      },
    });
    expect(next.rules).toEqual({
      blockedKeywords: ['bkash'],
      blockUrls: false,
      blockPhoneNumbers: true,
      allowedDomains: [],
      actions: { keyword: 'HIDE', url: 'HIDE', phone: 'DELETE' },
    });
    expect(samePolicy(current, next)).toBe(false);
    expect(
      samePolicy(
        next,
        applyPolicyPatch(next, { rules: { blockedKeywords: ['bkash'] } }),
      ),
    ).toBe(true);
    expect(
      samePolicy(
        next,
        applyPolicyPatch(next, { rules: { actions: { url: 'DELETE' } } }),
      ),
    ).toBe(false);
    expect(
      samePolicy(
        next,
        applyPolicyPatch(next, { rules: { allowedDomains: ['a.com'] } }),
      ),
    ).toBe(false);
  });

  describe('assertRulesPatchAllowed (D4)', () => {
    const starter = {
      autoReplyTemplates: false,
      customBlocklist: false,
      autoHideScams: true,
    };
    const none = { ...starter, autoHideScams: false };
    const growth = { ...starter, customBlocklist: true };
    const run =
      (
        current: ReturnType<typeof base>,
        rules: Parameters<typeof applyPolicyPatch>[1]['rules'],
        features: typeof starter,
      ) =>
      () =>
        assertRulesPatchAllowed(
          current,
          applyPolicyPatch(current, { rules }),
          features,
        );

    it('adding a keyword needs customBlocklist', () => {
      expect(
        codeOf(run(base(), { blockedKeywords: ['bkash'] }, starter)),
      ).toMatchObject({
        status: 409,
        code: 'PLAN_FEATURE_UNAVAILABLE',
        details: { feature: 'customBlocklist' },
      });
      expect(run(base(), { blockedKeywords: ['bkash'] }, growth)).not.toThrow();
    });

    it('a downgraded workspace may remove keywords and keep the rest', () => {
      const current = applyPolicyPatch(base(), {
        rules: { blockedKeywords: ['a', 'b'] },
      });
      expect(run(current, { blockedKeywords: ['b'] }, none)).not.toThrow();
      expect(run(current, { blockedKeywords: [] }, none)).not.toThrow();
      expect(run(current, { blockedKeywords: ['b', 'c'] }, none)).toThrow(
        ConflictException,
      );
    });

    it('URL / phone on needs autoHideScams (every live plan); off, domains, actions never gated', () => {
      for (const rules of [{ blockUrls: true }, { blockPhoneNumbers: true }]) {
        expect(codeOf(run(base(), rules, none))).toMatchObject({
          code: 'PLAN_FEATURE_UNAVAILABLE',
          details: { feature: 'autoHideScams' },
        });
        expect(run(base(), rules, starter)).not.toThrow();
      }
      const on = applyPolicyPatch(base(), {
        rules: { blockUrls: true, blockPhoneNumbers: true },
      });
      expect(run(on, { blockUrls: true }, none)).not.toThrow();
      expect(
        run(on, { blockUrls: false, blockPhoneNumbers: false }, none),
      ).not.toThrow();
      expect(
        run(
          base(),
          { allowedDomains: ['a.com'], actions: { url: 'DELETE' } },
          none,
        ),
      ).not.toThrow();
    });
  });
});
