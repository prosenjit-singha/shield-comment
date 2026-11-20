import { domainToASCII } from 'node:url';

/**
 * Text normalisers of the static rules (M6-T1; D5/D6 answered 2026-11-20). Pure: the policy API
 * stores keywords in this form and the rule engine (M6-T2) normalises comment text the same way,
 * so a keyword matches as a plain substring.
 */

/** D5: NFKC, lower-case, whitespace runs → one space, trimmed. Bangla stays as typed. */
export function normalizeRuleText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
}

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(
  `^(?:${LABEL}\\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$`,
);

/**
 * D6 allow-list entry → lower-case ASCII hostname (Unicode → punycode, a leading `www.` and a
 * trailing dot dropped), or `null` when it is not a domain name (URL, IP, single label, …).
 */
export function normalizeDomain(input: string): string | null {
  // `domainToASCII` parses a URL host (`a.com/x` → `a.com`): refuse URL parts up front.
  if (/[\s/?#@:\\%]/u.test(input.trim())) return null;
  let domain = domainToASCII(input.trim().toLowerCase().replace(/\.$/, ''));
  if (domain.startsWith('www.')) domain = domain.slice(4);
  return domain.length <= 253 && HOSTNAME.test(domain) ? domain : null;
}
