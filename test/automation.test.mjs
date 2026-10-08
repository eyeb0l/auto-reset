import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Monitor } from '../src/monitor.mjs';
import { StateStore } from '../src/store.mjs';
import { NOW, credit, accountData } from './helpers.mjs';

function usage(remaining, credits) {
  const data = accountData(credits);
  data.usage.rateLimits.primary.usedPercent = 100 - remaining;
  return data;
}
const future = (id = 'first', overrides = {}) => credit(id, NOW / 1000 + 20000, overrides);

async function harness(t, { remaining = 1, credits = [future('first'), future('second')], consume } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'auto-reset-automation-'));
  const state = { now: NOW, current: usage(remaining, credits), calls: [], readError: null };
  const session = { inspect: async () => {
    if (state.readError) throw new Error(state.readError);
    return structuredClone(state.current);
  }, consume: async (id, key) => {
    const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
    assert.equal(persisted.attempts.at(-1).idempotencyKey, key);
    assert.equal(persisted.attempts.at(-1).outcome, null);
    state.calls.push({ id, key });
    if (consume) return consume(state, id, key);
    if (state.current.usage.rateLimits.primary) state.current.usage.rateLimits.primary.usedPercent = 0;
    if (state.current.usage.rateLimits.secondary) state.current.usage.rateLimits.secondary.usedPercent = 0;
    state.current.usage.rateLimitResetCredits.credits.find((c) => c.id === id).status = 'redeemed';
    return { outcome: 'reset' };
  } };
  let store = await new StateStore(directory, { now: () => state.now }).open();
  let monitor = new Monitor(store, { connect: (action) => action(session), now: () => state.now });
  await monitor.setSettings({ ...store.data.settings, lowUsageEnabled: true });
  const result = { state, directory, get store() { return store; }, get monitor() { return monitor; },
    async restart() {
      await monitor.stop(); await store.close();
      store = await new StateStore(directory, { now: () => state.now }).open();
      monitor = new Monitor(store, { connect: (action) => action(session), now: () => state.now });
    } };
  t.after(async () => { await monitor.stop(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return result;
}
const automatic = (h) => h.monitor.refresh({ automatic: true });

// All consume operations below are fakes; no real banked resets are spent.
test('low-usage trigger redeems the oldest grant at the threshold and journals trigger, outcome and verification', async (t) => {
  const h = await harness(t, { credits: [future('newer'), future('oldest', { grantedAt: NOW / 1000 - 200000, expiresAt: null })] });
  await automatic(h);
  assert.deepEqual(h.state.calls.map((c) => c.id), ['oldest']);
  const saved = JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8'));
  assert.equal(saved.attempts[0].trigger, 'low weekly usage');
  assert.equal(saved.attempts[0].automatic, true);
  assert.equal(saved.attempts[0].outcome, 'reset');
  assert.equal(saved.attempts[0].verifiedAt, NOW);
  assert.equal(saved.attempts[0].allowanceRefreshedAt, NOW);
  assert(saved.activity.some((e) => /threshold 1%/.test(e.message)));
  assert(saved.activity.some((e) => /Reset applied successfully.*low weekly usage/.test(e.message)));
});

test('expiry remains independent when low usage is disabled or weekly data is missing', async (t) => {
  const h = await harness(t, { remaining: 0 });
  await h.monitor.setSettings({ ...h.store.data.settings, lowUsageEnabled: false });
  await automatic(h);
  assert.equal(h.state.calls.length, 0);
  h.state.current.usage.rateLimitResetCredits.credits[0].expiresAt = NOW / 1000 + 600;
  h.state.current.usage.rateLimits.primary = null;
  h.state.current.usage.rateLimits.secondary = { usedPercent: 50, windowDurationMins: 300, resetsAt: NOW / 1000 + 3000 };
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.store.data.attempts[0].trigger, 'expiry');
});

test('pause, read-only refresh and dry-run never redeem with both triggers eligible', async (t) => {
  const h = await harness(t, { remaining: 0, credits: [credit()] });
  await h.monitor.refresh();
  const preview = await h.monitor.refresh({ automatic: true, dryRun: true });
  assert.deepEqual(preview.due, ['reset-one']);
  assert.deepEqual(preview.lowUsageDue, ['reset-one']);
  await h.monitor.setSettings({ ...h.store.data.settings, enabled: false });
  await automatic(h);
  assert.equal(h.state.calls.length, 0);
});

test('simultaneous triggers and overlapping checks redeem only one credit, prioritizing expiry', async (t) => {
  const h = await harness(t, { credits: [future('oldest', { grantedAt: NOW / 1000 - 300000 }), credit('expiring')] });
  await Promise.all([automatic(h), automatic(h), h.monitor.refresh()]);
  assert.deepEqual(h.state.calls.map((c) => c.id), ['expiring']);
  assert.equal(h.store.data.attempts[0].trigger, 'expiry and low weekly usage');
});

test('cooldown is independent of polling and survives restarts after verified redemption', async (t) => {
  const h = await harness(t);
  await h.monitor.setSettings({ ...h.store.data.settings, pollSeconds: 15, minRedemptionMinutes: 2 });
  await automatic(h);
  await h.restart();
  h.state.current.usage.rateLimits.primary.usedPercent = 100;
  h.state.now += 119999;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.cooldownUntil, NOW + 120000);
  h.state.now++;
  await automatic(h);
  assert.deepEqual(h.state.calls.map((c) => c.id), ['first', 'second']);
});

test('an expiring credit is also held during the automatic cooldown', async (t) => {
  const h = await harness(t);
  await automatic(h);
  h.state.current.usage.rateLimitResetCredits.credits[1].expiresAt = NOW / 1000 + 1800;
  h.state.now += 300000;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.match(h.monitor.status().redemptionSafety.reason, /cooldown/);
});

test('RPC success with stale unchanged usage cannot chain resets even when another credit expires', async (t) => {
  const h = await harness(t, { remaining: 0, consume: async () => ({ outcome: 'reset' }) });
  await automatic(h);
  const attempt = h.store.data.attempts[0];
  assert.equal(attempt.outcome, 'reset');
  assert.equal(attempt.verifiedAt, null);
  await assert.rejects(h.monitor.apply('second'), /confirm the previous reset outcome/);
  await h.restart();
  h.state.now += 3600000;
  h.state.current.usage.rateLimitResetCredits.credits[1].expiresAt = h.state.now / 1000 + 600;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  // Fresh credit state confirms the result, but unchanged low usage still blocks both triggers.
  h.state.current.usage.rateLimitResetCredits.credits[0].status = 'redeemed';
  await automatic(h);
  assert.equal(h.store.data.attempts[0].verifiedAt, h.state.now);
  assert.equal(h.store.data.attempts[0].allowanceRefreshedAt, null);
  assert.match(h.monitor.status().redemptionSafety.reason, /allowance has refreshed/);
  assert.equal(h.state.calls.length, 1);
  // A fresh usage increase verifies the allowance; it does not consume on this read-only refresh.
  h.state.current.usage.rateLimits.primary.usedPercent = 0;
  await h.monitor.refresh();
  assert.equal(h.store.data.attempts[0].allowanceRefreshedAt, h.state.now);
  await automatic(h);
  assert.equal(h.state.calls.length, 2);
});

test('post-redemption connectivity loss persists success and prevents another redemption until verified', async (t) => {
  const h = await harness(t, { consume: async (state, id) => {
    state.current.usage.rateLimitResetCredits.credits.find((c) => c.id === id).status = 'redeemed';
    state.readError = 'Disconnected after success'; return { outcome: 'reset' };
  } });
  const result = await automatic(h);
  assert.equal(result.connected, false);
  assert.equal(h.store.data.attempts[0].outcome, 'reset');
  await h.restart();
  h.state.now += 3600000;
  await assert.rejects(automatic(h), /Disconnected/);
  assert.equal(h.state.calls.length, 1);
  h.state.readError = null;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.waitingForAllowance, true);
});

test('lost responses retry only the persisted key after fresh reads, backoff and restart', async (t) => {
  const h = await harness(t, { consume: async (state) => {
    if (state.calls.length === 1) throw new Error('Lost response');
    state.current.usage.rateLimits.primary.usedPercent = 0;
    state.current.usage.rateLimitResetCredits.credits[0].status = 'redeemed';
    return { outcome: 'reset' };
  } });
  await assert.rejects(automatic(h), /Lost response/);
  await h.restart();
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  h.state.now += 60000;
  h.state.readError = 'Offline';
  await assert.rejects(automatic(h), /Offline/);
  assert.equal(h.state.calls.length, 1);
  h.state.readError = null;
  await automatic(h);
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[0].key, h.state.calls[1].key);
  assert.equal(h.store.data.attempts.length, 1);
});

test('fresh redeemed credit resolves an interrupted operation without another consume call', async (t) => {
  const h = await harness(t, { consume: async () => { throw new Error('Lost response'); } });
  await assert.rejects(automatic(h));
  await h.restart();
  h.state.now += 60000;
  h.state.current.usage.rateLimitResetCredits.credits[0].status = 'redeemed';
  h.state.current.usage.rateLimits.primary.usedPercent = 0;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.store.data.attempts[0].outcome, 'alreadyRedeemed');
  assert.equal(h.store.data.attempts[0].verifiedAt, h.state.now);
});

test('unknown or missing details and externally redeeming credits never start a second operation', async (t) => {
  const h = await harness(t, { consume: async () => { throw new Error('Lost response'); } });
  await assert.rejects(automatic(h));
  h.state.now += 60000;
  h.state.current.usage.rateLimitResetCredits.credits[0].status = 'redeeming';
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  await assert.rejects(h.monitor.apply('second'), /uncertain result/);
  h.state.current.usage.rateLimitResetCredits.credits = null;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
});

test('successful read of a partial credit list without a usage increase does not confirm redemption', async (t) => {
  const h = await harness(t, { consume: async (state) => {
    state.current.usage.rateLimitResetCredits.credits.shift(); return { outcome: 'reset' };
  } });
  await automatic(h);
  h.state.now += 3600000;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.waitingForOutcome, true);
});

test('a refreshed short window cannot clear the weekly allowance safeguard', async (t) => {
  const h = await harness(t, { remaining: 0, consume: async (state) => {
    state.current.usage.rateLimits.secondary.usedPercent = 0;
    state.current.usage.rateLimitResetCredits.credits[0].status = 'redeemed';
    return { outcome: 'reset' };
  } });
  h.state.current.usage.rateLimits.secondary = { usedPercent: 90, windowDurationMins: 300, resetsAt: NOW / 1000 + 10000 };
  await automatic(h);
  h.state.now += 3600000;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.waitingForAllowance, true);
});

test('an initial account API error cannot redeem from the cached low-usage snapshot', async (t) => {
  const h = await harness(t);
  await h.monitor.refresh();
  h.state.readError = 'Usage API unavailable';
  await assert.rejects(automatic(h), /Usage API unavailable/);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.monitor.status().connected, false);
});

test('small remaining-usage fluctuations below the threshold cannot rearm automatic redemption', async (t) => {
  const h = await harness(t, { remaining: 0, consume: async (state, id) => {
    state.current.usage.rateLimitResetCredits.credits.find((c) => c.id === id).status = 'redeemed';
    state.current.usage.rateLimits.primary.usedPercent = 99.5;
    return { outcome: 'reset' };
  } });
  await automatic(h);
  h.state.now += 3600000;
  h.state.current.usage.rateLimitResetCredits.credits[1].expiresAt = h.state.now / 1000 + 600;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.waitingForAllowance, true);
  await h.restart();
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
});

test('a timeout followed by unknown RPC outcome never moves on to a different credit', async (t) => {
  const h = await harness(t, { consume: async () => ({ outcome: 'newUnknownOutcome' }) });
  await assert.rejects(automatic(h), /unknown reset outcome/);
  h.state.now += 60000;
  await assert.rejects(automatic(h), /unknown reset outcome/);
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.state.calls[0].id, h.state.calls[1].id);
  assert.equal(h.state.calls[0].key, h.state.calls[1].key);
  assert.equal(h.store.data.attempts.length, 1);
});

test('negative refusal is persisted and verified before later retry, with cooldown and a new key', async (t) => {
  const h = await harness(t, { consume: async () => ({ outcome: 'nothingToReset' }) });
  await automatic(h);
  assert.equal(h.store.data.attempts[0].verifiedAt, NOW);
  h.state.now += 300000;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  h.state.now += 3300000;
  await automatic(h);
  assert.equal(h.state.calls.length, 2);
  assert.notEqual(h.state.calls[0].key, h.state.calls[1].key);
});

test('a slow journal write cannot send a redemption using an aged snapshot', async (t) => {
  const h = await harness(t);
  const save = h.store.save.bind(h.store);
  let delayed = false;
  h.store.save = async () => { await save(); if (!delayed) { delayed = true; h.state.now += 30001; } };
  await assert.rejects(automatic(h), /became stale/);
  assert.equal(h.state.calls.length, 0);
  assert.equal(h.store.data.attempts.length, 1);
  assert.equal(h.store.data.attempts[0].outcome, null);
  h.state.now += 60000;
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.store.data.attempts.length, 1);
});

test('allowance verification requires explicit backend permission, not just increased percentages', async (t) => {
  const h = await harness(t);
  h.state.current.usage.ordinaryUsageAllowed = false;
  await automatic(h);
  assert.equal(h.store.data.attempts[0].verifiedAt, NOW); // Redeemed credit confirms the operation.
  assert.equal(h.store.data.attempts[0].allowanceRefreshedAt, null);
  h.state.now += 3600000;
  for (const permission of [false, null]) {
    h.state.current.usage.ordinaryUsageAllowed = permission;
    await automatic(h);
    assert.equal(h.state.calls.length, 1);
    assert.equal(h.monitor.status().redemptionSafety.waitingForAllowance, true);
  }
  h.state.current.usage.ordinaryUsageAllowed = true;
  await h.monitor.refresh();
  assert.equal(h.store.data.attempts[0].allowanceRefreshedAt, h.state.now);
});

test('different manual redemptions are serialized with at most one consume request in flight', async (t) => {
  let inFlight = 0;
  let maxInFlight = 0;
  const h = await harness(t, { consume: async (state, id) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    state.current.usage.rateLimits.primary.usedPercent = 0;
    state.current.usage.rateLimitResetCredits.credits.find((c) => c.id === id).status = 'redeemed';
    inFlight--;
    return { outcome: 'reset' };
  } });
  await Promise.all([h.monitor.apply('first'), h.monitor.apply('second')]);
  assert.equal(h.state.calls.length, 2);
  assert.equal(maxInFlight, 1);
});

test('failure to persist a successful result recovers the saved operation after restart without spending again', async (t) => {
  const h = await harness(t);
  const save = h.store.save.bind(h.store);
  h.store.save = async () => {
    if (h.store.data.attempts.some((attempt) => attempt.outcome)) throw new Error('Result journal unavailable');
    await save();
  };
  await assert.rejects(automatic(h), /Result journal unavailable/);
  const saved = JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8'));
  assert.equal(saved.attempts[0].outcome, null);
  assert.equal(saved.attempts[0].idempotencyKey, h.state.calls[0].key);
  await h.restart();
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.store.data.attempts[0].outcome, 'alreadyRedeemed');
  assert.equal(h.store.data.attempts[0].verifiedAt, h.state.now);
});

test('a no-credit refusal requires fresh zero availability before another operation can start', async (t) => {
  const h = await harness(t, { consume: async () => ({ outcome: 'noCredit' }) });
  await automatic(h);
  assert.equal(h.store.data.attempts[0].outcome, 'noCredit');
  assert.equal(h.store.data.attempts[0].verifiedAt, null);
  h.state.now += 3600000;
  // Omitting the previous credit from a partial list still does not confirm account-wide noCredit.
  h.state.current.usage.rateLimitResetCredits.credits.shift();
  await automatic(h);
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.monitor.status().redemptionSafety.waitingForOutcome, true);
  h.state.current.usage.rateLimitResetCredits = { availableCount: 0, credits: [] };
  await automatic(h);
  assert.equal(h.store.data.attempts[0].verifiedAt, h.state.now);
  assert.equal(h.state.calls.length, 1);
});
