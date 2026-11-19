import { GOLDEN_COMMENTS } from '../../test/fixtures/golden-comments.js';
import { MAX_COMMENT_CHARS } from './classifier-input.js';
import {
  GOLDEN_MIN_ITEMS,
  GOLDEN_MIN_PER_CATEGORY,
  type GoldenComment,
  goldenClassifierInput,
  validateGoldenFixture,
} from './golden-fixture.js';
import {
  COMMENT_LANGUAGES,
  MODERATION_CATEGORIES,
} from './moderation.constants.js';
import { FEW_SHOTS } from './moderation-prompt.js';

const items: readonly GoldenComment[] = GOLDEN_COMMENTS;

describe('golden fixture (test/fixtures/golden-comments.ts)', () => {
  it('passes the D12 invariants', () => {
    expect(validateGoldenFixture(items)).toHaveLength(items.length);
    expect(items.length).toBeGreaterThanOrEqual(GOLDEN_MIN_ITEMS);
  });

  it('has ≥ 6 items per category and every language, mixed and injection items', () => {
    for (const category of MODERATION_CATEGORIES) {
      expect(
        items.filter((i) => i.expected === category).length,
        category,
      ).toBeGreaterThanOrEqual(GOLDEN_MIN_PER_CATEGORY);
    }
    for (const language of COMMENT_LANGUAGES) {
      expect(
        items.some((i) => i.language === language),
        language,
      ).toBe(true);
    }
    expect(
      items.filter((i) => i.tags.includes('mixed')).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      items.filter((i) => i.tags.includes('injection')).length,
    ).toBeGreaterThanOrEqual(4);
    // D12 themes: bKash / Nagad, wa.me links, BD phone formats.
    for (const tag of ['bkash', 'nagad', 'wa.me', 'phone', 'bangla-digits']) {
      expect(
        items.some((i) => i.tags.includes(tag)),
        tag,
      ).toBe(true);
    }
    expect(items.some((i) => i.platform === 'INSTAGRAM')).toBe(true);
    expect(items.some((i) => i.isReply)).toBe(true);
    expect(items.some((i) => i.postCaption !== undefined)).toBe(true);
  });

  it('has unique ids that start with their category prefix', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    const prefix = {
      SAFE_INQUIRY: 'safe-',
      COMPETITOR_POACH: 'comp-',
      SCAM_PHISHING: 'scam-',
      SPAM_IRRELEVANT: 'spam-',
      ABUSIVE_TOXIC: 'abuse-',
    } as const;
    for (const item of items)
      expect(item.id.startsWith(prefix[item.expected]), item.id).toBe(true);
  });

  it('keeps texts within the classifier limit and uses made-up phone numbers', () => {
    for (const item of items) {
      expect(Array.from(item.text).length, item.id).toBeLessThanOrEqual(
        MAX_COMMENT_CHARS,
      );
      const digits = item.text
        .replace(/[০-৯]/gu, (d) => String(d.charCodeAt(0) - 0x09e6))
        .match(/(?:\+?880)?01\d[\d-]{8,}/g);
      for (const phone of digits ?? []) {
        expect(phone.replace(/-/g, ''), item.id).toMatch(/000/);
      }
    }
  });

  it('copies no prompt few-shot (the suite must not grade the prompt on its own examples)', () => {
    const shots = FEW_SHOTS.map((s) => s.input.text.toLowerCase());
    for (const item of items) {
      const text = item.text.toLowerCase();
      for (const shot of shots) {
        expect(
          text === shot || text.includes(shot) || shot.includes(text),
          item.id,
        ).toBe(false);
      }
    }
  });

  it('builds the classifier input of a run level (D8)', () => {
    const item = items.find((i) => i.id === 'safe-10');
    if (!item) throw new Error('safe-10 missing');
    expect(goldenClassifierInput(item, 'comment_only')).toEqual({
      text: item.text,
      platform: 'INSTAGRAM',
      isReply: false,
      contextLevel: 'comment_only',
      pageName: item.pageName,
      postCaption: item.postCaption,
    });
    const plain = items.find((i) => i.id === 'safe-01');
    expect(plain && goldenClassifierInput(plain, 'post_caption')).toEqual({
      text: plain?.text,
      platform: 'FACEBOOK',
      isReply: false,
      contextLevel: 'post_caption',
    });
  });
});

describe('validateGoldenFixture', () => {
  const valid = (): GoldenComment[] =>
    items.map((i) => ({ ...i, tags: [...i.tags] }));

  it('rejects a non-array', () => {
    expect(() => validateGoldenFixture({})).toThrow(/expected an array/);
  });

  it('lists every shape problem at once', () => {
    const bad: unknown[] = valid();
    bad.push(
      { ...items[0], id: items[0]?.id },
      {
        id: 'Bad id',
        text: ' ',
        platform: 'TIKTOK',
        isReply: 'no',
        expected: 'X',
        language: 'hi',
        tags: [1],
        note: 3,
      },
      { ...items[0], id: 'safe-99', text: 'x'.repeat(MAX_COMMENT_CHARS + 1) },
      'nope',
    );
    let message = '';
    try {
      validateGoldenFixture(bad);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const part of [
      'safe-01: duplicate id',
      'Bad id: id must match',
      'Bad id: empty text',
      'Bad id: platform',
      'Bad id: isReply',
      'Bad id: expected',
      'Bad id: language',
      'Bad id: tags',
      'Bad id: pageName / postCaption / note',
      `safe-99: text longer than ${MAX_COMMENT_CHARS}`,
      `item ${items.length + 3}: not an object`,
    ]) {
      expect(message).toContain(part);
    }
  });

  it('enforces the counts: total, per category, languages, mixed, injection', () => {
    const few = valid()
      .filter((i) => i.expected !== 'ABUSIVE_TOXIC' && i.language !== 'en')
      .map((i) => ({
        ...i,
        tags: i.tags.filter((t) => t !== 'mixed' && t !== 'injection'),
      }));
    expect(() => validateGoldenFixture(few)).toThrow(
      new RegExp(
        [
          `only ${few.length} items`,
          'ABUSIVE_TOXIC: 0 items',
          'no en item',
          'no mixed-language item',
          'no prompt-injection item',
        ].join('[\\s\\S]*'),
      ),
    );
  });
});
