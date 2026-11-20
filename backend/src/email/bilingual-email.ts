export interface EmailBlock {
  subject: string;
  /** Plain-text paragraphs; every value is HTML-escaped. */
  lines: readonly string[];
  /** Button link; must point into the client app (`CLIENT_APP_URL`). */
  cta?: { label: string; url: string };
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export class EmailLinkError extends Error {
  constructor() {
    super('Email links must start with CLIENT_APP_URL');
    this.name = 'EmailLinkError';
  }
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

/** Same origin as `clientAppUrl` and inside its path (a string prefix would allow `…5174.evil.com`). */
function assertClientLink(url: string, clientAppUrl: string): void {
  const base = new URL(clientAppUrl);
  let link: URL;
  try {
    link = new URL(url);
  } catch {
    throw new EmailLinkError();
  }
  const basePath = base.pathname.replace(/\/+$/, '');
  if (
    link.origin !== base.origin ||
    !(link.pathname === basePath || link.pathname.startsWith(`${basePath}/`))
  ) {
    throw new EmailLinkError();
  }
}

const oneLine = (value: string) => value.replace(/[\r\n]+/g, ' ').trim();

function htmlBlock(block: EmailBlock, lang: 'en' | 'bn'): string {
  const lines = block.lines
    .map(
      (line) =>
        `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#333">${escapeHtml(line)}</p>`,
    )
    .join('');
  const cta = block.cta
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(block.cta.url)}" style="display:inline-block;padding:10px 20px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-size:15px">${escapeHtml(block.cta.label)}</a></p>`
    : '';
  return `<div lang="${lang}"><h1 style="margin:0 0 16px;font-size:20px;color:#111">${escapeHtml(block.subject)}</h1>${lines}${cta}</div>`;
}

function textBlock(block: EmailBlock): string {
  const parts = [block.subject, ...block.lines];
  if (block.cta) parts.push(`${block.cta.label}: ${block.cta.url}`);
  return parts.join('\n\n');
}

/**
 * Module 7 reading 10: one email, English then Bangla, HTML (inline styles) + plain text.
 * Throws `EmailLinkError` when a CTA leaves the client app. Callers keep comment text and
 * author ids out of `lines`.
 */
export function bilingualEmail(
  content: { en: EmailBlock; bn: EmailBlock },
  clientAppUrl: string,
): EmailContent {
  for (const block of [content.en, content.bn]) {
    if (block.cta) assertClientLink(block.cta.url, clientAppUrl);
  }
  const subject = oneLine(`${content.en.subject} · ${content.bn.subject}`);
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f4f4f5;font-family:Arial,'Noto Sans Bengali',sans-serif">` +
    `<div style="max-width:560px;margin:0 auto;padding:24px;border-radius:16px;background:#fff">` +
    htmlBlock(content.en, 'en') +
    `<hr style="margin:24px 0;border:0;border-top:1px solid #e4e4e7">` +
    htmlBlock(content.bn, 'bn') +
    `</div></body></html>`;
  const text = `${textBlock(content.en)}\n\n---\n\n${textBlock(content.bn)}\n`;
  return { subject, html, text };
}
