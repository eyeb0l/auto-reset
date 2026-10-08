import { randomUUID } from 'node:crypto';
import { withCodex } from './codex.mjs';
import { normalizeSnapshot, availableCredits, dueCredits, lowUsageCredits, freshSnapshot, weeklyWindow, validateSettings } from './policy.mjs';
import { ACTIVITY_RETENTION } from './store.mjs';

const OUTCOME_MESSAGES = {
  reset: 'Reset applied successfully.',
  nothingToReset: 'Codex has nothing eligible to reset yet. Will retry after the backoff and automatic cooldown.',
  noCredit: 'Codex reports no available credit for this reset.',
  alreadyRedeemed: 'This reset has already been applied.',
};
const OUTCOME_LABELS = { reset: 'reset applied', nothingToReset: 'no eligible usage to reset',
  noCredit: 'credit unavailable', alreadyRedeemed: 'already redeemed' };

export class Monitor {
  constructor(store, { connect = withCodex, now = Date.now } = {}) {
    this.store = store;
    this.connect = connect;
    this.now = now;
    this.queue = Promise.resolve();
    this.snapshot = null;
    this.error = null;
    this.busy = false;
    this.running = false;
    this.nextCheckAt = null;
  }

  enqueue(action) {
    const result = this.queue.then(async () => {
      this.busy = true;
      try {
        const result = await action();
        return result && Object.hasOwn(result, 'busy') ? { ...result, busy: false } : result;
      } finally { this.busy = false; }
    });
    this.queue = result.catch(() => {});
    return result;
  }

  status() {
    const accountId = this.snapshot?.accountId;
    return {
      settings: this.store.data.settings,
      connected: Boolean(this.snapshot && !this.error),
      error: this.error,
      snapshot: this.snapshot,
      busy: this.busy,
      nextCheckAt: this.nextCheckAt,
      redemptionSafety: this.redemptionSafety(this.snapshot),
      activity: this.store.data.activity.filter((entry) => !entry.accountId || entry.accountId === accountId),
      activityRetention: ACTIVITY_RETENTION,
      attempts: this.store.data.attempts.filter((attempt) => attempt.accountId === accountId).map((attempt) => ({
        creditId: attempt.creditId, outcome: attempt.outcome, pending: !attempt.outcome,
        retryAt: attempt.retryAt, error: attempt.error,
        trigger: attempt.trigger, verifiedAt: attempt.verifiedAt ?? null,
        allowanceRefreshedAt: attempt.allowanceRefreshedAt ?? null,
      })),
    };
  }

  start() {
    this.running = true;
    void this.tick();
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.running) return;
    const delay = this.store.data.settings.pollSeconds * 1000;
    this.nextCheckAt = this.now() + delay;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  async tick() {
    try { await this.refresh({ automatic: true }); }
    catch { /* Errors are visible in the dashboard and journal; the timer keeps retrying. */ }
    finally { this.schedule(); }
  }

  async stop() {
    this.running = false;
    this.nextCheckAt = null;
    clearTimeout(this.timer);
    await this.queue;
  }

  async setSettings(settings) {
    return this.enqueue(async () => {
      this.store.data.settings = validateSettings(settings);
      const saved = this.store.data.settings;
      this.store.log(`Automatic resets ${saved.enabled ? 'enabled' : 'paused'}. Apply within ${saved.leadMinutes} minutes of expiry; low weekly usage ${saved.lowUsageEnabled ? `enabled at ${saved.weeklyRemainingThreshold}% remaining` : 'disabled'}; minimum ${saved.minRedemptionMinutes} minutes between automatic redemptions; check every ${saved.pollSeconds} seconds.`, { now: this.now() });
      await this.store.save();
      this.schedule();
      return this.status();
    });
  }

  async capture(session) {
    const snapshot = normalizeSnapshot(await session.inspect(), this.now());
    this.snapshot = snapshot;
    this.error = null;
    this.reconcile(snapshot);
    return snapshot;
  }

  accountAttempts(accountId) {
    return this.store.data.attempts.filter((attempt) => attempt.accountId === accountId);
  }

  pendingAttempt(accountId) {
    return this.accountAttempts(accountId).find((attempt) => !attempt.outcome);
  }

  reconcile(snapshot) {
    if (!freshSnapshot(snapshot, this.now())) return;
    for (const attempt of this.accountAttempts(snapshot.accountId)) {
      const credit = snapshot.credits.find((item) => item.id === attempt.creditId);
      if (!attempt.outcome && credit?.status === 'redeemed') {
        // Explicit credit state resolves a lost RPC response; absence from a partial list cannot.
        attempt.outcome = 'alreadyRedeemed';
        attempt.completedAt = this.now();
        attempt.error = null;
        this.store.log(`Reset outcome confirmed by fresh account data (${attempt.trigger || 'saved attempt'}): already redeemed.`, { accountId: snapshot.accountId, now: this.now(), level: 'success' });
      }
      if (!attempt.outcome || snapshot.checkedAt < (attempt.completedAt ?? attempt.startedAt)) continue;
      const baseline = attempt.baselineWindows || [];
      const increased = baseline.some((before) => snapshot.windows.some((after) =>
        after.key === before.key && after.windowDurationMins === before.windowDurationMins
        && after.resetsAt > this.now() && after.resetsAt >= before.resetsAt
        && after.remainingPercent > before.remainingPercent));
      const positive = ['reset', 'alreadyRedeemed'].includes(attempt.outcome);
      const confirmed = positive ? credit?.status === 'redeemed' || (increased && snapshot.ordinaryUsageAllowed === true)
        : attempt.outcome === 'nothingToReset' ? credit?.status === 'available'
          : attempt.outcome === 'noCredit' && snapshot.availableCount === 0
            && !snapshot.credits.some((item) => ['available', 'redeeming'].includes(item.status));
      if (attempt.verifiedAt == null && confirmed) {
        attempt.verifiedAt = this.now();
        this.store.log(`Fresh account data confirmed reset outcome: ${OUTCOME_LABELS[attempt.outcome]} (${attempt.trigger || 'saved attempt'}).`, { accountId: snapshot.accountId, now: this.now() });
      }
      if (positive && attempt.allowanceRefreshedAt == null) {
        const beforeWeekly = baseline.find((window) => window.windowDurationMins === 10080);
        const afterWeekly = weeklyWindow(snapshot, this.now());
        const threshold = attempt.thresholdAtStart ?? this.store.data.settings.weeklyRemainingThreshold;
        const refreshed = beforeWeekly ? afterWeekly && afterWeekly.resetsAt >= beforeWeekly.resetsAt
          && ((afterWeekly.remainingPercent > beforeWeekly.remainingPercent
            && (afterWeekly.remainingPercent > threshold || afterWeekly.remainingPercent === 100))
            || (beforeWeekly.remainingPercent > threshold && afterWeekly.remainingPercent > threshold && increased))
          : increased || (!baseline.length && snapshot.windows.some((window) => window.resetsAt > this.now() && window.remainingPercent === 100));
        // Backend permission is authoritative; percentages alone never prove usage recovery.
        if (refreshed && snapshot.ordinaryUsageAllowed === true) {
          attempt.allowanceRefreshedAt = this.now();
          this.store.log(`Allowance refresh verified after reset (${attempt.trigger || 'saved attempt'}).`, { accountId: snapshot.accountId, now: this.now(), level: 'success' });
        }
      }
    }
  }

  redemptionSafety(snapshot) {
    const attempts = this.accountAttempts(snapshot?.accountId);
    const unresolved = attempts.find((attempt) => !attempt.outcome || attempt.verifiedAt == null);
    const latest = attempts.at(-1);
    const waitingForAllowance = Boolean(latest && ['reset', 'alreadyRedeemed'].includes(latest.outcome)
      && latest.allowanceRefreshedAt == null);
    const lastAutomatic = attempts.findLast((attempt) => attempt.automatic !== false);
    const cooldownUntil = lastAutomatic ? Math.max(lastAutomatic.completedAt ?? 0, lastAutomatic.lastSentAt ?? lastAutomatic.startedAt)
      + this.store.data.settings.minRedemptionMinutes * 60_000 : null;
    const externalRedemption = snapshot?.credits.some((credit) => credit.resetType === 'codexRateLimits' && credit.status === 'redeeming');
    return { waitingForOutcome: Boolean(unresolved), waitingForAllowance, externalRedemption: Boolean(externalRedemption), cooldownUntil,
      reason: unresolved ? 'Waiting for fresh account data to confirm the previous reset outcome.'
        : externalRedemption ? 'Codex reports a reset already in progress.'
          : waitingForAllowance ? 'Waiting for fresh usage to confirm the allowance has refreshed.'
            : cooldownUntil > this.now() ? 'Automatic redemptions are waiting for the cooldown.' : null };
  }

  recordError(error) {
    const message = error instanceof Error ? error.message : 'Unable to check Codex.';
    this.store.log(message, { level: 'error', now: this.now(), accountId: this.snapshot?.accountId });
    this.error = message;
  }

  refresh({ automatic = false, dryRun = false } = {}) {
    return this.enqueue(async () => {
      try {
        return await this.connect(async (session) => {
          const snapshot = await this.capture(session);
          const due = dueCredits(snapshot, this.store.data.settings, this.now());
          const low = lowUsageCredits(snapshot, this.store.data.settings, this.now());
          if (automatic && !dryRun && this.store.data.settings.enabled && freshSnapshot(snapshot, this.now())) {
            // Resolve uncertain requests first, retaining the exact key across retries/restarts.
            const pending = this.pendingAttempt(snapshot.accountId);
            const safety = this.redemptionSafety(snapshot);
            if (pending) {
              // A retry of this exact key is the same operation, never a second redemption.
              if (!safety.externalRedemption && (pending.retryAt == null || pending.retryAt <= this.now())) {
                await this.applyWithSession(session, snapshot, { id: pending.creditId }, { automatic: true, trigger: pending.trigger || 'recovery' });
              }
            } else if (!safety.reason) {
              const expiring = due.find((item) => this.mayAttempt(snapshot.accountId, item.id));
              const credit = expiring || low.find((item) => this.mayAttempt(snapshot.accountId, item.id));
              const trigger = expiring ? low.some((item) => item.id === expiring.id) ? 'expiry and low weekly usage' : 'expiry' : 'low weekly usage';
              if (credit) await this.applyWithSession(session, snapshot, credit, { automatic: true, trigger });
            }
          }
          await this.store.save();
          return { ...this.status(), due: due.map((credit) => credit.id), lowUsageDue: low.map((credit) => credit.id), dryRun };
        });
      } catch (error) {
        this.recordError(error);
        await this.store.save();
        throw error;
      }
    });
  }

  latestAttempt(accountId, creditId) {
    return this.store.data.attempts.findLast((attempt) => attempt.accountId === accountId && attempt.creditId === creditId);
  }

  mayAttempt(accountId, creditId) {
    const latest = this.latestAttempt(accountId, creditId);
    if (!latest) return true;
    if (['reset', 'alreadyRedeemed', 'noCredit'].includes(latest.outcome)) return false;
    return latest.retryAt == null || latest.retryAt <= this.now();
  }

  apply(creditId) {
    return this.enqueue(async () => {
      try {
        return await this.connect(async (session) => {
          const snapshot = await this.capture(session);
          if (!snapshot.accountId) throw new Error('Codex did not provide an account identity. Update Codex before applying resets.');
          if (!freshSnapshot(snapshot, this.now())) throw new Error('Fresh reset details are required before applying a reset.');
          const pending = this.pendingAttempt(snapshot.accountId);
          if (pending && creditId && pending.creditId !== creditId) throw new Error('Another reset has an uncertain result. Retry that reset before applying a different one.');
          const credit = pending ? { id: pending.creditId } : availableCredits(snapshot, this.now()).find((item) => !creditId || item.id === creditId);
          if (!credit) throw new Error('This reset is unavailable, expired, or has an unsupported type. Refresh the dashboard.');
          const latest = this.latestAttempt(snapshot.accountId, credit.id);
          if (latest && ['reset', 'alreadyRedeemed', 'noCredit'].includes(latest.outcome)) {
            await this.store.save();
            return { outcome: latest.outcome, ...this.status() };
          }
          const safety = this.redemptionSafety(snapshot);
          if (safety.externalRedemption || (!pending && safety.waitingForOutcome)) throw new Error(safety.reason);
          return await this.applyWithSession(session, snapshot, credit, { automatic: false, trigger: 'manual' });
        });
      } catch (error) {
        this.recordError(error);
        await this.store.save();
        throw error;
      }
    });
  }

  async applyWithSession(session, snapshot, credit, { automatic, trigger }) {
    let attempt = this.latestAttempt(snapshot.accountId, credit.id);
    const retry = Boolean(attempt && !attempt.outcome);
    if (!attempt || attempt.outcome) {
      attempt = { accountId: snapshot.accountId, creditId: credit.id, idempotencyKey: randomUUID(),
        startedAt: this.now(), outcome: null, retryAt: null, error: null, automatic, trigger,
        completedAt: null, verifiedAt: null, allowanceRefreshedAt: null,
        thresholdAtStart: this.store.data.settings.weeklyRemainingThreshold,
        baselineWindows: snapshot.windows.filter((window) => window.resetsAt > this.now()).map((window) => ({ ...window })) };
      this.store.data.attempts.push(attempt);
    }
    attempt.lastSentAt = this.now();
    const weekly = weeklyWindow(snapshot, this.now());
    this.store.log(`${retry ? 'Retrying saved' : 'Applying'} ${credit.title || 'Codex usage reset'}; ${retry ? 'original trigger' : 'trigger'}: ${attempt.trigger || trigger}${!retry && attempt.trigger?.includes('low weekly usage') && weekly ? ` (${weekly.remainingPercent}% remaining, threshold ${attempt.thresholdAtStart}%)` : ''}.`, { accountId: snapshot.accountId, now: this.now() });
    // If persisting fails, no consume call is made.
    await this.store.save();
    let result;
    try {
      if (!freshSnapshot(snapshot, this.now())) throw new Error('Account data became stale before redemption. The saved attempt will wait for a fresh check.');
      result = await session.consume(credit.id, attempt.idempotencyKey);
      if (!Object.hasOwn(OUTCOME_MESSAGES, result?.outcome)) throw new Error('Codex returned an unknown reset outcome. The same attempt will be retried safely.');
    } catch (error) {
      attempt.error = error.message;
      attempt.retryAt = this.now() + this.store.data.settings.pollSeconds * 1000;
      await this.store.save();
      throw error;
    }
    attempt.outcome = result.outcome;
    attempt.completedAt = this.now();
    attempt.error = null;
    // An explicit refusal completes this logical attempt. A future eligible attempt needs a new key.
    const untilExpiry = credit.expiresAt ? credit.expiresAt - this.now() : 600_000;
    attempt.retryAt = result.outcome === 'nothingToReset' ? this.now() + Math.max(10_000, Math.min(300_000, untilExpiry / 2)) : null;
    this.store.log(`${OUTCOME_MESSAGES[result.outcome]} Trigger: ${attempt.trigger || trigger}.`, {
      accountId: snapshot.accountId, now: this.now(), level: result.outcome === 'reset' ? 'success' : 'info',
    });
    await this.store.save();
    // Preserve a confirmed result even if the following usage read fails.
    try { await this.capture(session); }
    catch (error) { this.recordError(error); }
    await this.store.save();
    return { outcome: result.outcome, ...this.status() };
  }
}
