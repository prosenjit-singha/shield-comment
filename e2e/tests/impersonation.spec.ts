import { expect, test, type Page } from '@playwright/test';
import { env, runIdentity } from '../src/env.js';
import { impersonationAuditCount } from '../src/stack.js';

/**
 * Module 3 gate item 3: 1-click "Login as Client" from admin/ lands on client/ /dashboard with the
 * impersonation banner (M1-T3 token → M2-T4 button → M2-T13 /impersonate → M3-T9 banner).
 */
const identity = runIdentity();

const copy = {
  en: {
    bannerTitle: 'Admin Impersonation Mode',
    bannerRealChanges: 'Changes you make here are real.',
    exit: 'Exit impersonation',
    ended: 'You can close this tab',
  },
  bn: {
    bannerTitle: 'অ্যাডমিন ইমপারসোনেশন মোড',
    bannerRealChanges: 'এখানে করা পরিবর্তনগুলো আসল।',
    exit: 'ইমপারসোনেশন থেকে বের হন',
    ended: 'এখন এই ট্যাবটি বন্ধ করতে পারেন',
  },
} as const;

async function signInToAdmin(page: Page): Promise<void> {
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(identity.superAdmin.email);
  await page.getByLabel('Password').fill(env.superAdminPassword);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).not.toHaveURL(/\/admin\/login/);
}

for (const lang of ['en', 'bn'] as const) {
  test(`Login as Client opens the client dashboard with the impersonation banner (${lang})`, async ({
    page,
    context,
  }) => {
    const text = copy[lang];
    // The client reads its language from the `shield-lang` cookie (default en).
    if (lang === 'bn') await context.addCookies([{ name: 'shield-lang', value: 'bn', url: env.clientUrl }]);
    const auditBefore = await impersonationAuditCount(identity);

    await signInToAdmin(page);
    await page.goto(`/admin/clients?q=${encodeURIComponent(identity.owner.email)}`);
    const loginAs = page.getByRole('button', { name: `Login as Client: ${identity.owner.workspaceName}` });
    await expect(loginAs).toBeVisible();

    // The button opens the tab synchronously in the click, then points it at /impersonate?token=….
    const tabOpened = context.waitForEvent('page');
    await loginAs.click();
    const tab = await tabOpened;
    const visited: string[] = [];
    tab.on('framenavigated', (frame) => {
      if (frame === tab.mainFrame()) visited.push(frame.url());
    });
    const exchange = tab.waitForResponse(
      (res) => res.url() === `${env.clientUrl}/api/auth/impersonate-exchange` && res.request().method() === 'POST',
    );

    expect((await exchange).status()).toBe(200);
    await expect(tab).toHaveURL(`${env.clientUrl}/dashboard`);
    expect(visited.some((url) => url.startsWith(`${env.clientUrl}/impersonate?token=`))).toBe(true);
    expect(tab.url()).not.toContain('token=');

    const banner = tab.getByRole('status', { name: text.bannerTitle });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(identity.owner.email);
    await expect(banner).toContainText(text.bannerRealChanges);
    await expect(tab.locator('html')).toHaveAttribute('lang', lang);
    expect(await impersonationAuditCount(identity)).toBe(auditBefore + 1);

    // Host-only cookies: the admin tab is still signed in as the super admin.
    await page.reload();
    await expect(loginAs).toBeVisible();

    // Exit = sign the impersonated session out; the tab then shows the ended screen, no redirect.
    await banner.getByRole('button', { name: text.exit }).click();
    await expect(tab.getByRole('heading', { name: text.ended })).toBeVisible();
    await expect(tab).toHaveURL(`${env.clientUrl}/dashboard`);
    await tab.goto(`${env.clientUrl}/dashboard`);
    await expect(tab).toHaveURL(/\/login\?redirect=/);
  });
}
