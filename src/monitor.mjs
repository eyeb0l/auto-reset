import { randomUUID } from 'node:crypto';
import { withCodex } from './codex.mjs';
import { normalizeSnapshot, availableCredits, dueCredits, validateSettings } from './policy.mjs';
import { ACTIVITY_RETENTION } from './store.mjs';

const OUTCOME_MESSAGES = {
  reset: 'Reset applied successfully.',
  nothingToReset: 'Codex has nothing eligible to reset yet. Will check again before expiry.',
  noCredit: 'Codex reports no available credit for this reset.',
  alreadyRedeemed: 'This reset has already been applied.',
};

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
      activity: this.store.data.activity.filter((entry) => !entry.accountId || entry.accountId === accountId),
      activityRetention: ACTIVITY_RETENTION,
      attempts: this.store.data.attempts.filter((attempt) => attempt.accountId === accountId).map((attempt) => ({
        creditId: attempt.creditId, outcome: attempt.outcome, pending: !attempt.outcome,
        retryAt: attempt.retryAt, error: attempt.error,
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
      this.store.log(`Automatic resets ${settings.enabled ? 'enabled' : 'paused'}. Apply within ${settings.leadMinutes} minutes of expiry; check every ${settings.pollSeconds} seconds.`, { now: this.now() });
      await this.store.save();
      this.schedule();
      return this.status();
    });
  }

  async capture(session) {
    const snapshot = normalizeSnapshot(await session.inspect(), this.now());
    this.snapshot = snapshot;
    this.error = null;
    return snapshot;
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
          this.store.log('Checked usage and available resets.', { accountId: snapshot.accountId, now: this.now() });
          const due = dueCredits(snapshot, this.store.data.settings, this.now());
          if (automatic && !dryRun && this.store.data.settings.enabled && snapshot.accountId) {
            // Resolve uncertain requests first, retaining the exact key across retries/restarts.
            const pending = this.store.data.attempts.find((attempt) => attempt.accountId === snapshot.accountId && !attempt.outcome);
            const credit = pending ? { id: pending.creditId } : due.find((item) => this.mayAttempt(snapshot.accountId, item.id));
            if (credit) await this.applyWithSession(session, snapshot, credit);
          }
          await this.store.save();
          return { ...this.status(), due: due.map((credit) => credit.id), dryRun };
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
          const pending = this.store.data.attempts.find((attempt) => attempt.accountId === snapshot.accountId && !attempt.outcome);
          if (pending && creditId && pending.creditId !== creditId) throw new Error('Another reset has an uncertain result. Retry that reset before applying a different one.');
          const credit = pending ? { id: pending.creditId } : availableCredits(snapshot, this.now()).find((item) => !creditId || item.id === creditId);
          if (!credit) throw new Error('This reset is unavailable, expired, or has an unsupported type. Refresh the dashboard.');
          const latest = this.latestAttempt(snapshot.accountId, credit.id);
          if (latest && ['reset', 'alreadyRedeemed', 'noCredit'].includes(latest.outcome)) {
            return { outcome: latest.outcome, ...this.status() };
          }
          return await this.applyWithSession(session, snapshot, credit);
        });
      } catch (error) {
        this.recordError(error);
        await this.store.save();
        throw error;
      }
    });
  }

  async applyWithSession(session, snapshot, credit) {
    let attempt = this.latestAttempt(snapshot.accountId, credit.id);
    if (!attempt || attempt.outcome) {
      attempt = { accountId: snapshot.accountId, creditId: credit.id, idempotencyKey: randomUUID(),
        startedAt: this.now(), outcome: null, retryAt: null, error: null };
      this.store.data.attempts.push(attempt);
    }
    this.store.log(`Applying ${credit.title || 'Codex usage reset'}.`, { accountId: snapshot.accountId, now: this.now() });
    // If persisting fails, no consume call is made.
    await this.store.save();
    let result;
    try {
      result = await session.consume(credit.id, attempt.idempotencyKey);
      if (!Object.hasOwn(OUTCOME_MESSAGES, result?.outcome)) throw new Error('Codex returned an unknown reset outcome. The same attempt will be retried safely.');
    } catch (error) {
      attempt.error = error.message;
      await this.store.save();
      throw error;
    }
    attempt.outcome = result.outcome;
    attempt.error = null;
    // An explicit refusal completes this logical attempt. A future eligible attempt needs a new key.
    const untilExpiry = credit.expiresAt ? credit.expiresAt - this.now() : 600_000;
    attempt.retryAt = result.outcome === 'nothingToReset' ? this.now() + Math.max(10_000, Math.min(300_000, untilExpiry / 2)) : null;
    this.store.log(OUTCOME_MESSAGES[result.outcome], {
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
