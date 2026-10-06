import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore, ACTIVITY_RETENTION, ACTIVITY_CLEANUP_INTERVAL_MS } from '../src/store.mjs';
import { DEFAULT_SETTINGS } from '../src/policy.mjs';
import { NOW } from './helpers.mjs';

const retentionMs = ACTIVITY_RETENTION.maxAgeDays * 24 * 60 * 60_000;
const attempts = [{ accountId: 'account-a', creditId: 'old-reset', idempotencyKey: 'must-retain-pending-key', startedAt: NOW - 2 * retentionMs, outcome: null },
  { accountId: 'account-a', creditId: 'used-reset', idempotencyKey: 'must-retain-confirmed-key', startedAt: NOW - 2 * retentionMs, outcome: 'reset' }];

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'auto-reset-store-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('startup removes expired activity across accounts and persists cleanup without touching reset keys', async (t) => {
  const path = await directory(t);
  await writeFile(join(path, 'state.json'), JSON.stringify({ version: 1, settings: DEFAULT_SETTINGS, attempts, activity: [
    { id: 'current', at: NOW, accountId: 'account-a' },
    { id: 'boundary', at: NOW - retentionMs, accountId: 'account-b' },
    { id: 'old', at: NOW - retentionMs - 1, accountId: 'account-b' },
    { id: 'invalid', at: null },
  ] }));
  const store = await new StateStore(path, { now: () => NOW }).open();
  t.after(() => store.close());
  assert.deepEqual(store.data.activity.map((entry) => entry.id), ['current', 'boundary']);
  assert.deepEqual(store.data.attempts, attempts);
  const saved = JSON.parse(await readFile(join(path, 'state.json'), 'utf8'));
  assert.deepEqual(saved.activity, store.data.activity);
  assert.deepEqual(saved.attempts, attempts);
});

test('history stays bounded at the newest 1000 events in memory and on disk', async (t) => {
  const path = await directory(t);
  const store = await new StateStore(path, { now: () => NOW }).open();
  t.after(() => store.close());
  store.data.attempts = structuredClone(attempts);
  for (let index = 0; index < ACTIVITY_RETENTION.maxEntries + 7; index++) store.log(`Check ${index}`, { now: NOW + index });
  assert.equal(store.data.activity.length, ACTIVITY_RETENTION.maxEntries);
  assert.equal(store.data.activity.at(-1).message, 'Check 7');
  await store.save();
  const saved = JSON.parse(await readFile(join(path, 'state.json'), 'utf8'));
  assert.equal(saved.activity.length, ACTIVITY_RETENTION.maxEntries);
  assert.deepEqual(saved.attempts, attempts);
});

test('age cleanup runs again after an hour even without new log entries', async (t) => {
  const path = await directory(t);
  let now = NOW;
  const store = await new StateStore(path, { now: () => now }).open();
  t.after(() => store.close());
  store.log('Will expire', { now: NOW - retentionMs + ACTIVITY_CLEANUP_INTERVAL_MS / 2 });
  store.log('Still recent', { now: NOW });
  store.data.attempts = structuredClone(attempts);
  now += ACTIVITY_CLEANUP_INTERVAL_MS - 1;
  await store.save();
  assert.equal(store.data.activity.length, 2);
  now++;
  await store.save();
  assert.deepEqual(store.data.activity.map((entry) => entry.message), ['Still recent']);
  assert.deepEqual(JSON.parse(await readFile(join(path, 'state.json'), 'utf8')).attempts, attempts);
});
