import {
  bilingualEmail,
  EmailLinkError,
  type EmailBlock,
} from './bilingual-email.js';

const APP = 'http://app.localhost:5174';
const EN: EmailBlock = {
  subject: 'New reply to your ticket',
  lines: ['Support answered "Refund <please>" in Shop & Co.'],
  cta: { label: 'Open ticket', url: `${APP}/support?ticket=42&x=1` },
};
const BN: EmailBlock = {
  subject: 'আপনার টিকিটে নতুন উত্তর',
  lines: ['সাপোর্ট টিম উত্তর দিয়েছে।'],
  cta: { label: 'টিকিট খুলুন', url: `${APP}/support?ticket=42` },
};

describe('bilingualEmail', () => {
  it('puts English first, then Bangla, in subject, HTML and text', () => {
    const email = bilingualEmail({ en: EN, bn: BN }, APP);
    expect(email.subject).toBe(
      'New reply to your ticket · আপনার টিকিটে নতুন উত্তর',
    );
    expect(email.html.indexOf('lang="en"')).toBeLessThan(
      email.html.indexOf('lang="bn"'),
    );
    expect(email.html).toContain('<meta charset="utf-8">');
    expect(email.html).toContain('সাপোর্ট টিম উত্তর দিয়েছে।');
    expect(email.text).toBe(
      [
        'New reply to your ticket',
        'Support answered "Refund <please>" in Shop & Co.',
        `Open ticket: ${APP}/support?ticket=42&x=1`,
        '---',
        'আপনার টিকিটে নতুন উত্তর',
        'সাপোর্ট টিম উত্তর দিয়েছে।',
        `টিকিট খুলুন: ${APP}/support?ticket=42`,
      ].join('\n\n') + '\n',
    );
  });

  it('escapes every value in the HTML', () => {
    const email = bilingualEmail(
      {
        en: {
          subject: '<b>x</b>',
          lines: [`<script>alert('x')</script> & "q"`],
          cta: { label: '<i>go</i>', url: `${APP}/a?b="c"` },
        },
        bn: { subject: 'বাংলা', lines: [] },
      },
      APP,
    );
    expect(email.html).not.toContain('<script>');
    expect(email.html).not.toContain('<b>x</b>');
    expect(email.html).not.toContain('<i>go</i>');
    expect(email.html).toContain(
      '&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot;',
    );
    expect(email.html).toContain(`href="${APP}/a?b=&quot;c&quot;"`);
    expect(email.html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('keeps the subject on one line', () => {
    const email = bilingualEmail(
      {
        en: { subject: 'Hi\r\nBcc: x@y.z', lines: [] },
        bn: { subject: 'হ্যালো', lines: [] },
      },
      APP,
    );
    expect(email.subject).toBe('Hi Bcc: x@y.z · হ্যালো');
  });

  it.each([
    ['another host', 'https://evil.example/support'],
    ['a prefix look-alike', 'http://app.localhost:5174.evil.example/support'],
    ['another port', 'http://app.localhost:5175/support'],
    ['another scheme', 'https://app.localhost:5174/support'],
    ['javascript:', "javascript:alert('x')"],
    ['a relative path', '/support'],
  ])('refuses a CTA to %s', (_name, url) => {
    expect(() =>
      bilingualEmail({ en: { ...EN, cta: { label: 'Go', url } }, bn: BN }, APP),
    ).toThrow(EmailLinkError);
    expect(() =>
      bilingualEmail({ en: EN, bn: { ...BN, cta: { label: 'Go', url } } }, APP),
    ).toThrow(EmailLinkError);
  });

  it('keeps a CTA inside the base path of CLIENT_APP_URL', () => {
    const base = 'https://example.com/app/';
    const block = (url: string): EmailBlock => ({
      subject: 's',
      lines: [],
      cta: { label: 'Go', url },
    });
    expect(() =>
      bilingualEmail(
        { en: block('https://example.com/app/support'), bn: block(base) },
        base,
      ),
    ).not.toThrow();
    expect(() =>
      bilingualEmail(
        { en: block('https://example.com/application'), bn: block(base) },
        base,
      ),
    ).toThrow(EmailLinkError);
  });
});
