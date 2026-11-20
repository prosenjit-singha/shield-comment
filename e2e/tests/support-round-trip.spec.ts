import { expect, test } from '@playwright/test';
import { env, runIdentity } from '../src/env.js';
import { ticketState } from '../src/stack.js';

/**
 * Module 7 gate item 1 (D17 a): the client owner opens a ticket on `/support`, the super admin finds it
 * on `/admin/tickets` and replies, the owner sees the reply (status In progress). The reply email can't
 * go live: compose runs without `RESEND_API_KEY`, so the send fails and the notifier only logs it.
 * Rows are removed by `cleanupRun` (tickets of the run workspace).
 */
const identity = runIdentity();
const subject = `E2E gate ticket ${identity.runId}`;
const question = 'Our scam filter missed a bKash comment. Can you check?';
const answer = `Checked it, the rule is fixed now (${identity.runId}).`;

test('a ticket from /support gets an admin reply on /admin/tickets that the client sees', async ({ browser }) => {
  // Two contexts: the client owner and the super admin sign in on different apps.
  const clientContext = await browser.newContext();
  const adminContext = await browser.newContext();
  try {
    const client = await clientContext.newPage();
    await client.goto(`${env.clientUrl}/login?redirect=/support`);
    await client.getByLabel('Email').fill(identity.owner.email);
    await client.getByLabel('Password').fill(env.ownerPassword);
    await client.getByRole('button', { name: 'Log in' }).click();
    await expect(client).toHaveURL(`${env.clientUrl}/support`);

    await client.getByRole('button', { name: 'New ticket' }).click();
    await client.getByLabel('Category').selectOption('TECHNICAL');
    await client.getByLabel('Subject').fill(subject);
    await client.getByLabel('Message').fill(question);
    const created = client.waitForResponse(
      (res) => res.url().endsWith('/support/tickets') && res.request().method() === 'POST',
    );
    await client.getByRole('button', { name: 'Send ticket' }).click();
    expect((await created).status()).toBe(201);
    // Created → the thread opens (`?ticket=<id>`).
    await expect(client).toHaveURL(/\/support\?ticket=[0-9a-f-]{36}$/);
    await expect(client.getByRole('heading', { name: subject })).toBeVisible();
    const threadUrl = client.url();

    const admin = await adminContext.newPage();
    await admin.goto(`${env.adminUrl}/admin/login`);
    await admin.getByLabel('Email').fill(identity.superAdmin.email);
    await admin.getByLabel('Password').fill(env.superAdminPassword);
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await expect(admin).not.toHaveURL(/\/admin\/login/);

    await admin.goto(`${env.adminUrl}/admin/tickets?q=${encodeURIComponent(subject)}`);
    const queue = admin.getByRole('list', { name: 'Tickets' });
    const row = queue.getByRole('link', { name: new RegExp(subject) });
    await expect(row).toBeVisible();
    await expect(row).toContainText(identity.owner.workspaceName);
    await row.click();

    const thread = admin.getByRole('region', { name: 'Conversation' });
    await expect(thread.getByText(question)).toBeVisible();
    await thread.getByLabel('Reply', { exact: true }).fill(answer);
    const replied = admin.waitForResponse(
      (res) => /\/api\/admin\/tickets\/[^/]+\/reply$/.test(res.url()) && res.request().method() === 'POST',
    );
    await thread.getByRole('button', { name: 'Send reply' }).click();
    expect((await replied).status()).toBeLessThan(300);
    await expect(thread.getByRole('listitem', { name: `Message from ${identity.superAdmin.name}` })).toContainText(answer);

    // The client's thread polls every 15 s; a reload shows the reply at once.
    await client.goto(threadUrl);
    const messages = client.getByRole('list', { name: 'Messages' });
    const support = messages.locator('li[data-sender="ADMIN"]');
    await expect(support).toContainText(answer);
    await expect(support).toContainText('Support');
    await expect(client.locator('header [data-status]')).toHaveText('In progress');

    expect(await ticketState(subject)).toEqual({
      status: 'IN_PROGRESS',
      messages: [
        { senderRole: 'CLIENT', internal: false, body: question },
        { senderRole: 'ADMIN', internal: false, body: answer },
      ],
    });

    // Back on the list: the ticket shows the "New reply" badge.
    await client.getByRole('button', { name: 'All tickets' }).click();
    await expect(client.getByRole('button', { name: new RegExp(subject) }).getByTestId('new-reply')).toBeVisible();
  } finally {
    await clientContext.close();
    await adminContext.close();
  }
});
