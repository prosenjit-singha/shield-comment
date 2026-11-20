import { MAX_RULE_MATCH_CHARS, type RuleKind } from './moderation.constants.js';
import type { StaticRules } from './moderation.queries.js';
import { normalizeRuleText } from './rule-text.js';

/**
 * Static rule engine (M6-T2; Module 6 D2/D5/D6 answered 2026-11-20). Pure, no I/O: the worker runs
 * it before the AI classifier and skips the LLM call on a match.
 *
 * Order: keyword → URL → BD phone; the first hit wins.
 * - keyword (D5): case-insensitive substring of `normalizeRuleText(text)` (keywords are stored in
 *   that form). Bangla matches as typed.
 * - URL (D6, only when `blockUrls`): `http(s)://…`, `www.…`, or a bare `host.tld` that has a path
 *   (`bit.ly/x`) or a common TLD (`COMMON_TLDS`, so Banglish run-ons like `koto.ami` never match).
 *   E-mail addresses are not URLs. Hosts on the allow-list (equal or a subdomain) and the Meta
 *   domains (`ALWAYS_ALLOWED_DOMAINS`) are let through. Unicode-only hosts (`.বাংলা`) are not
 *   detected.
 * - phone (D6, only when `blockPhoneNumbers`): BD mobile `(?:\+?88)?01[3-9]\d{8}`, digits may be
 *   Bangla (০–৯) and separated by single spaces / dashes (`+880 1712-345678`).
 *
 * `value` = the matched keyword (normalised) / URL / phone as written, cut to
 * `MAX_RULE_MATCH_CHARS`.
 */
export interface StaticRuleMatch {
  kind: RuleKind;
  value: string;
}

/** Meta's own domains: always allowed (D6), with their subdomains (`m.facebook.com`). */
export const ALWAYS_ALLOWED_DOMAINS = [
  'facebook.com',
  'instagram.com',
  'm.me',
] as const;

/** TLDs a bare host (no scheme, no `www.`, no path) is accepted with. */
const COMMON_TLDS = new Set([
  'com',
  'net',
  'org',
  'info',
  'biz',
  'xyz',
  'top',
  'site',
  'online',
  'shop',
  'store',
  'live',
  'link',
  'click',
  'io',
  'co',
  'me',
  'ly',
  'app',
  'bd',
]);

const URL_PATTERN =
  /(?<![\w@.-])(?:(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"'`]*)?)/giu;
const TRAILING_PUNCTUATION = /[.,!?;:)\]}'"]+$/u;
const BD_PHONE_PATTERN =
  /(?<!\d)(?:\+?88[\s-]?)?0[\s-]?1[3-9](?:[\s-]?\d){8}(?!\d)/u;
const BANGLA_DIGITS = /[০-৯]/gu;

export function matchStaticRules(
  text: string | null,
  rules: StaticRules,
): StaticRuleMatch | null {
  if (text === null) return null;
  const normalized = normalizeRuleText(text);
  if (normalized.length === 0) return null;

  const keyword = rules.blockedKeywords.find((k) => normalized.includes(k));
  if (keyword !== undefined) return { kind: 'keyword', value: cut(keyword) };

  // URL + phone values keep the comment's case (NFKC folds full-width evasions).
  const nfkc = text.normalize('NFKC');
  if (rules.blockUrls) {
    const url = findBlockedUrl(nfkc, rules.allowedDomains);
    if (url !== null) return { kind: 'url', value: cut(url) };
  }
  if (rules.blockPhoneNumbers) {
    // ০–৯ → 0–9: one UTF-16 unit each, so indexes still point into `nfkc`.
    const ascii = nfkc.replace(BANGLA_DIGITS, (d) =>
      String(d.charCodeAt(0) - 0x09e6),
    );
    const phone = BD_PHONE_PATTERN.exec(ascii);
    if (phone) {
      return {
        kind: 'phone',
        value: cut(nfkc.slice(phone.index, phone.index + phone[0].length)),
      };
    }
  }
  return null;
}

function findBlockedUrl(text: string, allowed: string[]): string | null {
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(TRAILING_PUNCTUATION, '');
    const explicit = /^(?:https?:\/\/|www\.)/iu.test(url);
    const host = hostOf(url);
    if (host === null) continue;
    if (!explicit && !url.includes('/')) {
      const tld = host.slice(host.lastIndexOf('.') + 1);
      if (!COMMON_TLDS.has(tld)) continue;
    }
    if (isAllowed(host, allowed)) continue;
    return url;
  }
  return null;
}

/** Lower-case ASCII host without `www.` (`URL` handles userinfo, ports and IDN). */
function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(
      /^https?:\/\//iu.test(url) ? url : `http://${url}`,
    );
    const host = hostname.replace(/\.$/u, '');
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function isAllowed(host: string, allowed: readonly string[]): boolean {
  return [...ALWAYS_ALLOWED_DOMAINS, ...allowed].some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
}

function cut(value: string): string {
  return Array.from(value).slice(0, MAX_RULE_MATCH_CHARS).join('');
}
