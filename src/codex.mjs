import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export class CodexError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/** Small JSON-RPC client. The CLI owns login, token refresh, and backend routing. */
export class CodexSession {
  constructor({ binary = process.env.CODEX_BIN || 'codex', timeoutMs = 30_000 } = {}) {
    this.binary = binary;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
  }

  async open() {
    this.child = spawn(this.binary, ['app-server', '--stdio'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    this.child.on('error', (error) => {
      this.exited = true;
      this.failAll(new CodexError(
        error.code === 'ENOENT' ? 'Codex CLI was not found. Install Codex or set CODEX_BIN.' : 'Could not start the Codex app server.',
        error.code,
      ));
    });
    this.child.on('exit', () => {
      this.exited = true;
      this.failAll(new CodexError('Codex app server exited. Check codex login status and ensure its state directory is writable.'));
    });
    // Drain diagnostics, but never publish CLI logs or credentials through the web API.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.failAll(new CodexError('Codex app server input closed.')));
    this.reader = createInterface({ input: this.child.stdout });
    this.reader.on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const pending = this.pending.get(message.id);
      if (pending && !message.method) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) {
          const text = message.error.code === -32601
            ? 'This Codex CLI does not support banked resets. Update Codex and try again.'
            : String(message.error.message || 'Codex request failed.').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
          pending.reject(new CodexError(text, message.error.code));
        } else pending.resolve(message.result);
      } else if (message.method && message.id != null) {
        this.send({ id: message.id, error: { code: -32601, message: 'This client only supports account usage operations.' } });
      }
    });
    await this.call('initialize', {
      clientInfo: { name: 'codex_auto_reset', title: 'Auto Reset', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.send({ method: 'initialized' });
    return this;
  }

  send(message) {
    if (this.exited) throw new CodexError('Codex app server is unavailable.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  call(method, params) {
    if (this.exited) return Promise.reject(new CodexError('Codex app server is unavailable.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexError(`Codex timed out during ${method}. The next check will retry safely.`, 'TIMEOUT'));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async inspect() {
    const { account, workspaceRouting } = await this.call('account/read', { refreshToken: false });
    if (!account) throw new CodexError('Sign in to Codex first: codex login');
    if (account.type !== 'chatgpt') throw new CodexError('Banked resets require a ChatGPT login. This Codex account uses another authentication method.');
    const usage = await this.call('account/rateLimits/read', { excludeResetCreditDetails: false });
    const routedId = workspaceRouting?.chatgptAccountId;
    if (routedId && usage.accountId && routedId !== usage.accountId) {
      throw new CodexError('Codex returned usage for a different account. Please refresh before applying a reset.');
    }
    // Expiry data and IDs must come from the backend; never infer them from the count.
    return { account, usage };
  }

  consume(creditId, idempotencyKey) {
    return this.call('account/rateLimitResetCredit/consume', { creditId, idempotencyKey });
  }

  async close() {
    if (!this.child) return;
    this.reader?.close();
    this.failAll(new CodexError('Codex session closed.'));
    this.child.stdin.end();
    if (this.exited) return;
    const exited = new Promise((resolve) => this.child.once('exit', resolve));
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    await exited;
    clearTimeout(timer);
  }
}

export async function withCodex(action, options) {
  const session = new CodexSession(options);
  try { await session.open(); return await action(session); }
  finally { await session.close(); }
}
