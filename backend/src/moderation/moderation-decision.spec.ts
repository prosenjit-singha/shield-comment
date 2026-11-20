import {
  type DecisionClassification,
  type DecisionCurrent,
  DECISION_REASONS,
  decideAction,
  decideRuleAction,
  type ModerationDecision,
} from './moderation-decision.js';
import {
  type CommentLanguage,
  isMachineCode,
  MODERATION_CATEGORIES,
  type ModerationCategory,
  type PolicyAction,
  RULE_KINDS,
} from './moderation.constants.js';
import {
  defaultModerationPolicy,
  type ModerationPolicy,
} from './moderation.queries.js';

const WS = '019a0000-0000-7000-8000-000000000001';
const STAMP = new Date('2026-11-19T10:00:00.000Z');
const PLAN_ON = { autoReplyTemplates: true };
const PLAN_OFF = { autoReplyTemplates: false };

function policy(
  patch: Partial<Omit<ModerationPolicy, 'categories'>> = {},
  categories: Partial<
    Record<
      ModerationCategory,
      Partial<ModerationPolicy['categories'][ModerationCategory]>
    >
  > = {},
): ModerationPolicy {
  const base = defaultModerationPolicy(WS);
  for (const [category, rule] of Object.entries(categories)) {
    const key = category as ModerationCategory;
    base.categories[key] = { ...base.categories[key], ...rule };
  }
  return { ...base, ...patch };
}

/** A category with auto-reply switched on and both texts set. */
const withReply = (action: PolicyAction = 'HIDE') => ({
  action,
  autoReply: true,
  replyEn: 'Please message our Page for help.',
  replyBn: 'সাহায্যের জন্য আমাদের পেজে মেসেজ দিন।',
});

const cls = (
  category: ModerationCategory,
  confidence = 0.95,
  language: CommentLanguage = 'en',
): DecisionClassification => ({ category, confidence, language });

const fresh = (patch: Partial<DecisionCurrent> = {}): DecisionCurrent => ({
  status: 'PENDING',
  overriddenAt: null,
  deletedAt: null,
  hiddenByAi: false,
  autoReplied: false,
  ...patch,
});
const aiHidden = (patch: Partial<DecisionCurrent> = {}) =>
  fresh({ status: 'HIDDEN', hiddenByAi: true, ...patch });

const decide = (
  p: ModerationPolicy,
  c: DecisionClassification,
  current: DecisionCurrent = fresh(),
  plan = PLAN_ON,
) => decideAction(p, c, plan, current);

describe('decideAction', () => {
  it('reasons are machine codes (they may be stored as status_reason)', () => {
    for (const reason of DECISION_REASONS)
      expect(isMachineCode(reason)).toBe(true);
  });

  describe('D3 defaults (AUTO, threshold 0.80)', () => {
    it.each(
      MODERATION_CATEGORIES.map((category) => ({
        category,
        expected:
          category === 'SAFE_INQUIRY'
            ? { action: 'NONE', status: 'VISIBLE', reason: 'policy' }
            : { action: 'HIDE', status: 'HIDDEN', reason: 'policy' },
      })),
    )('$category → $expected.action', ({ category, expected }) => {
      expect(decide(policy(), cls(category))).toEqual(expected);
    });

    it('never deletes by default and never replies by default', () => {
      for (const category of MODERATION_CATEGORIES) {
        const d = decide(policy(), cls(category, 1));
        expect(d.action).not.toBe('DELETE');
        expect(d.reply).toBeUndefined();
      }
    });
  });

  describe('D4 threshold', () => {
    it('acts exactly at the threshold', () => {
      expect(decide(policy(), cls('SCAM_PHISHING', 0.8))).toMatchObject({
        action: 'HIDE',
      });
    });

    it('below the threshold: no action, NEEDS_REVIEW', () => {
      expect(decide(policy(), cls('SCAM_PHISHING', 0.799))).toEqual({
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        reason: 'below_threshold',
      });
      expect(decide(policy(), cls('SAFE_INQUIRY', 0.1))).toEqual({
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        reason: 'below_threshold',
      });
    });

    it('uses the workspace threshold', () => {
      const p = policy({ confidenceThreshold: 0.95 });
      expect(decide(p, cls('ABUSIVE_TOXIC', 0.94)).reason).toBe(
        'below_threshold',
      );
      expect(decide(p, cls('ABUSIVE_TOXIC', 0.95)).action).toBe('HIDE');
      const all = policy({ confidenceThreshold: 1 });
      expect(decide(all, cls('ABUSIVE_TOXIC', 0.999)).action).toBe('NONE');
      expect(decide(all, cls('ABUSIVE_TOXIC', 1)).action).toBe('HIDE');
    });

    it('below the threshold never replies', () => {
      const p = policy({}, { SCAM_PHISHING: withReply() });
      expect(decide(p, cls('SCAM_PHISHING', 0.5)).reply).toBeUndefined();
    });

    it('a hidden comment stays HIDDEN below the threshold (status mirrors Meta)', () => {
      expect(decide(policy(), cls('SAFE_INQUIRY', 0.4), aiHidden())).toEqual({
        action: 'NONE',
        status: 'HIDDEN',
        reason: 'below_threshold',
      });
    });
  });

  describe('category actions (D5 opt-in delete)', () => {
    it('DELETE when the workspace opted in', () => {
      const p = policy({}, { SCAM_PHISHING: { action: 'DELETE' } });
      expect(decide(p, cls('SCAM_PHISHING'))).toEqual({
        action: 'DELETE',
        status: 'DELETED',
        reason: 'policy',
      });
    });

    it('NONE leaves a visible comment visible', () => {
      const p = policy({}, { SPAM_IRRELEVANT: { action: 'NONE' } });
      expect(decide(p, cls('SPAM_IRRELEVANT'))).toEqual({
        action: 'NONE',
        status: 'VISIBLE',
        reason: 'policy',
      });
    });

    it('HIDE on SAFE_INQUIRY when the owner asks for it', () => {
      const p = policy({}, { SAFE_INQUIRY: { action: 'HIDE' } });
      expect(decide(p, cls('SAFE_INQUIRY')).action).toBe('HIDE');
    });

    it.each(['VISIBLE', 'NEEDS_REVIEW', 'FAILED', 'SKIPPED'] as const)(
      'treats a %s comment as visible',
      (status) => {
        expect(
          decide(policy(), cls('SCAM_PHISHING'), fresh({ status })).action,
        ).toBe('HIDE');
      },
    );
  });

  describe('REVIEW mode (classify only)', () => {
    const review = policy(
      { mode: 'REVIEW' },
      { SCAM_PHISHING: withReply('DELETE') },
    );

    it('a result that would act becomes NEEDS_REVIEW', () => {
      expect(decide(review, cls('SCAM_PHISHING'))).toEqual({
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        reason: 'review_mode',
      });
      expect(decide(review, cls('ABUSIVE_TOXIC'))).toEqual({
        action: 'NONE',
        status: 'NEEDS_REVIEW',
        reason: 'review_mode',
      });
    });

    it('a result with nothing to do is VISIBLE', () => {
      expect(decide(review, cls('SAFE_INQUIRY'))).toEqual({
        action: 'NONE',
        status: 'VISIBLE',
        reason: 'policy',
      });
    });

    it('never un-hides and never replies', () => {
      const p = policy({ mode: 'REVIEW' }, { SAFE_INQUIRY: withReply('NONE') });
      expect(decide(p, cls('SAFE_INQUIRY'), aiHidden())).toEqual({
        action: 'NONE',
        status: 'HIDDEN',
        reason: 'review_mode',
      });
      expect(decide(p, cls('SAFE_INQUIRY')).reply).toBeUndefined();
    });
  });

  describe('D11 edited comments', () => {
    it('un-hides a comment the AI hid when the edit is safe', () => {
      expect(decide(policy(), cls('SAFE_INQUIRY'), aiHidden())).toEqual({
        action: 'UNHIDE',
        status: 'VISIBLE',
        reason: 'ai_unhide',
      });
    });

    it('un-hides when the new category is one the workspace set to NONE', () => {
      const p = policy({}, { SPAM_IRRELEVANT: { action: 'NONE' } });
      expect(decide(p, cls('SPAM_IRRELEVANT'), aiHidden()).action).toBe(
        'UNHIDE',
      );
    });

    it('does not un-hide a comment hidden by someone else', () => {
      expect(
        decide(policy(), cls('SAFE_INQUIRY'), fresh({ status: 'HIDDEN' })),
      ).toEqual({
        action: 'NONE',
        status: 'HIDDEN',
        reason: 'hidden_by_other',
      });
    });

    it('escalates a visible comment to hidden', () => {
      expect(
        decide(policy(), cls('SCAM_PHISHING'), fresh({ status: 'VISIBLE' })),
      ).toMatchObject({ action: 'HIDE', status: 'HIDDEN' });
    });

    it('a hidden comment that is still bad stays hidden without a second call', () => {
      expect(decide(policy(), cls('ABUSIVE_TOXIC'), aiHidden())).toEqual({
        action: 'NONE',
        status: 'HIDDEN',
        reason: 'already_applied',
      });
    });

    it('escalates a hidden comment to deleted when the new category deletes', () => {
      const p = policy({}, { SCAM_PHISHING: { action: 'DELETE' } });
      expect(decide(p, cls('SCAM_PHISHING'), aiHidden())).toMatchObject({
        action: 'DELETE',
        status: 'DELETED',
      });
    });
  });

  describe('human-stamped and deleted comments', () => {
    const p = policy({}, { SCAM_PHISHING: withReply('DELETE') });

    it.each(['VISIBLE', 'HIDDEN', 'NEEDS_REVIEW'] as const)(
      'a human-stamped %s comment is never changed (no action, no reply)',
      (status) => {
        for (const category of MODERATION_CATEGORIES) {
          expect(
            decide(
              p,
              cls(category),
              fresh({ status, overriddenAt: STAMP, hiddenByAi: true }),
            ),
          ).toEqual({ action: 'NONE', status, reason: 'human_override' });
        }
      },
    );

    it('a deleted comment gets nothing (deletedAt or status DELETED)', () => {
      const deleted: ModerationDecision = {
        action: 'NONE',
        status: 'DELETED',
        reason: 'comment_deleted',
      };
      expect(
        decide(p, cls('SCAM_PHISHING'), fresh({ status: 'DELETED' })),
      ).toEqual(deleted);
      expect(
        decide(
          p,
          cls('SCAM_PHISHING'),
          fresh({ status: 'VISIBLE', deletedAt: STAMP }),
        ),
      ).toEqual({ ...deleted, status: 'VISIBLE' });
    });
  });

  describe('D6 auto-reply', () => {
    const p = policy(
      {},
      { SAFE_INQUIRY: withReply('NONE'), COMPETITOR_POACH: withReply('HIDE') },
    );

    it.each([
      { language: 'en', expected: 'en' },
      { language: 'bn', expected: 'bn' },
      { language: 'banglish', expected: 'bn' },
    ] as const)(
      '$language comment → $expected text',
      ({ language, expected }) => {
        const d = decide(p, cls('SAFE_INQUIRY', 0.9, language));
        expect(d).toMatchObject({ action: 'NONE', status: 'VISIBLE' });
        expect(d.reply).toEqual({
          language: expected,
          text: expected === 'en' ? withReply().replyEn : withReply().replyBn,
        });
      },
    );

    it('replies together with a hide', () => {
      expect(decide(p, cls('COMPETITOR_POACH', 0.9, 'banglish'))).toEqual({
        action: 'HIDE',
        status: 'HIDDEN',
        reason: 'policy',
        reply: { language: 'bn', text: withReply().replyBn },
      });
    });

    it('no reply on a plan without autoReplyTemplates', () => {
      expect(
        decide(p, cls('SAFE_INQUIRY'), fresh(), PLAN_OFF).reply,
      ).toBeUndefined();
    });

    it('no reply when the switch is off (texts kept)', () => {
      const off = policy(
        {},
        { SAFE_INQUIRY: { ...withReply('NONE'), autoReply: false } },
      );
      expect(decide(off, cls('SAFE_INQUIRY')).reply).toBeUndefined();
    });

    it('no reply when a text is missing', () => {
      const noBn = policy(
        {},
        { SAFE_INQUIRY: { ...withReply('NONE'), replyBn: null } },
      );
      expect(
        decide(noBn, cls('SAFE_INQUIRY', 0.9, 'en')).reply,
      ).toBeUndefined();
    });

    it('no reply when the comment is deleted by the policy', () => {
      const del = policy({}, { SCAM_PHISHING: withReply('DELETE') });
      expect(decide(del, cls('SCAM_PHISHING'))).toEqual({
        action: 'DELETE',
        status: 'DELETED',
        reason: 'policy',
      });
    });

    it('at most one auto-reply per comment', () => {
      expect(
        decide(p, cls('SAFE_INQUIRY'), fresh({ autoReplied: true })).reply,
      ).toBeUndefined();
    });

    it('an AI-hidden comment edited to a safe text is un-hidden and may get its reply', () => {
      expect(decide(p, cls('SAFE_INQUIRY', 0.9, 'bn'), aiHidden())).toEqual({
        action: 'UNHIDE',
        status: 'VISIBLE',
        reason: 'ai_unhide',
        reply: { language: 'bn', text: withReply().replyBn },
      });
    });
  });
});

describe('decideRuleAction (M6-T2, Module 6 D2 b)', () => {
  const rules = (action: 'HIDE' | 'DELETE') => ({
    ...policy().rules,
    actions: { keyword: action, url: action, phone: action },
  });

  it.each(RULE_KINDS)('%s: AUTO + HIDE → HIDE, HIDDEN', (kind) => {
    expect(decideRuleAction(policy(), kind, fresh())).toEqual({
      action: 'HIDE',
      status: 'HIDDEN',
      reason: 'policy',
    });
  });

  it.each(RULE_KINDS)('%s: AUTO + DELETE → DELETE, DELETED', (kind) => {
    const p = policy({ rules: rules('DELETE') });
    expect(decideRuleAction(p, kind, fresh())).toEqual({
      action: 'DELETE',
      status: 'DELETED',
      reason: 'policy',
    });
    // Delete escalates a hidden comment too.
    expect(decideRuleAction(p, kind, fresh({ status: 'HIDDEN' })).action).toBe(
      'DELETE',
    );
  });

  it('uses the action of the matched kind only', () => {
    const p = policy({
      rules: {
        ...policy().rules,
        actions: { keyword: 'HIDE', url: 'DELETE', phone: 'HIDE' },
      },
    });
    expect(decideRuleAction(p, 'keyword', fresh()).action).toBe('HIDE');
    expect(decideRuleAction(p, 'url', fresh()).action).toBe('DELETE');
    expect(decideRuleAction(p, 'phone', fresh()).action).toBe('HIDE');
  });

  it('REVIEW mode → no action, NEEDS_REVIEW (HIDDEN stays HIDDEN)', () => {
    const p = policy({ mode: 'REVIEW', rules: rules('DELETE') });
    expect(decideRuleAction(p, 'phone', fresh())).toEqual({
      action: 'NONE',
      status: 'NEEDS_REVIEW',
      reason: 'review_mode',
    });
    expect(
      decideRuleAction(p, 'phone', fresh({ status: 'HIDDEN' })).status,
    ).toBe('HIDDEN');
  });

  it('already hidden + HIDE → nothing to do; deleted / human-stamped → untouched', () => {
    expect(
      decideRuleAction(policy(), 'url', fresh({ status: 'HIDDEN' })),
    ).toEqual({ action: 'NONE', status: 'HIDDEN', reason: 'already_applied' });
    expect(
      decideRuleAction(policy(), 'url', fresh({ deletedAt: STAMP })),
    ).toMatchObject({ action: 'NONE', reason: 'comment_deleted' });
    expect(
      decideRuleAction(
        policy(),
        'url',
        fresh({ status: 'VISIBLE', overriddenAt: STAMP }),
      ),
    ).toEqual({ action: 'NONE', status: 'VISIBLE', reason: 'human_override' });
  });
});
