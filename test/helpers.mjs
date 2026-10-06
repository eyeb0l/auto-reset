export const NOW = Date.UTC(2026, 9, 6, 12);

export function credit(id = 'reset-one', expiry = NOW / 1000 + 1200, overrides = {}) {
  return { id, resetType: 'codexRateLimits', status: 'available', grantedAt: NOW / 1000 - 86400,
    expiresAt: expiry, title: 'Full reset', description: 'A banked reset.', ...overrides };
}

export function accountData(credits = [credit()], accountId = 'account-a') {
  return { account: { type: 'chatgpt', email: 'test@example.com', planType: 'pro' }, usage: {
    accountId, ordinaryUsageAllowed: true,
    rateLimits: { primary: { usedPercent: 78, windowDurationMins: 10080, resetsAt: NOW / 1000 + 86400 }, secondary: null },
    rateLimitResetCredits: { availableCount: credits?.length ?? 2, credits },
  } };
}
