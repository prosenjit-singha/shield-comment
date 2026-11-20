import { expect, test } from '@playwright/test';
import { env, runIdentity } from '../src/env.js';
import { startGraphStub, type GraphStub } from '../src/graph-stub.js';
import { commentState, seedModerationFixture, SEEDED_STATS, type ModerationFixture } from '../src/stack.js';

/**
 * Module 6 gate item 2 (D17 a): the owner's `/dashboard` renders the seeded `daily_comment_stats`,
 * and "Unhide" on `/comments` turns the seeded HIDDEN comment VISIBLE.
 * The compose `backend` runs NODE_ENV=production, where `META_GRAPH_BASE_URL` is refused, so the
 * override request is sent on to `backend-e2e` (same image, Graph stub as Meta host); every other
 * call goes to the regular stack.
 */
const identity = runIdentity();
const sum = (key: 'classified' | 'ruleMatched' | 'hidden' | 'deleted' | 'scam') =>
  SEEDED_STATS.reduce((total, day) => total + day[key], 0);

let stub: GraphStub;
let fixture: ModerationFixture;

test.beforeAll(async () => {
  stub = await startGraphStub(env.graphStubPort);
  fixture = await seedModerationFixture(identity);
});

test.afterAll(async () => {
  await stub?.close();
});

test('dashboard charts show the seeded stats and Unhide makes a hidden comment visible', async ({ page }) => {
  await page.route(/\/api\/workspaces\/[^/]+\/comments\/[^/]+\/override$/, async (route) => {
    const { pathname, search } = new URL(route.request().url());
    const response = await route.fetch({
      url: `${env.stubBackendUrl}${pathname}${search}`,
      headers: await route.request().allHeaders(),
    });
    await route.fulfill({ response });
  });

  await page.goto(`${env.clientUrl}/login?redirect=/dashboard`);
  await page.getByLabel('Email').fill(identity.owner.email);
  await page.getByLabel('Password').fill(env.ownerPassword);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(`${env.clientUrl}/dashboard`);

  // KPIs (default 30 days): scanned = classified + ruleMatched, auto-hidden = hidden + deleted.
  await expect(page.getByTestId('kpi-scanned')).toHaveText(String(sum('classified') + sum('ruleMatched')));
  await expect(page.getByTestId('kpi-autoHidden')).toHaveText(String(sum('hidden') + sum('deleted')));
  await expect(page.getByTestId('kpi-scamsBlocked')).toHaveText(String(sum('scam')));
  await expect(page.getByTestId('kpi-needsReview')).toHaveText('0');
  for (const chart of ['activity-chart', 'flagged-chart', 'intents-chart']) {
    await expect(page.getByTestId(chart).locator('svg.recharts-surface').first()).toBeVisible();
  }
  await expect(page.getByTestId('intents-chart')).toContainText(String(sum('classified')));

  await page.goto(`${env.clientUrl}/comments`);
  const row = page.getByTestId(`comment-${fixture.commentId}`);
  await expect(row).toContainText(fixture.message);
  await expect(row.getByTestId('status-pill')).toHaveText('Hidden');

  const override = page.waitForResponse((res) => res.url().endsWith(`/comments/${fixture.commentId}/override`));
  await row.getByRole('button', { name: 'Unhide' }).click();
  expect((await override).status()).toBe(200);
  await expect(row.getByTestId('status-pill')).toHaveText('Visible');

  const state = await commentState(fixture.workspaceId, fixture.commentId);
  expect(state.status).toBe('VISIBLE');
  expect(state.overridden).toBe(true);
  expect(state.actions).toEqual([
    { action: 'UNHIDE', source: 'USER', state: 'SUCCEEDED', user_email: identity.owner.email },
  ]);

  // Exactly one Graph call: the FB unhide with the seeded (decrypted) Page token.
  expect(stub.calls).toHaveLength(1);
  const [call] = stub.calls;
  expect(call).toMatchObject({ method: 'POST', path: `/v26.0/${fixture.graphCommentId}`, expected: true });
  expect(call?.form.is_hidden).toBe('false');
  expect(call?.form.access_token).toBe(fixture.pageToken);
  expect(call?.form.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
});
