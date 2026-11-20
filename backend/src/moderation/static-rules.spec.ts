import { MAX_RULE_MATCH_CHARS } from './moderation.constants.js';
import type { StaticRules } from './moderation.queries.js';
import { normalizeRuleText } from './rule-text.js';
import { matchStaticRules, rulesForPlan } from './static-rules.js';

const rules = (patch: Partial<StaticRules> = {}): StaticRules => ({
  blockedKeywords: [],
  blockUrls: true,
  blockPhoneNumbers: true,
  allowedDomains: [],
  actions: { keyword: 'HIDE', url: 'HIDE', phone: 'HIDE' },
  ...patch,
});
const keywords = (...list: string[]) =>
  rules({
    blockedKeywords: list.map(normalizeRuleText),
    blockUrls: false,
    blockPhoneNumbers: false,
  });

describe('matchStaticRules (M6-T2)', () => {
  it('null / blank text → no match', () => {
    expect(matchStaticRules(null, rules())).toBeNull();
    expect(matchStaticRules('  \n ', rules())).toBeNull();
    expect(matchStaticRules('price koto?', rules())).toBeNull();
  });

  describe('keywords (D5)', () => {
    it('case-insensitive substring, phrases, whitespace collapsed', () => {
      expect(
        matchStaticRules('Get FREE Cashback now', keywords('cashback')),
      ).toEqual({
        kind: 'keyword',
        value: 'cashback',
      });
      expect(
        matchStaticRules('inbox   KORUN\nnow', keywords('inbox korun')),
      ).toEqual({ kind: 'keyword', value: 'inbox korun' });
    });

    it('NFKC folds full-width letters', () => {
      expect(
        matchStaticRules('ＣＡＳＨＢＡＣＫ', keywords('cashback')),
      ).toMatchObject({
        kind: 'keyword',
      });
    });

    it('Bangla matches as typed', () => {
      expect(
        matchStaticRules('ভাই বিকাশে টাকা পাঠান', keywords('বিকাশে টাকা')),
      ).toEqual({ kind: 'keyword', value: 'বিকাশে টাকা' });
      expect(matchStaticRules('bikash e taka', keywords('বিকাশ'))).toBeNull();
    });

    it('keyword wins over URL and phone', () => {
      const r = rules({ blockedKeywords: ['offer'] });
      expect(matchStaticRules('offer bit.ly/x 01712345678', r)?.kind).toBe(
        'keyword',
      );
    });
  });

  describe('URLs (D6)', () => {
    it.each([
      ['click https://evil.example/claim now', 'https://evil.example/claim'],
      ['go to http://Evil.com.', 'http://Evil.com'],
      ['visit www.bonus-offer.net today', 'www.bonus-offer.net'],
      ['bit.ly/x', 'bit.ly/x'],
      ['dekhun bkash-bonus.com', 'bkash-bonus.com'],
      ['লিংকেevil.xyz/a এ যান', 'evil.xyz/a'],
      ['(see shop.example.org/p?id=1)', 'shop.example.org/p?id=1'],
    ])('%s → %s', (text, value) => {
      expect(matchStaticRules(text, rules())).toEqual({ kind: 'url', value });
    });

    it('URL wins over phone', () => {
      expect(matchStaticRules('01712345678 evil.com/x', rules())?.kind).toBe(
        'url',
      );
    });

    it.each([
      'dam koto.ami nibo',
      'price 1.250 taka',
      'mail me at rahim@gmail.com',
      'ok.thanks vai',
    ])('not a URL: %s', (text) => {
      expect(
        matchStaticRules(text, rules({ blockPhoneNumbers: false })),
      ).toBeNull();
    });

    it('allow-list: the host or a subdomain passes, look-alikes do not', () => {
      const r = rules({ allowedDomains: ['myshop.com.bd'] });
      expect(
        matchStaticRules('order: https://myshop.com.bd/p/1', r),
      ).toBeNull();
      expect(matchStaticRules('order: www.myshop.com.bd', r)).toBeNull();
      expect(matchStaticRules('order: shop.myshop.com.bd/p', r)).toBeNull();
      expect(
        matchStaticRules('fake: https://myshop.com.bd.evil.io/', r)?.kind,
      ).toBe('url');
      expect(matchStaticRules('fake: notmyshop.com.bd/x', r)?.kind).toBe('url');
    });

    it('Meta domains are always allowed (with subdomains)', () => {
      for (const text of [
        'https://facebook.com/shop',
        'm.facebook.com/story.php?id=1',
        'www.instagram.com/p/abc',
        'https://m.me/shop',
      ]) {
        expect(matchStaticRules(text, rules())).toBeNull();
      }
      expect(matchStaticRules('facebook.com.evil.io/x', rules())?.kind).toBe(
        'url',
      );
    });

    it('allowed then blocked: the first blocked URL is returned', () => {
      expect(
        matchStaticRules('see facebook.com/a then evil.com/b', rules()),
      ).toEqual({ kind: 'url', value: 'evil.com/b' });
    });

    it('switched off → no URL match', () => {
      expect(
        matchStaticRules('https://evil.com', rules({ blockUrls: false })),
      ).toBeNull();
    });

    it('a long URL is cut to MAX_RULE_MATCH_CHARS', () => {
      const url = `https://evil.com/${'a'.repeat(300)}`;
      expect(matchStaticRules(url, rules())?.value).toHaveLength(
        MAX_RULE_MATCH_CHARS,
      );
    });
  });

  describe('BD phone numbers (D6)', () => {
    it.each([
      ['call 01712345678', '01712345678'],
      ['+8801712345678 e bKash', '+8801712345678'],
      ['8801912345678', '8801912345678'],
      ['+880 1712-345678 number', '+880 1712-345678'],
      ['01712-345678', '01712-345678'],
      ['017 1234 5678', '017 1234 5678'],
      ['নম্বর ০১৭১২৩৪৫৬৭৮', '০১৭১২৩৪৫৬৭৮'],
      ['+৮৮০১৩১২৩৪৫৬৭৮', '+৮৮০১৩১২৩৪৫৬৭৮'],
    ])('%s → %s', (text, value) => {
      expect(matchStaticRules(text, rules())).toEqual({ kind: 'phone', value });
    });

    it.each([
      '01212345678', // 012 is not a mobile prefix
      '0171234567', // 10 digits
      '017123456789', // 12 digits
      'order id 9901712345678',
      'price 1250 taka',
    ])('not a BD mobile: %s', (text) => {
      expect(matchStaticRules(text, rules())).toBeNull();
    });

    it('switched off → no phone match', () => {
      expect(
        matchStaticRules('01712345678', rules({ blockPhoneNumbers: false })),
      ).toBeNull();
    });
  });
});

describe('rulesForPlan (plan without the feature → saved rules stop running)', () => {
  const saved = rules({ blockedKeywords: [normalizeRuleText('cashback')] });
  const text = 'cashback 01712345678 https://scam.example.com';

  it('runs every saved rule when the plan has both features', () => {
    const plan = { customBlocklist: true, autoHideScams: true };
    expect(matchStaticRules(text, rulesForPlan(saved, plan))?.kind).toBe(
      'keyword',
    );
  });

  it('drops keywords without customBlocklist, keeps URL + phone', () => {
    const plan = { customBlocklist: false, autoHideScams: true };
    expect(rulesForPlan(saved, plan).blockedKeywords).toEqual([]);
    expect(matchStaticRules(text, rulesForPlan(saved, plan))?.kind).toBe('url');
  });

  it('drops URL + phone without autoHideScams, keeps keywords', () => {
    const plan = { customBlocklist: true, autoHideScams: false };
    expect(
      matchStaticRules(
        '01712345678 https://scam.example.com',
        rulesForPlan(saved, plan),
      ),
    ).toBeNull();
    expect(matchStaticRules(text, rulesForPlan(saved, plan))?.kind).toBe(
      'keyword',
    );
  });

  it('runs nothing with no live plan, and keeps the saved rules untouched', () => {
    const none = { customBlocklist: false, autoHideScams: false };
    expect(matchStaticRules(text, rulesForPlan(saved, none))).toBeNull();
    expect(saved.blockedKeywords).toEqual(['cashback']);
    expect(saved.blockUrls).toBe(true);
  });
});
