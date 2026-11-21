import { expect, test, type Page, type Response } from '@playwright/test';
import { smokeSettings, type Credentials } from './env.js';

/**
 * Signed-in read-only walk (client owner + super admin). The only POSTs are sign-in and sign-out: a
 * same-origin `fetch` inside the page (the browser sets `Origin` and keeps the cookies like the app's
 * own form), passed as an evaluate argument so the password never appears in a step title; no
 * artifacts are kept (project `use`). Clicks that change data: none.
 */
const smoke = smokeSettings();

const CLIENT_SCREENS = [
  { path: '/dashboard', heading: 'Dashboard' },
  { path: '/comments', heading: 'Comments' },
  { path: '/pages', heading: 'Connected Pages' },
  { path: '/rules', heading: 'Rules' },
  { path: '/plans', heading: 'Choose the plan for your business' },
  { path: '/billing', heading: 'Billing' },
  { path: '/support', heading: 'Support' },
] as const;

const ADMIN_SCREENS = [
  { path: '/admin/dashboard', heading: 'Dashboard' },
  { path: '/admin/clients', heading: 'Clients' },
  { path: '/admin/settings', heading: 'Settings' },
  { path: '/admin/billing', heading: 'Billing' },
  { path: '/admin/promotions', heading: 'Promotions' },
  { path: '/admin/tickets', heading: 'Tickets' },
  { path: '/admin/system', heading: 'System' },
] as const;

/** Attribute names (+ SameSite value) of every Set-Cookie, without cookie values. */
async function cookieFlags(response: Response) {
  return (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'set-cookie')
    .map((header) => {
      const [pair = '', ...attributes] = header.value.split(';');
      return {
        name: pair.split('=')[0]?.trim() ?? '',
        flags: attributes
          .map((attribute) => attribute.trim().toLowerCase())
          .filter((attribute) => !attribute.includes('=') || attribute.startsWith('samesite=')),
      };
    });
}

/** Better Auth session cookies (M9-T3): HttpOnly + SameSite=Lax; Secure + `__Secure-` only on https. */
async function signIn(page: Page, origin: string, loginPath: string, who: Credentials): Promise<void> {
  await page.goto(`${origin}${loginPath}`);
  const url = `${origin}/api/auth/sign-in/email`;
  const [response] = await Promise.all([
    page.waitForResponse((candidate) => candidate.url() === url),
    post(page, url, { email: who.email, password: who.password }),
  ]);
  // Status only: the request body is never echoed.
  if (response.status() !== 200) throw new Error(`Sign-in on ${origin} answered ${response.status()}`);
  const cookies = await cookieFlags(response);
  expect(cookies.map((cookie) => cookie.name)).toContainEqual(expect.stringMatching(/session_token$/));
  const secure = origin.startsWith('https:');
  for (const { name, flags } of cookies) {
    expect(flags, name).toEqual(expect.arrayContaining(['httponly', 'samesite=lax']));
    expect(flags.includes('secure'), `${name} Secure`).toBe(secure);
    expect(name.startsWith('__Secure-'), `${name} prefix`).toBe(secure);
  }
}

/** Same-origin JSON POST from the page; returns the status only. */
function post(page: Page, url: string, body: Record<string, string>): Promise<number> {
  return page.evaluate(
    async ({ url, body }) => {
      const headers = { 'content-type': 'application/json' };
      return (await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status;
    },
    { url, body },
  );
}

async function signOut(page: Page, origin: string, protectedPath: string, loginPath: RegExp): Promise<void> {
  expect(await post(page, `${origin}/api/auth/sign-out`, {})).toBe(200);
  await page.goto(`${origin}${protectedPath}`);
  await expect(page).toHaveURL(loginPath);
}

/** Visits each screen, waits for its data, and fails on any console error or uncaught page error. */
type Screen = { readonly path: string; readonly heading: string };

async function walk(page: Page, origin: string, screens: readonly Screen[]): Promise<void> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  for (const { path, heading } of screens) {
    await test.step(path, async () => {
      errors.length = 0;
      await page.goto(`${origin}${path}`);
      await expect(page).toHaveURL(`${origin}${path}`);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(errors, `console errors on ${path}`).toEqual([]);
    });
  }
}

test.describe('signed in (read-only)', () => {
  test.skip(smoke.mode === 'public', 'Production URL: public checks only (SMOKE_ALLOW_PRODUCTION=1)');

  test('client owner sees every read-only screen without console errors', async ({ page }) => {
    if (!smoke.owner) throw new Error('owner credentials missing');
    await signIn(page, smoke.clientUrl, '/login', smoke.owner);
    await walk(page, smoke.clientUrl, CLIENT_SCREENS);
    await signOut(page, smoke.clientUrl, '/dashboard', /\/login\?redirect=/);
  });

  test('super admin sees every read-only screen without console errors', async ({ page }) => {
    if (!smoke.superAdmin) throw new Error('super admin credentials missing');
    await signIn(page, smoke.adminUrl, '/admin/login', smoke.superAdmin);
    await walk(page, smoke.adminUrl, ADMIN_SCREENS);
    await signOut(page, smoke.adminUrl, '/admin/dashboard', /\/admin\/login/);
  });
});
