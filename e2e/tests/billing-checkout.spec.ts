import { expect, test, type Page } from '@playwright/test';
import { env, runIdentity } from '../src/env.js';
import { paidForm, startSslcommerzStub, type SslcommerzStub } from '../src/sslcommerz-stub.js';
import { billingState, resetOwnerBilling } from '../src/stack.js';

/**
 * Module 8 gate item 1 (D13 a): trial → paid checkout round trip against the SSLCommerz stub.
 * The compose `backend` runs NODE_ENV=production without a store (checkout 503) and refuses
 * `SSLCOMMERZ_BASE_URL`, so the calls that need SSLCommerz go to `backend-e2e` (same image, stub
 * as SSLCommerz host, same DB + Redis): the checkout and the browser's success return (forwarded
 * here), and the IPN (sent here, as SSLCommerz's server would). Everything else is the real stack.
 * Each case starts from a fresh account (no plan, never had a trial); `cleanupRun` removes the rest.
 */
const identity = runIdentity();
const DAY_MS = 24 * 60 * 60 * 1000;
let stub: SslcommerzStub;

test.beforeAll(async () => {
  stub = await startSslcommerzStub(env.sslcommerzStubPort);
});

test.afterAll(async () => {
  await stub?.close();
});

test.beforeEach(async () => {
  await resetOwnerBilling(identity);
  stub.calls.length = 0;
});

/** Checkout + the SSLCommerz success return → `backend-e2e` (the 303 is handed to the browser as is). */
async function forwardPaymentCalls(page: Page): Promise<void> {
  await page.route(/\/api\/(workspaces\/[^/]+\/billing\/checkout|billing\/sslcommerz\/success)$/, async (route) => {
    const { pathname, search } = new URL(route.request().url());
    const response = await route.fetch({
      url: `${env.stubBackendUrl}${pathname}${search}`,
      headers: await route.request().allHeaders(),
      maxRedirects: 0,
    });
    await route.fulfill({ response });
  });
}

/** Owner signs in on /plans and starts the Starter trial there (→ /onboarding). */
async function signInWithTrial(page: Page): Promise<void> {
  await forwardPaymentCalls(page);
  await page.goto(`${env.clientUrl}/login?redirect=/plans`);
  await page.getByLabel('Email').fill(identity.owner.email);
  await page.getByLabel('Password').fill(env.ownerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(`${env.clientUrl}/plans`);
  const started = page.waitForResponse(
    (res) => res.url().endsWith('/billing/trial') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Start free 7-day trial' }).click();
  expect((await started).status()).toBe(201);
  expect((await billingState(identity)).subscriptions).toMatchObject([{ status: 'TRIALING', plan: 'starter' }]);
}

/** `/billing?plan&interval` → Pay → the stub's hosted page. Returns the tran id + charged amount. */
async function checkout(page: Page, plan: string, interval: 'month' | 'year') {
  await page.goto(`${env.clientUrl}/billing?plan=${plan}&interval=${interval}`);
  await expect(page.getByTestId('billing-status')).toHaveText('Trial');
  const created = page.waitForResponse(
    (res) => res.url().endsWith('/billing/checkout') && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Pay with bKash / Nagad / card' }).click();
  expect((await created).status()).toBe(201);
  // The body is gone once the page leaves for the gateway: the tran id comes from its URL.
  const gateway = new RegExp(`^http://localhost:${env.sslcommerzStubPort}/gateway/([A-Za-z0-9_-]+)$`);
  await expect(page).toHaveURL(gateway);
  const tranId = gateway.exec(page.url())?.[1] ?? '';
  const amountBdt = Number(stub.sessions.get(tranId)?.total_amount);
  expect(amountBdt).toBeGreaterThanOrEqual(10);
  return { tranId, amountBdt };
}

/** SSLCommerz's server-to-server IPN (urlencoded, no cookie) to `backend-e2e`. */
async function sendIpn(form: Record<string, string>): Promise<void> {
  const res = await fetch(`${env.stubBackendUrl}/api/billing/sslcommerz/ipn`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  });
  expect(res.status).toBe(200);
}

async function payRoundTrip(page: Page, plan: string, interval: 'month' | 'year', comments: number) {
  await signInWithTrial(page);
  const paidFrom = Date.now();
  const { tranId, amountBdt } = await checkout(page, plan, interval);
  await sendIpn(paidForm(tranId, amountBdt));
  await page.getByRole('button', { name: 'Pay', exact: true }).click();

  await expect(page).toHaveURL(`${env.clientUrl}/billing?payment=success&tranId=${tranId}`);
  await expect(page.getByText('Payment received. Your plan is active.')).toBeVisible();
  const summary = page.getByTestId('billing-summary');
  await expect(summary.getByTestId('billing-status')).toHaveText('Active');
  await expect(summary).toContainText(interval === 'year' ? 'Yearly' : 'Monthly');

  const state = await billingState(identity);
  const [payment] = state.payments;
  expect(state.payments).toHaveLength(1);
  expect(payment).toMatchObject({
    tran_id: tranId,
    status: 'PAID',
    amount_bdt: amountBdt,
    card_type: 'BKASH-BKash',
    events: ['IPN:PAID', 'SUCCESS:ALREADY_PAID'],
  });
  expect(payment?.invoice_number).toMatch(/^SC-\d{4}-\d{5,}$/);
  // Paying ends the trial (D6) and starts a new ACTIVE term from now with a fresh wallet period.
  const [active, trial] = state.subscriptions;
  expect(state.subscriptions).toHaveLength(2);
  expect(active).toMatchObject({ status: 'ACTIVE', plan, interval });
  expect(trial).toMatchObject({ plan: 'starter' });
  expect(trial?.status).not.toBe('TRIALING');
  expect(active!.term_start.getTime()).toBeGreaterThanOrEqual(paidFrom - 1000);
  const termDays = (active!.term_end.getTime() - active!.term_start.getTime()) / DAY_MS;
  expect(termDays).toBeGreaterThanOrEqual(interval === 'year' ? 365 : 28);
  expect(termDays).toBeLessThanOrEqual(interval === 'year' ? 366 : 31);
  expect(state.wallet).toEqual({ period_start: active!.term_start, included: comments });

  // The invoice is listed on /billing.
  const invoice = page.getByTestId('invoice-row');
  await expect(invoice).toHaveCount(1);
  await expect(invoice).toContainText(payment!.invoice_number!);
  await expect(invoice.getByTestId('invoice-status')).toHaveText('Paid');

  // Session → hosted page → one validation (IPN); the success return finds it paid (no second call).
  expect(stub.calls.map((c) => c.kind)).toEqual(['session', 'gateway', 'validation']);
  return { tranId, invoiceNumber: payment!.invoice_number! };
}

test('trial → paid monthly: IPN validates, the plan is active, /billing + A4 show the invoice', async ({
  page,
  browser,
}) => {
  const { tranId, invoiceNumber } = await payRoundTrip(page, 'starter', 'month', 2500);

  const adminContext = await browser.newContext();
  try {
    const admin = await adminContext.newPage();
    await admin.goto(`${env.adminUrl}/admin/login`);
    await admin.getByLabel('Email').fill(identity.superAdmin.email);
    await admin.getByLabel('Password').fill(env.superAdminPassword);
    await admin.getByRole('button', { name: 'Sign in' }).click();
    await expect(admin).not.toHaveURL(/\/admin\/login/);
    await admin.goto(`${env.adminUrl}/admin/billing?q=${tranId}`);
    const row = admin.getByRole('row').filter({ has: admin.getByRole('button', { name: `Open transaction ${tranId}` }) });
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('transaction-status')).toHaveText('Paid');
    await expect(row).toContainText('bKash');
    await expect(row).toContainText(invoiceNumber);
    await expect(row).toContainText(identity.owner.workspaceName);
  } finally {
    await adminContext.close();
  }
});

test('trial → paid yearly on another plan', async ({ page }) => {
  await payRoundTrip(page, 'growth', 'year', 15000);
});

test('a tampered amount or a forged signature never pays', async ({ page }) => {
  await signInWithTrial(page);
  const { tranId, amountBdt } = await checkout(page, 'starter', 'month');
  // Forged: the amount changed after signing → BAD_SIGNATURE, no validator call.
  await sendIpn({ ...paidForm(tranId, amountBdt), amount: '1.00' });
  // Signed, but SSLCommerz charged ৳1 (amount tampered on the way) → AMOUNT_MISMATCH.
  stub.chargeAmount(tranId, 1);
  await sendIpn(paidForm(tranId, amountBdt));
  await page.getByRole('button', { name: 'Pay', exact: true }).click();

  await expect(page).toHaveURL(`${env.clientUrl}/billing?payment=failed&tranId=${tranId}`);
  await expect(page.getByText('The payment didn’t go through, so nothing changed.')).toBeVisible();
  await expect(page.getByTestId('billing-status')).toHaveText('Trial');

  const state = await billingState(identity);
  expect(state.payments).toEqual([
    expect.objectContaining({
      tran_id: tranId,
      status: 'PENDING',
      invoice_number: null,
      events: ['IPN:BAD_SIGNATURE', 'IPN:AMOUNT_MISMATCH', 'SUCCESS:AMOUNT_MISMATCH'],
    }),
  ]);
  expect(state.subscriptions).toMatchObject([{ status: 'TRIALING', plan: 'starter' }]);
  expect(stub.calls.map((c) => c.kind)).toEqual(['session', 'gateway', 'validation', 'validation']);
});
