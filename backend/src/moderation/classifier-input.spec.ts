import * as classifierInputModule from './classifier-input.js';
import {
  type ClassifierInput,
  MAX_CAPTION_CHARS,
  MAX_COMMENT_CHARS,
  MAX_PAGE_NAME_CHARS,
  normalizeClassifierInput,
  normalizeText,
} from './classifier-input.js';
import * as constantsModule from './moderation.constants.js';
import {
  CONTEXT_LEVELS,
  isContextLevel,
  isModerationCategory,
  MODERATION_CATEGORIES,
} from './moderation.constants.js';

const base: ClassifierInput = {
  text: 'price koto?',
  platform: 'FACEBOOK',
  isReply: false,
  contextLevel: 'comment_only',
};

describe('moderation constants', () => {
  it('lists the five categories and three D8 levels', () => {
    expect(MODERATION_CATEGORIES).toEqual([
      'SAFE_INQUIRY',
      'COMPETITOR_POACH',
      'SCAM_PHISHING',
      'SPAM_IRRELEVANT',
      'ABUSIVE_TOXIC',
    ]);
    expect(CONTEXT_LEVELS).toEqual([
      'comment_only',
      'page_name',
      'post_caption',
    ]);
    expect(isModerationCategory('SCAM_PHISHING')).toBe(true);
    expect(isModerationCategory('scam_phishing')).toBe(false);
    expect(isContextLevel('page_name')).toBe(true);
    expect(isContextLevel('everything')).toBe(false);
  });

  it('has no credit cost per level any more (PW-D1: every level counts 1 comment)', () => {
    expect('CONTEXT_LEVEL_CREDITS' in constantsModule).toBe(false);
    expect('creditCostForLevel' in constantsModule).toBe(false);
  });
});

describe('normalizeText', () => {
  it('trims and collapses every whitespace run to one space', () => {
    expect(normalizeText('  price\n\n koto?\t XL   ase  ', 100)).toBe(
      'price koto? XL ase',
    );
  });

  it('caps at the limit in code points and keeps emoji whole', () => {
    expect(normalizeText('a'.repeat(1_500), 1_000)).toHaveLength(1_000);
    expect(normalizeText('ab😀cd', 3)).toBe('ab😀');
  });

  it('normalises to NFC (decomposed Bangla vowel signs compose)', () => {
    const decomposed = '\u0995\u09c7\u09be'; // ka + e-kar + aa-kar
    expect(normalizeText(decomposed, 10)).toBe('\u0995\u09cb'); // ko
  });
});

describe('normalizeClassifierInput', () => {
  it('returns null for empty or whitespace-only text', () => {
    expect(normalizeClassifierInput({ ...base, text: '' })).toBeNull();
    expect(normalizeClassifierInput({ ...base, text: ' \n\t ' })).toBeNull();
  });

  it(`truncates the comment at ${MAX_COMMENT_CHARS} chars`, () => {
    const result = normalizeClassifierInput({
      ...base,
      text: `${'x'.repeat(MAX_COMMENT_CHARS)}TAIL`,
    });
    expect(result?.text).toBe('x'.repeat(MAX_COMMENT_CHARS));
  });

  it('comment_only sends no Page name and no caption, even when given', () => {
    expect(
      normalizeClassifierInput({
        ...base,
        isReply: true,
        pageName: 'Nakshi',
        postCaption: 'Eid sale',
      }),
    ).toEqual({
      text: 'price koto?',
      platform: 'FACEBOOK',
      isReply: true,
      contextLevel: 'comment_only',
    });
  });

  it('page_name adds only the Page name', () => {
    expect(
      normalizeClassifierInput({
        ...base,
        contextLevel: 'page_name',
        pageName: '  Nakshi \n Kantha ',
        postCaption: 'Eid sale',
      }),
    ).toEqual({
      text: 'price koto?',
      platform: 'FACEBOOK',
      isReply: false,
      contextLevel: 'page_name',
      pageName: 'Nakshi Kantha',
    });
  });

  it('post_caption adds Page name + caption, caption capped', () => {
    const result = normalizeClassifierInput({
      ...base,
      platform: 'INSTAGRAM',
      contextLevel: 'post_caption',
      pageName: 'N'.repeat(MAX_PAGE_NAME_CHARS + 50),
      postCaption: `Eid\n\nsale ${'c'.repeat(MAX_CAPTION_CHARS)}`,
    });
    expect(result?.contextLevel).toBe('post_caption');
    expect(result?.pageName).toHaveLength(MAX_PAGE_NAME_CHARS);
    expect(result?.postCaption).toHaveLength(MAX_CAPTION_CHARS);
    expect(result?.postCaption?.startsWith('Eid sale c')).toBe(true);
  });

  it('drops to the level of the data actually sent', () => {
    expect(
      normalizeClassifierInput({
        ...base,
        contextLevel: 'post_caption',
        pageName: 'Nakshi',
        postCaption: '   ',
      })?.contextLevel,
    ).toBe('page_name');
    expect(
      normalizeClassifierInput({
        ...base,
        contextLevel: 'post_caption',
        postCaption: 'Eid sale',
      }),
    ).toMatchObject({ contextLevel: 'post_caption', postCaption: 'Eid sale' });
    expect(
      normalizeClassifierInput({
        ...base,
        contextLevel: 'page_name',
        pageName: null,
      })?.contextLevel,
    ).toBe('comment_only');
  });

  it('ignores author fields and unknown keys (D8: never the author)', () => {
    const withAuthor = {
      ...base,
      authorName: 'Rahim Uddin',
      authorId: '1234567890',
      fromId: '42',
    } as ClassifierInput;
    const result = normalizeClassifierInput(withAuthor);
    expect(Object.keys(result ?? {}).sort()).toEqual([
      'contextLevel',
      'isReply',
      'platform',
      'text',
    ]);
    expect(JSON.stringify(result)).not.toContain('Rahim');
  });

  it('falls back to comment_only for an unknown level', () => {
    expect(
      normalizeClassifierInput({
        ...base,
        contextLevel: 'everything' as ClassifierInput['contextLevel'],
        pageName: 'Nakshi',
      })?.contextLevel,
    ).toBe('comment_only');
  });
});

describe('classifier input without credits (PW-T4)', () => {
  it('normalizes to the data sent only: no credits field, no cost helper', () => {
    expect('classificationCreditCost' in classifierInputModule).toBe(false);
    for (const input of [
      base,
      { ...base, contextLevel: 'page_name' as const, pageName: 'Nakshi' },
      {
        ...base,
        contextLevel: 'post_caption' as const,
        pageName: 'Nakshi',
        postCaption: 'Eid sale',
      },
    ]) {
      const normalized = normalizeClassifierInput(input);
      expect(normalized).not.toBeNull();
      expect(normalized).not.toHaveProperty('credits');
    }
  });
});
