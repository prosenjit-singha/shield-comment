import { GOLDEN_COMMENTS } from '../../test/fixtures/golden-comments.js';
import {
  guessCommentLanguage,
  JEV_PROMPT_VERSION,
  JEV_QUESTIONS,
  jevDecision,
  jevReasoning,
  jevState,
} from './jev-moderation.js';
import { PROMPT_VERSION } from './moderation-prompt.js';

const NO = {
  money_offer: 0.02,
  asks_secret_code: 0.01,
  abusive: 0.03,
  other_seller: 0.04,
  unrelated_spam: 0.1,
};

describe('jevDecision', () => {
  it('no harmful yes → SAFE_INQUIRY with 1 − the strongest', () => {
    expect(jevDecision(NO)).toEqual({
      category: 'SAFE_INQUIRY',
      confidence: 0.9,
    });
  });

  it.each([
    ['money_offer', 'SCAM_PHISHING'],
    ['asks_secret_code', 'SCAM_PHISHING'],
    ['abusive', 'ABUSIVE_TOXIC'],
    ['other_seller', 'COMPETITOR_POACH'],
    ['unrelated_spam', 'SPAM_IRRELEVANT'],
  ] as const)('%s yes → %s', (id, category) => {
    expect(jevDecision({ ...NO, [id]: 0.93 })).toEqual({
      category,
      confidence: 0.93,
    });
  });

  it('the strongest harmful yes wins; ties go to the scam / abuse side', () => {
    expect(
      jevDecision({ ...NO, other_seller: 0.7, unrelated_spam: 0.8 }).category,
    ).toBe('SPAM_IRRELEVANT');
    expect(
      jevDecision({ ...NO, money_offer: 0.8, other_seller: 0.8 }).category,
    ).toBe('SCAM_PHISHING');
  });

  it('a Noul in the unsettled band gives a low confidence either way', () => {
    expect(jevDecision({ ...NO, abusive: 0.55 })).toEqual({
      category: 'ABUSIVE_TOXIC',
      confidence: 0.55,
    });
    expect(jevDecision({ ...NO, abusive: 0.45 })).toEqual({
      category: 'SAFE_INQUIRY',
      confidence: 0.55,
    });
  });

  it('a missing answer counts as no', () => {
    expect(jevDecision({}).category).toBe('SAFE_INQUIRY');
  });
});

describe('jevState / questions', () => {
  it('names the comment field and only the context that is sent', () => {
    expect(
      jevState({
        text: 'price koto?',
        platform: 'INSTAGRAM',
        isReply: true,
        contextLevel: 'comment_only',
      }),
    ).toEqual({
      setting: expect.stringContaining('Instagram comment replying'),
      comment: 'price koto?',
    });
    expect(
      jevState({
        text: 'x',
        platform: 'FACEBOOK',
        isReply: false,
        contextLevel: 'post_caption',
        pageName: 'Shop',
        postCaption: 'New saree',
      }),
    ).toMatchObject({ shop_page_name: 'Shop', shop_post_caption: 'New saree' });
  });

  it('every question is a noul about `comment`; version is separate from the chat prompt', () => {
    for (const q of Object.values(JEV_QUESTIONS)) {
      expect(q.type).toBe('noul');
      expect(q.instructions).toContain('`comment`');
    }
    expect(JEV_PROMPT_VERSION).toBe('jev-v1');
    expect(JEV_PROMPT_VERSION).not.toBe(PROMPT_VERSION);
  });
});

describe('jevReasoning', () => {
  it('names the two strongest Nouls, ≤ 280 chars', () => {
    const text = jevReasoning({ ...NO, other_seller: 0.93 });
    expect(text).toBe('jev: other_seller 0.93, unrelated_spam 0.10');
    expect(text.length).toBeLessThanOrEqual(280);
  });
});

describe('guessCommentLanguage', () => {
  it.each([
    ['এই শাড়িটার দাম কত?', 'bn'],
    ['apu dam koto?', 'banglish'],
    ['Is this available in size 40?', 'en'],
    ['😍😍', 'en'],
    ['Aro chaile আমাদের page e asen', 'banglish'],
  ] as const)('%s → %s', (text, language) => {
    expect(guessCommentLanguage(text)).toBe(language);
  });

  it('matches ≥ 90 % of the golden fixture labels', () => {
    const hits = GOLDEN_COMMENTS.filter(
      (c) => guessCommentLanguage(c.text) === c.language,
    ).length;
    expect(hits / GOLDEN_COMMENTS.length).toBeGreaterThanOrEqual(0.9);
  });
});
