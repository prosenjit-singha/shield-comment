import { normalizeDomain, normalizeRuleText } from './rule-text.js';

describe('normalizeRuleText (D5)', () => {
  it.each([
    ['  Free   BKASH\n Offer ', 'free bkash offer'],
    ['ＢＫＡＳＨ', 'bkash'], // full-width → NFKC
    ['ﬁle', 'file'], // ligature → NFKC
    ['বিকাশ নম্বর', 'বিকাশ নম্বর'], // Bangla as typed, NBSP collapsed
    ['   ', ''],
  ])('%j → %j', (input, expected) => {
    expect(normalizeRuleText(input)).toBe(expected);
  });
});

describe('normalizeDomain (D6)', () => {
  it.each([
    ['Shop.Example.COM', 'shop.example.com'],
    [' www.example.com. ', 'example.com'],
    ['daraz.com.bd', 'daraz.com.bd'],
    ['বাংলা.বাংলা', 'xn--54b7fta0cc.xn--54b7fta0cc'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeDomain(input)).toBe(expected);
  });

  it.each([
    'https://example.com',
    'example.com/path',
    'a?b.com',
    'user@example.com',
    'localhost',
    '1.2.3.4',
    '-bad.com',
    'exa mple.com',
    '',
    `${'a'.repeat(64)}.com`,
  ])('rejects %j', (input) => {
    expect(normalizeDomain(input)).toBeNull();
  });
});
