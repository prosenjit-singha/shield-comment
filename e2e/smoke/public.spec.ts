import { expect, test, type Page } from '@playwright/test';
import { smokeSettings } from './env.js';

/**
 * Public read-only checks (also the only ones on production with SMOKE_ALLOW_PRODUCTION=1). GETs only,
 * through the browser: Chromium resolves `*.localhost` (local compose), Node's resolver does not.
 */
const smoke = smokeSettings();
const https = (url: string) => url.startsWith('https:');

/** Raw response (status, every header, body as served, before any hydration). */
async function get(page: Page, url: string) {
  const response = await page.goto(url);
  if (!response) throw new Error(`No response for ${url}`);
  return { status: response.status(), headers: await response.allHeaders(), body: await response.text() };
}

/** App origins (client server + admin nginx, M9-T8). CSP is Report-Only until the D12 switch. */
function expectAppHeaders(headers: Record<string, string>, origin: string): void {
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['content-security-policy-report-only']).toContain("frame-ancestors 'none'");
  if (https(origin)) expect(headers['strict-transport-security']).toContain('max-age=');
  else expect(headers['strict-transport-security']).toBeUndefined();
}

test('API liveness is up with the Helmet headers', async ({ page }) => {
  // Never /api/health: it queries the DB and keeps Neon awake.
  const { status, headers } = await get(page, `${smoke.apiUrl}/api/health/live`);
  expect(status).toBe(200);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('SAMEORIGIN');
  expect(headers['cross-origin-resource-policy']).toBe('same-site');
  expect(headers['content-security-policy']).toContain("default-src 'self'");
  expect(headers['x-powered-by']).toBeUndefined();
  if (https(smoke.apiUrl)) expect(headers['strict-transport-security']).toContain('max-age=');
});

test('client and admin health checks answer 200', async ({ page }) => {
  for (const origin of [smoke.clientUrl, smoke.adminUrl]) {
    expect((await get(page, `${origin}/healthz`)).status, origin).toBe(200);
  }
});

for (const { path, lang, h1 } of [
  { path: '/', lang: 'en', h1: 'Stop losing Facebook &amp; Instagram ad sales' },
  { path: '/bn', lang: 'bn', h1: 'স্ক্যাম কমেন্টে ফেসবুক ও ইনস্টাগ্রাম অ্যাডের সেল' },
]) {
  test(`landing ${path} serves SEO-ready HTML with the app headers`, async ({ page }) => {
    const { status, headers, body } = await get(page, `${smoke.clientUrl}${path}`);
    expect(status).toBe(200);
    expect(headers['content-type']).toContain('text/html');
    expectAppHeaders(headers, smoke.clientUrl);
    // Lower case: React writes `hrefLang`; the Bangla text is unaffected.
    const html = body.toLowerCase();
    const canonical = `${smoke.clientUrl}${path}`;
    expect(html).toContain(`<html lang="${lang}"`);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${h1.toLowerCase()}`));
    expect(html).toContain('id="pricing"');
    expect(html).toContain('৳');
    expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
    expect(html).toContain(`<meta property="og:url" content="${canonical}"`);
    for (const og of ['og:title', 'og:description', 'og:image']) {
      expect(html).toMatch(new RegExp(`<meta property="${og}" content="[^"]+"`));
    }
    expect(html).toContain(`<link rel="alternate" hreflang="en" href="${smoke.clientUrl}/"`);
    expect(html).toContain(`<link rel="alternate" hreflang="bn" href="${smoke.clientUrl}/bn"`);
  });
}

test('robots.txt and sitemap.xml point at this origin', async ({ page }) => {
  const robots = await get(page, `${smoke.clientUrl}/robots.txt`);
  expect(robots.status).toBe(200);
  const rules = robots.body;
  expect(rules).toContain('User-agent: *');
  expect(rules).toContain('Disallow: /api/');
  expect(rules).toContain(`Sitemap: ${smoke.clientUrl}/sitemap.xml`);

  const sitemap = await get(page, `${smoke.clientUrl}/sitemap.xml`);
  expect(sitemap.status).toBe(200);
  expect(sitemap.headers['content-type']).toContain('xml');
  const xml = sitemap.body;
  expect(xml).toContain(`<loc>${smoke.clientUrl}/</loc>`);
  expect(xml).toContain(`<loc>${smoke.clientUrl}/bn</loc>`);
});

test('sign-in pages carry the app headers on both origins', async ({ page }) => {
  for (const url of [`${smoke.clientUrl}/login`, `${smoke.adminUrl}/admin/login`]) {
    const { status, headers } = await get(page, url);
    expect(status, url).toBe(200);
    expectAppHeaders(headers, url);
  }
});
