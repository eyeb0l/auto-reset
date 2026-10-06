import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, validateSettings, normalizeSnapshot, dueCredits, availableCredits } from '../src/policy.mjs';
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
