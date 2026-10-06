import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppServer } from '../src/server.mjs';

test('API exposes status and validates mutation origin, content type, size and settings', async (t) => {
  const mutations = [];
  const monitor = { status: () => ({ connected: true }), refresh: async () => { mutations.push('refresh'); return {}; },
    apply: async (id) => { mutations.push(id); return { outcome: 'reset' }; },
    setSettings: async () => { throw new Error('Bad settings'); } };
  const server = createAppServer(monitor);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/status`)).json()).connected, true);
  const post = (route, body, headers = {}) => fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('apply', { creditId: 'one' }, { Origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await post('apply', {})).status, 400);
  assert.equal((await post('settings', {})).status, 400);
  assert.equal((await post('refresh', {}, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('refresh', { padding: 'a'.repeat(9000) })).status, 413);
  assert.equal((await post('apply', { creditId: 'one' }, { Origin: base })).status, 200);
  assert.deepEqual(mutations, ['one']);
});
