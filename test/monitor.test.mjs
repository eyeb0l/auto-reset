import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateStore } from '../src/store.mjs';
import { Monitor } from '../src/monitor.mjs';
import { NOW, credit, accountData } from './helpers.mjs';

async function setup(t, session, clock = () => NOW) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-reset-test-'));
  const store = await new StateStore(directory, { now: clock }).open();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const monitor = new Monitor(store, { connect: (action) => action(session), now: clock });
  return { directory, store, monitor };
}

test('scheduled checks update the latest timestamp without adding activity', async (t) => {
  let now = NOW;
  const { monitor, store, directory } = await setup(t, {
    inspect: async () => accountData([]), consume: async () => assert.fail('Unexpected consumption'),
  }, () => now);
  for (let index = 0; index < 3; index++) {
    await monitor.tick();
    now += 300_000;
  }
  assert.deepEqual(store.data.activity, []);
  assert.equal(monitor.status().snapshot.checkedAt, NOW + 600_000);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')).activity, []);
});

test('manual refresh updates the timestamp and preserves other activity without adding a check row', async (t) => {
  let now = NOW;
  const { monitor, store } = await setup(t, { inspect: async () => accountData([]) }, () => now);
  await monitor.setSettings({ enabled: false, leadMinutes: 30, pollSeconds: 300 });
  const activity = structuredClone(store.data.activity);
  await monitor.refresh();
  now += 300_000;
  await monitor.refresh();
  assert.equal(monitor.status().snapshot.checkedAt, now);
  assert.deepEqual(monitor.status().activity, activity);
});

test('repeated failures are logged for each check and the last successful timestamp stays accurate', async (t) => {
  let fail = false;
  let now = NOW;
  const { monitor, store } = await setup(t, { inspect: async () => {
    if (fail) throw new Error('Network unavailable');
    return accountData([]);
  } }, () => now);
  await monitor.tick();
  fail = true;
  for (let index = 0; index < 2; index++) { now += 300_000; await monitor.tick(); }
  assert.equal(store.data.activity.filter((entry) => entry.level === 'error').length, 2);
  assert.equal(store.data.activity.length, 2);
  assert.equal(monitor.status().connected, false);
  assert.equal(monitor.status().snapshot.checkedAt, NOW);
});

test('automatic check consumes only the earliest due credit; read-only refresh and dry-run never spend', async (t) => {
  let current = accountData([credit('later', NOW / 1000 + 1700), credit('first')]);
  const calls = [];
  const session = { inspect: async () => current, consume: async (id, key) => {
    calls.push({ id, key }); current = accountData([credit('later', NOW / 1000 + 1700)]); return { outcome: 'reset' };
  } };
  const { monitor } = await setup(t, session);
  await monitor.refresh();
  await monitor.refresh({ automatic: true, dryRun: true });
  assert.equal(calls.length, 0);
  await monitor.refresh({ automatic: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'first');
  assert.equal(monitor.status().snapshot.availableCount, 1);
  assert.equal(monitor.status().attempts[0].outcome, 'reset');
  assert.equal(monitor.status().busy, false);
});

test('uncertain consume is journaled before the request and retries the same key after a process restart', async (t) => {
  const keys = [];
  let first = true;
  let current = accountData();
  let directory;
  const session = { inspect: async () => current, consume: async (id, key) => {
    const journal = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(journal.attempts.at(-1).idempotencyKey, key);
    assert.equal(journal.attempts.at(-1).outcome, null);
    keys.push(key);
    if (first) { first = false; throw new Error('Response lost after backend accepted request'); }
    current = accountData([]); return { outcome: 'reset' };
  } };
  const setupResult = await setup(t, session);
  directory = setupResult.directory;
  await assert.rejects(setupResult.monitor.refresh({ automatic: true }), /Response lost/);
  await setupResult.store.close();
  const reopened = await new StateStore(directory).open();
  t.after(() => reopened.close());
  const monitor = new Monitor(reopened, { connect: (action) => action(session), now: () => NOW });
  await monitor.refresh({ automatic: true });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(monitor.status().attempts[0].outcome, 'reset');
});

test('account switching keeps reset attempts and activity scoped to the current account', async (t) => {
  let active = 'account-a';
  const keys = [];
  const session = { inspect: async () => accountData([credit('same-id')], active), consume: async (id, key) => {
    keys.push({ active, key }); if (active === 'account-a') throw new Error('Timeout'); return { outcome: 'reset' };
  } };
  const { monitor, store } = await setup(t, session);
  await assert.rejects(monitor.refresh({ automatic: true }));
  active = 'account-b';
  await monitor.refresh({ automatic: true });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0].key, keys[1].key);
  assert.equal(store.data.attempts.length, 2);
  assert.equal(monitor.status().attempts.length, 1);
  assert(monitor.status().activity.every((entry) => !entry.accountId || entry.accountId === 'account-b'));
});

test('explicit nothingToReset refusal backs off and starts a new logical attempt when usage may be eligible', async (t) => {
  let now = NOW;
  const keys = [];
  const session = { inspect: async () => accountData(), consume: async (id, key) => { keys.push(key); return { outcome: 'nothingToReset' }; } };
  const { monitor } = await setup(t, session, () => now);
  await monitor.refresh({ automatic: true });
  await monitor.refresh({ automatic: true });
  assert.equal(keys.length, 1);
  now += 300_000;
  await monitor.refresh({ automatic: true });
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test('pause prevents automatic spending, including retries; manual application is still possible', async (t) => {
  let calls = 0;
  const session = { inspect: async () => accountData(), consume: async () => { calls++; return { outcome: 'reset' }; } };
  const { monitor, store } = await setup(t, session);
  await monitor.setSettings({ ...store.data.settings, enabled: false });
  await monitor.refresh({ automatic: true });
  assert.equal(calls, 0);
  await monitor.apply('reset-one');
  assert.equal(calls, 1);
});

test('overlapping refresh and manual apply are serialized and cannot consume the same reset twice', async (t) => {
  let calls = 0;
  const session = { inspect: async () => accountData(), consume: async () => { calls++; return { outcome: 'reset' }; } };
  const { monitor } = await setup(t, session);
  await Promise.all([monitor.refresh({ automatic: true }), monitor.apply('reset-one')]);
  assert.equal(calls, 1);
});

test('missing expiry details, expired credits and unknown account IDs never trigger consumption', async (t) => {
  let current;
  const session = { inspect: async () => current, consume: async () => { assert.fail('Unexpected reset consumption'); } };
  const { monitor } = await setup(t, session);
  for (const data of [accountData(null), accountData([credit('expired', NOW / 1000 - 1)]), accountData([credit()], null)]) {
    current = data;
    await monitor.refresh({ automatic: true });
  }
});

test('confirmed outcome survives a failed post-apply read and is not repeated', async (t) => {
  let applied = false;
  let calls = 0;
  const session = { inspect: async () => { if (applied) throw new Error('Usage read unavailable'); return accountData(); },
    consume: async () => { applied = true; calls++; return { outcome: 'reset' }; } };
  const { monitor, store } = await setup(t, session);
  const result = await monitor.apply('reset-one');
  assert.equal(result.outcome, 'reset');
  assert.equal(result.connected, false);
  assert.equal(store.data.attempts[0].outcome, 'reset');
  assert.equal(calls, 1);
});

test('refuses to send a consume request if its journal cannot be persisted', async (t) => {
  const session = { inspect: async () => accountData(), consume: async () => assert.fail('Unexpected reset consumption') };
  const { monitor, store } = await setup(t, session);
  store.save = async () => { throw new Error('Disk full'); };
  await assert.rejects(monitor.refresh({ automatic: true }), /Disk full/);
});

test('state lock prevents multiple processes from using the same retry journal', async (t) => {
  const { directory } = await setup(t, {});
  await assert.rejects(new StateStore(directory).open(), /already using this state directory/);
});
