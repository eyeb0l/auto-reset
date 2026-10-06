#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { withCodex } from './codex.mjs';
import { normalizeSnapshot } from './policy.mjs';
import { StateStore } from './store.mjs';
import { Monitor } from './monitor.mjs';
import { createAppServer } from './server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  host: { type: 'string', default: process.env.AUTO_RESET_HOST || '127.0.0.1' },
  port: { type: 'string', default: process.env.PORT || '4780' },
  'state-dir': { type: 'string', default: process.env.AUTO_RESET_STATE_DIR || join(root, '.auto-reset') },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h' },
} });
const command = positionals[0] || 'serve';

async function main() {
  if (values.help) {
    console.log(`Auto Reset — banked Codex usage resets\n\nUsage: node src/cli.mjs [serve|status|check|apply [credit-id]] [options]\n\n  serve     Monitor continuously and serve the dashboard (default)\n  status    Read current usage and banked resets; never apply a reset\n  check     Check once and apply an expiring reset if automation is enabled\n  apply     Apply the specified reset, or the oldest available reset\n\nOptions:\n  --host <address>   Bind address (default 127.0.0.1; use a tailnet IP)\n  --port <port>      HTTP port (default 4780)\n  --state-dir <dir>  Settings, activity, and durable attempt journal\n  --dry-run         Check without applying resets\n\nUses the installed Codex CLI and its current ChatGPT login. CODEX_HOME and\nCODEX_BIN are honored. No API key or separate web login is needed.`);
    return;
  }
  if (!['serve', 'status', 'check', 'apply'].includes(command)) throw new Error(`Unknown command: ${command}. Use --help.`);
  if (command === 'status') {
    console.log(JSON.stringify(await withCodex(async (session) => normalizeSnapshot(await session.inspect())), null, 2));
    return;
  }
  if (command === 'serve') await access(join(root, 'dist', 'index.html')).catch(() => { throw new Error('Build the dashboard first: npm install && npm run build'); });
  if (command === 'apply' && values['dry-run']) throw new Error('Use check --dry-run to preview automation. apply always performs a reset.');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be between 1 and 65535.');
  const store = await new StateStore(resolve(values['state-dir'])).open();
  const monitor = new Monitor(store);
  if (command !== 'serve') {
    try {
      const result = command === 'apply' ? await monitor.apply(positionals[1]) : await monitor.refresh({ automatic: true, dryRun: values['dry-run'] });
      console.log(JSON.stringify(result, null, 2));
    } finally { await store.close(); }
    return;
  }
  const server = createAppServer(monitor, { staticDirectory: join(root, 'dist') });
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close();
    await monitor.stop();
    await store.close();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, values.host, resolve);
    });
    console.log(`Auto Reset listening at http://${values.host.includes(':') ? `[${values.host}]` : values.host}:${port}\nAutomation is ${store.data.settings.enabled ? 'enabled' : 'paused'}; watching for resets expiring within ${store.data.settings.leadMinutes} minutes.`);
    monitor.start();
  } catch (error) { await stop(); throw error; }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
