import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, validateSettings } from './policy.mjs';

export class StateStore {
  constructor(directory) { this.directory = directory; }

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.lockPath = join(this.directory, 'process.lock');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.lock = await open(this.lockPath, 'wx', 0o600);
        await this.lock.writeFile(String(process.pid));
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const pid = Number(await readFile(this.lockPath, 'utf8'));
        let alive = true;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (failure) { if (failure.code === 'ESRCH') alive = false; }
        }
        if (alive) throw new Error('Auto Reset is already using this state directory. Use its dashboard, or stop the other process first.');
        await unlink(this.lockPath);
      }
    }
    if (!this.lock) throw new Error('Could not acquire the Auto Reset state lock.');
    try {
      this.data = JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'));
      if (this.data.version !== 1 || !Array.isArray(this.data.attempts) || !Array.isArray(this.data.activity)) throw new Error('Unsupported or damaged state file.');
      this.data.settings = validateSettings(this.data.settings);
    } catch (error) {
      if (error.code !== 'ENOENT') { await this.close(); throw new Error(`Could not read Auto Reset state: ${error.message}`); }
      this.data = { version: 1, settings: { ...DEFAULT_SETTINGS }, attempts: [], activity: [] };
      await this.save();
    }
    return this;
  }

  async save() {
    // Keep the journal durable before any reset RPC. Atomic replacement survives interrupted writes.
    const path = join(this.directory, `state-${randomUUID()}.tmp`);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${JSON.stringify(this.data, null, 2)}\n`); await file.sync(); }
    finally { await file.close(); }
    await rename(path, join(this.directory, 'state.json'));
    const directory = await open(this.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }

  log(message, { level = 'info', accountId = null, now = Date.now() } = {}) {
    this.data.activity.unshift({ id: randomUUID(), at: now, message, level, accountId });
    this.data.activity = this.data.activity.slice(0, 200);
  }

  async close() {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = null;
    await unlink(this.lockPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
