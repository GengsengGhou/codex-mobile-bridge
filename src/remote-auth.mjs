import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
const hashToken = token => createHash('sha256').update(token).digest('hex');
export class RemoteAuthError extends Error {
  constructor(code, status = 503) { super(code); this.code = code; this.status = status; }
}

// One owner per persistent path: all state changes are serialized and committed before success.
export class RemoteAuth {
  constructor({ path = null, now = Date.now, sessionTtlMs = 7 * 86400000, maxSessions = 10, rateLimit = 10, rateWindowMs = 15 * 60000 } = {}) {
    this.path = path; this.now = now; this.sessionTtlMs = Math.min(sessionTtlMs, 7 * 86400000);
    this.maxSessions = Math.min(maxSessions, 10); this.rateLimit = rateLimit; this.rateWindowMs = rateWindowMs;
    this.state = { version: 1, password: null, sessions: [] }; this.attempts = []; this.pendingLogins = 0;
    this.tail = this.load(); this.tail.catch(() => {});
  }
  async load() {
    if (!this.path) return;
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8'));
      const password = state.password;
      if (state.version !== 1 || !Array.isArray(state.sessions) || state.sessions.length > 10 ||
          (password !== null && (!password || !/^[a-f0-9]{32}$/.test(password.salt) || !/^[a-f0-9]{64}$/.test(password.hash))) ||
          state.sessions.some(s => !/^[a-f0-9]{64}$/.test(s.hash) || !Number.isFinite(s.expiresAt))) throw new Error('invalid');
      this.state = state;
    } catch (error) { if (error.code !== 'ENOENT') throw new RemoteAuthError('AUTH_UNAVAILABLE'); }
  }
  transaction(operation) {
    const result = this.tail.then(operation);
    // Persistence failure poisons this instance: never grant access using uncertain state.
    this.tail = result.catch(error => { if (error.code === 'AUTH_UNAVAILABLE') throw error; });
    this.tail.catch(() => {}); return result;
  }
  async commit(state) {
    if (this.path) {
      const temporary = `${this.path}.${randomBytes(8).toString('hex')}.tmp`;
      try {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
        await rename(temporary, this.path);
      } catch { await unlink(temporary).catch(() => {}); throw new RemoteAuthError('AUTH_UNAVAILABLE'); }
    }
    this.state = state;
  }
  async isConfigured() { await this.tail; return !!this.state.password; }
  configure(password) {
    if (typeof password !== 'string' || Buffer.byteLength(password) < 16 || Buffer.byteLength(password) > 1024) return Promise.reject(new RemoteAuthError('INVALID_PASSWORD', 400));
    return this.transaction(async () => {
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 32)).toString('hex');
      await this.commit({ version: 1, password: { salt, hash }, sessions: [] });
    });
  }
  async login(password) {
    const now = this.now(); this.attempts = this.attempts.filter(at => now - at < this.rateWindowMs);
    if (this.attempts.length >= this.rateLimit || this.pendingLogins >= 2) throw new RemoteAuthError('LOGIN_THROTTLED', 429);
    this.attempts.push(now);
    if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) throw new RemoteAuthError('INVALID_CREDENTIALS', 401);
    this.pendingLogins++;
    try {
      return await this.transaction(async () => {
        if (!this.state.password) throw new RemoteAuthError('AUTH_NOT_CONFIGURED');
        const candidate = await scrypt(password, this.state.password.salt, 32);
        if (!timingSafeEqual(candidate, Buffer.from(this.state.password.hash, 'hex'))) throw new RemoteAuthError('INVALID_CREDENTIALS', 401);
        const token = randomBytes(32).toString('base64url'); const expiresAt = this.now() + this.sessionTtlMs;
        const sessions = [...this.state.sessions.filter(s => s.expiresAt > this.now()), { hash: hashToken(token), expiresAt }].slice(-this.maxSessions);
        await this.commit({ ...this.state, sessions }); return { token, expiresAt };
      });
    } finally { this.pendingLogins--; }
  }
  async authenticate(token) {
    await this.tail;
    if (!this.state.password || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const session = this.state.sessions.find(s => s.hash === hashToken(token) && s.expiresAt > this.now());
    return session ? { expiresAt: session.expiresAt } : null;
  }
  logout(token) { return this.transaction(() => this.commit({ ...this.state, sessions: this.state.sessions.filter(s => s.hash !== hashToken(token ?? '')) })); }
  revokeAll() { return this.transaction(() => this.commit({ ...this.state, sessions: [] })); }
}
