export const DEFAULT_SETTINGS = Object.freeze({ enabled: true, leadMinutes: 30, pollSeconds: 60,
  lowUsageEnabled: false, weeklyRemainingThreshold: 1, minRedemptionMinutes: 60 });

export const SNAPSHOT_MAX_AGE_MS = 30_000;

export function validateSettings(settings) {
  if (!settings || typeof settings.enabled !== 'boolean'
    || !Number.isInteger(settings.leadMinutes) || settings.leadMinutes < 1 || settings.leadMinutes > 1440
    || !Number.isInteger(settings.pollSeconds) || settings.pollSeconds < 10 || settings.pollSeconds > 300
    || settings.leadMinutes * 60 <= settings.pollSeconds + 30) {
    throw new Error('Use a 1–1440 minute expiry window and a 10–300 second check interval. The expiry window must exceed the interval by more than 30 seconds.');
  }
  // Older state files and CLI clients keep the expiry trigger and adopt conservative defaults.
  const lowUsageEnabled = settings.lowUsageEnabled === undefined ? DEFAULT_SETTINGS.lowUsageEnabled : settings.lowUsageEnabled;
  const weeklyRemainingThreshold = settings.weeklyRemainingThreshold === undefined ? DEFAULT_SETTINGS.weeklyRemainingThreshold : settings.weeklyRemainingThreshold;
  const minRedemptionMinutes = settings.minRedemptionMinutes === undefined ? DEFAULT_SETTINGS.minRedemptionMinutes : settings.minRedemptionMinutes;
  if (typeof lowUsageEnabled !== 'boolean' || !Number.isFinite(weeklyRemainingThreshold)
    || weeklyRemainingThreshold < 0 || weeklyRemainingThreshold > 100
    || !Number.isInteger(minRedemptionMinutes) || minRedemptionMinutes < 1 || minRedemptionMinutes > 10080) {
    throw new Error('Use a 0–100% weekly remaining threshold and a 1–10080 minute minimum between automatic redemptions.');
  }
  return { enabled: settings.enabled, leadMinutes: settings.leadMinutes, pollSeconds: settings.pollSeconds,
    lowUsageEnabled, weeklyRemainingThreshold, minRedemptionMinutes };
}

export function normalizeSnapshot({ account, usage }, now = Date.now()) {
  const summary = usage.rateLimitResetCredits;
  const detailed = Array.isArray(summary?.credits);
  const credits = detailed ? summary.credits.filter((credit) => typeof credit.id === 'string' && credit.id.length
    && ['available', 'redeeming', 'redeemed', 'unknown'].includes(credit.status)).map((credit) => ({
    id: credit.id,
    title: credit.title || 'Codex usage reset',
    description: credit.description || null,
    resetType: credit.resetType,
    status: credit.status,
    grantedAt: Number.isFinite(credit.grantedAt) ? credit.grantedAt * 1000 : null,
    expiresAt: Number.isFinite(credit.expiresAt) && credit.expiresAt > 0 ? credit.expiresAt * 1000 : null,
  })) : [];
  credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity) || (a.grantedAt ?? 0) - (b.grantedAt ?? 0));
  const rawCount = summary?.availableCount;
  const availableCount = rawCount != null && Number.isSafeInteger(Number(rawCount)) && Number(rawCount) >= 0 ? Number(rawCount) : null;
  const bucket = usage.rateLimitsByLimitId?.codex || usage.rateLimits;
  const windows = ['primary', 'secondary'].flatMap((key) => {
    const window = bucket?.[key];
    if (!window || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
    const minutes = window.windowDurationMins;
    const label = minutes === 10080 ? 'Weekly limit' : minutes === 300 ? '5-hour limit'
      : minutes ? `${minutes >= 60 ? `${minutes / 60}-hour` : `${minutes}-minute`} limit` : `${key === 'primary' ? 'Primary' : 'Secondary'} limit`;
    return [{ key, label, windowDurationMins: minutes, remainingPercent: 100 - window.usedPercent,
      resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt * 1000 : null }];
  });
  return { accountId: typeof usage.accountId === 'string' && usage.accountId ? usage.accountId : null,
    account: { email: account.email, planType: account.planType },
    ordinaryUsageAllowed: usage.ordinaryUsageAllowed ?? null,
    windows, availableCount, detailsAvailable: detailed, credits, checkedAt: now };
}

export function availableCredits(snapshot, now) {
  return snapshot.credits.filter((credit) => credit.status === 'available' && credit.resetType === 'codexRateLimits'
    && (credit.expiresAt === null || credit.expiresAt > now));
}

export function dueCredits(snapshot, settings, now) {
  if (!settings.enabled || !freshSnapshot(snapshot, now)) return [];
  return availableCredits(snapshot, now).filter((credit) => credit.expiresAt !== null
    && credit.expiresAt - now <= settings.leadMinutes * 60_000);
}

export function freshSnapshot(snapshot, now) {
  return Boolean(snapshot?.accountId && snapshot.detailsAvailable && Number.isFinite(snapshot.checkedAt)
    && snapshot.checkedAt <= now && now - snapshot.checkedAt <= SNAPSHOT_MAX_AGE_MS);
}

export function weeklyWindow(snapshot, now) {
  return snapshot?.windows.find((window) => window.windowDurationMins === 10080
    && Number.isFinite(window.remainingPercent) && Number.isFinite(window.resetsAt) && window.resetsAt > now) || null;
}

export function lowUsageCredits(snapshot, settings, now) {
  if (!settings.enabled || !settings.lowUsageEnabled || !freshSnapshot(snapshot, now)) return [];
  const weekly = weeklyWindow(snapshot, now);
  if (!weekly || weekly.remainingPercent > settings.weeklyRemainingThreshold) return [];
  // Low usage chooses the oldest grant; expiry selection continues to prefer the earliest expiry.
  return availableCredits(snapshot, now).sort((a, b) => (a.grantedAt ?? Infinity) - (b.grantedAt ?? Infinity)
    || (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}
