#!/usr/bin/env node
// A standalone protocol fixture. It has no access to real credentials or backend APIs.
import { createInterface } from 'node:readline';

const credits = [{ id: 'fixture-reset', status: 'available', resetType: 'codexRateLimits', grantedAt: 1791200000,
  expiresAt: 1893456000, title: 'Fixture reset', description: null }];
const attempts = new Map();
createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  let result;
  if (request.method === 'initialize') {
    if (!request.params.capabilities.experimentalApi) throw new Error('Experimental capability is required.');
    result = { userAgent: 'fixture/1.0' };
  } else if (request.method === 'account/read') result = { account: { type: 'chatgpt', email: 'fixture@example.com', planType: 'pro' }, workspaceRouting: { chatgptAccountId: 'fixture-account' } };
  else if (request.method === 'account/rateLimits/read') {
    if (request.params.excludeResetCreditDetails !== false) throw new Error('Detailed reset data must be requested.');
    result = { accountId: 'fixture-account', ordinaryUsageAllowed: true,
      rateLimits: { primary: { usedPercent: 80, windowDurationMins: 300, resetsAt: 1893456000 } },
      rateLimitResetCredits: { availableCount: credits.length, credits } };
  } else if (request.method === 'account/rateLimitResetCredit/consume') {
    const { creditId, idempotencyKey } = request.params;
    if (!idempotencyKey || creditId !== 'fixture-reset') throw new Error('Explicit credit ID and idempotency key required.');
    if (!attempts.has(idempotencyKey)) {
      attempts.set(idempotencyKey, { outcome: credits.length ? 'reset' : 'alreadyRedeemed' });
      credits.splice(0);
    }
    result = attempts.get(idempotencyKey);
  } else {
    process.stdout.write(`${JSON.stringify({ id: request.id, error: { code: -32601, message: 'Unknown method' } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
});
