import { test, expect } from '@playwright/test';

function sampleStatus() {
  const now = Date.now();
  return { connected: true, error: null, busy: false, nextCheckAt: now + 60000,
    settings: { enabled: true, leadMinutes: 30, pollSeconds: 60 }, attempts: [], activityRetention: { maxEntries: 1000, maxAgeDays: 7 },
    snapshot: { accountId: 'browser-fixture', checkedAt: now, availableCount: 2, detailsAvailable: true,
      windows: [{ key: 'primary', label: '5-hour limit', remainingPercent: 76, resetsAt: now + 8_040_000 },
        { key: 'secondary', label: 'Weekly limit', remainingPercent: 22, resetsAt: now + 280_800_000 }],
      credits: [{ id: 'first', title: 'Weekly usage reset', resetType: 'codexRateLimits', status: 'available', expiresAt: now + 64_800_000 },
        { id: 'second', title: 'Weekly usage reset', resetType: 'codexRateLimits', status: 'available', expiresAt: now + 518_400_000 }] },
    activity: [{ id: 'activity-1', at: now, message: 'Checked usage and available resets.', level: 'info' },
      { id: 'activity-2', at: now - 60000, message: 'Automatic resets enabled.', level: 'info' }],
  };
}

async function mockApi(page, initial = sampleStatus()) {
  const state = structuredClone(initial);
  const mutations = [];
  await page.route('**/api/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    let response = state;
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON();
      mutations.push({ endpoint, body });
      if (endpoint === '/api/settings') state.settings = body;
      if (endpoint === '/api/apply') {
        state.snapshot.credits = state.snapshot.credits.filter((credit) => credit.id !== body.creditId);
        state.snapshot.availableCount--;
        state.snapshot.windows = state.snapshot.windows.map((window) => ({ ...window, remainingPercent: 100 }));
        state.activity.unshift({ id: 'apply', at: Date.now(), message: 'Reset applied successfully.', level: 'success' });
        response = { ...state, outcome: 'reset' };
      }
    }
    await route.fulfill({ json: response });
  });
  return { state, mutations };
}

test('dashboard saves automation settings, refreshes and applies a simulated reset', async ({ page }) => {
  const { mutations } = await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('Codex connected')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '5-hour limit remaining' })).toHaveAttribute('aria-valuenow', '76');
  await page.getByLabel('Apply before expiry').selectOption('15');
  await page.getByRole('switch', { name: 'Automatic resets' }).uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await expect(page.getByText('Paused', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Usage and resets refreshed');
  await page.getByRole('button', { name: /^Apply Weekly usage reset/ }).first().click();
  await expect(page.getByRole('status')).toContainText('Reset applied');
  await expect(page.getByRole('progressbar', { name: 'Weekly limit remaining' })).toHaveAttribute('aria-valuenow', '100');
  expect(mutations.map((mutation) => mutation.endpoint)).toEqual(['/api/settings', '/api/refresh', '/api/apply']);
  expect(mutations[0].body).toEqual({ enabled: false, leadMinutes: 15, pollSeconds: 60 });
  expect(mutations[2].body).toEqual({ creditId: 'first' });
});

test('desktop renders the full dashboard and check timing without browser errors', async ({ page }) => {
  await page.setViewportSize({ width: 1487, height: 1058 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('Codex connected')).toBeVisible();
  await expect(page.getByRole('heading')).toHaveText(['Make every reset count.', 'Current usage', 'Banked resets', 'Automatic resets', 'Available resets', 'Activity']);
  await expect(page.locator('.check-status')).toContainText('Last successful check:');
  await expect(page.locator('.check-status')).toContainText('Next check:');
  await page.getByText('Uses your local Codex CLI login.').scrollIntoViewIfNeeded();
  await expect(page.getByText('Uses your local Codex CLI login.')).toBeInViewport();
  await page.screenshot({ path: '/tmp/auto-reset-desktop.png', fullPage: true, animations: 'disabled' });
  expect(errors).toEqual([]);
});

function activityHistory(count) {
  return Array.from({ length: count }, (_, index) => ({ id: `history-${index}`, at: Date.now() - index * 300_000, message: `Scheduled check ${index}`, level: 'info' }));
}

test('activity displays 12 entries, expands in batches, and collapses back to 12', async ({ page }) => {
  const status = sampleStatus();
  status.activity = activityHistory(30);
  await mockApi(page, status);
  await page.goto('/');
  const rows = page.locator('#activity-entries li');
  await expect(rows).toHaveCount(12);
  await expect(page.getByText('Showing 12 of 30 entries')).toBeVisible();
  await expect(page.getByText('History keeps up to 1,000 entries for 7 days.')).toBeVisible();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(rows).toHaveCount(24);
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(rows).toHaveCount(30);
  await expect(page.getByRole('button', { name: 'Show more' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(rows).toHaveCount(12);
});

test('new background checks update timing without collapsing expanded history', async ({ page }) => {
  const initial = sampleStatus();
  initial.activity = activityHistory(30);
  const { state } = await mockApi(page, initial);
  await page.goto('/');
  await page.getByRole('button', { name: 'Show more' }).click();
  state.activity.unshift({ id: 'new-background', at: Date.now(), message: 'New background check', level: 'info' });
  state.snapshot.checkedAt += 300_000;
  state.nextCheckAt += 300_000;
  await expect(page.getByText('New background check', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('#activity-entries li')).toHaveCount(24);
  await expect(page.getByText('Showing 24 of 31 entries')).toBeVisible();
  await expect(page.locator('.check-status time')).toHaveAttribute('datetime', new Date(state.snapshot.checkedAt).toISOString());
});

test('mobile activity controls stay within the viewport and remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const status = sampleStatus();
  status.activity = activityHistory(25);
  await mockApi(page, status);
  await page.goto('/');
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.locator('#activity-entries li')).toHaveCount(24);
  await page.getByRole('button', { name: 'Show less' }).click();
  await expect(page.locator('#activity-entries li')).toHaveCount(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('.activity').screenshot({ path: '/tmp/auto-reset-activity-mobile.png', animations: 'disabled' });
});

test('mobile fits the viewport and all settings and reset controls remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto('/');
  await expect(page.getByText('Codex connected')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByLabel('Check interval').selectOption('30');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('status')).toContainText('Settings saved');
  await page.locator('.table-scroll').evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await page.getByRole('button', { name: /^Apply Weekly usage reset/ }).first().click();
  await expect(page.getByRole('status')).toContainText('Reset applied');
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.locator('.table-scroll').evaluate((element) => { element.scrollLeft = 0; });
  await page.screenshot({ path: '/tmp/auto-reset-mobile.png', fullPage: true, animations: 'disabled' });
});

test('empty state does not invent reset data', async ({ page }) => {
  const status = sampleStatus();
  status.snapshot.credits = [];
  status.snapshot.availableCount = 0;
  await mockApi(page, status);
  await page.goto('/');
  await expect(page.getByText('All caught up. No banked resets are available right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply now' })).toHaveCount(0);
});

test('count-only data displays the count and waits for expiry details', async ({ page }) => {
  const status = sampleStatus();
  status.snapshot.credits = [];
  status.snapshot.detailsAvailable = false;
  await mockApi(page, status);
  await page.goto('/');
  await expect(page.getByText('Codex returned 2 resets without expiry details. Automatic application waits for those details.')).toBeVisible();
  await expect(page.getByText('Waiting for expiry details')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply now' })).toHaveCount(0);
});

test('Codex errors show stale-data explanation and prevent applying old reset data', async ({ page }) => {
  const status = sampleStatus();
  status.connected = false;
  status.error = 'Sign in to Codex first: codex login';
  await mockApi(page, status);
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Sign in to Codex first');
  await expect(page.getByRole('alert')).toContainText('Showing the last successful check');
  await expect(page.getByRole('button', { name: /^Apply Weekly usage reset/ }).first()).toBeDisabled();
});
