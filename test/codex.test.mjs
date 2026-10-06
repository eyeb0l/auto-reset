import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { withCodex } from '../src/codex.mjs';

test('speaks the real JSON-RPC protocol over stdio and reuses the CLI-managed account', async () => {
  await withCodex(async (session) => {
    const first = await session.inspect();
    assert.equal(first.usage.accountId, 'fixture-account');
    assert.equal(first.usage.rateLimitResetCredits.availableCount, 1);
    assert.equal((await session.consume('fixture-reset', 'stable-attempt-key')).outcome, 'reset');
    assert.equal((await session.consume('fixture-reset', 'stable-attempt-key')).outcome, 'reset');
    assert.equal((await session.inspect()).usage.rateLimitResetCredits.availableCount, 0);
  }, { binary: fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), timeoutMs: 2000 });
});

test('missing CLI fails promptly with an actionable error and no hanging child', async () => {
  await assert.rejects(withCodex(() => assert.fail('Unexpected callback'), { binary: '/tmp/nonexistent-auto-reset-codex', timeoutMs: 1000 }), /Codex CLI was not found/);
});
