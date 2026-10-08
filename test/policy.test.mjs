import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, normalizeSnapshot, dueCredits, availableCredits, lowUsageCredits } from '../src/policy.mjs';
import { NOW, credit, accountData } from './helpers.mjs';

test('normalizes second timestamps, reports the actual window, and sorts expiry earliest first', () => {
  const snapshot = normalizeSnapshot(accountData([credit('later', NOW / 1000 + 3600), credit('first')]), NOW);
  assert.equal(snapshot.credits[0].id, 'first');
  assert.equal(snapshot.credits[0].expiresAt, NOW + 1_200_000);
  assert.equal(snapshot.windows[0].label, 'Weekly limit');
  assert.equal(snapshot.windows[0].remainingPercent, 22);
  assert.deepEqual(dueCredits(snapshot, DEFAULT_SETTINGS, NOW).map((item) => item.id), ['first']);
});

test('never infers expiration from counts; ignores unknown types, expired and nonavailable credits', () => {
  const snapshot = normalizeSnapshot(accountData([
    credit('never', null), credit('expired', NOW / 1000), credit('unknown', NOW / 1000 + 10, { resetType: 'unknown' }),
    credit('redeeming', NOW / 1000 + 10, { status: 'redeeming' }), credit('future', NOW / 1000 + 4000),
  ]), NOW);
  assert.deepEqual(dueCredits(snapshot, DEFAULT_SETTINGS, NOW), []);
  assert.deepEqual(availableCredits(snapshot, NOW).map((item) => item.id), ['future', 'never']);
  const missing = normalizeSnapshot(accountData(null), NOW);
  assert.equal(missing.availableCount, 2);
  assert.equal(missing.detailsAvailable, false);
  assert.deepEqual(dueCredits(missing, DEFAULT_SETTINGS, NOW), []);
});

test('requires an account identity and respects pause', () => {
  assert.deepEqual(dueCredits(normalizeSnapshot(accountData([credit()], null), NOW), DEFAULT_SETTINGS, NOW), []);
  assert.deepEqual(dueCredits(normalizeSnapshot(accountData(), NOW), { ...DEFAULT_SETTINGS, enabled: false }, NOW), []);
});

test('rejects invalid intervals and expiry windows too short to allow a request', () => {
  assert.deepEqual(validateSettings(DEFAULT_SETTINGS), DEFAULT_SETTINGS);
  for (const bad of [{ pollSeconds: 0 }, { leadMinutes: -1 }, { enabled: 'true' }, { leadMinutes: 1, pollSeconds: 60 }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...bad }));
  }
});

test('legacy settings preserve expiry automation and adopt disabled low usage and an independent cooldown', () => {
  assert.deepEqual(validateSettings({ enabled: true, leadMinutes: 30, pollSeconds: 300 }), { ...DEFAULT_SETTINGS, pollSeconds: 300 });
  for (const bad of [{ lowUsageEnabled: 'yes' }, { weeklyRemainingThreshold: null },
    { weeklyRemainingThreshold: -1 }, { weeklyRemainingThreshold: 101 }, { weeklyRemainingThreshold: NaN },
    { minRedemptionMinutes: 0 }, { minRedemptionMinutes: 10081 }, { minRedemptionMinutes: 1.5 }]) {
    assert.throws(() => validateSettings({ ...DEFAULT_SETTINGS, ...bad }));
  }
  assert.equal(validateSettings({ ...DEFAULT_SETTINGS, weeklyRemainingThreshold: 0.5, minRedemptionMinutes: 1 }).minRedemptionMinutes, 1);
});

test('low usage is inclusive, opt-in, and selects the oldest grant independently of expiry', () => {
  const data = accountData([credit('soonest'), credit('oldest', null, { grantedAt: NOW / 1000 - 200000 })]);
  const settings = { ...DEFAULT_SETTINGS, lowUsageEnabled: true };
  for (const remaining of [2, 1, 0.5, 0]) {
    data.usage.rateLimits.primary.usedPercent = 100 - remaining;
    const snapshot = normalizeSnapshot(data, NOW);
    assert.deepEqual(lowUsageCredits(snapshot, settings, NOW).map((c) => c.id), remaining <= 1 ? ['oldest', 'soonest'] : []);
    assert.deepEqual(dueCredits(snapshot, settings, NOW).map((c) => c.id), ['soonest']);
    assert.deepEqual(lowUsageCredits(snapshot, DEFAULT_SETTINGS, NOW), []);
    assert.deepEqual(lowUsageCredits(snapshot, { ...settings, enabled: false }, NOW), []);
  }
});

test('low usage requires a real weekly window, current reset time, fresh read, identity and details', () => {
  const settings = { ...DEFAULT_SETTINGS, lowUsageEnabled: true };
  const data = accountData();
  data.usage.rateLimits.primary.usedPercent = 100;
  const good = normalizeSnapshot(data, NOW);
  for (const snapshot of [{ ...good, checkedAt: NOW - 30001 }, { ...good, checkedAt: NOW + 1 },
    { ...good, accountId: null }, { ...good, detailsAvailable: false },
    { ...good, windows: [] }, { ...good, windows: [{ ...good.windows[0], windowDurationMins: 300 }] },
    { ...good, windows: [{ ...good.windows[0], resetsAt: NOW }] },
    { ...good, windows: [{ ...good.windows[0], resetsAt: null }] }]) {
    assert.deepEqual(lowUsageCredits(snapshot, settings, NOW), []);
  }
  for (const usedPercent of [-1, 101, NaN]) {
    data.usage.rateLimits.primary.usedPercent = usedPercent;
    assert.deepEqual(lowUsageCredits(normalizeSnapshot(data, NOW), settings, NOW), []);
  }
  assert.deepEqual(dueCredits({ ...good, checkedAt: NOW - 30001 }, settings, NOW), []);
  // A weekly limit can be either primary or secondary; the short window must not trigger it.
  data.usage.rateLimits.secondary = { ...data.usage.rateLimits.primary, usedPercent: 99 };
  data.usage.rateLimits.primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW / 1000 + 3000 };
  assert.equal(lowUsageCredits(normalizeSnapshot(data, NOW), settings, NOW).length, 1);
});
