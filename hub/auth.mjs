import { scrypt as scryptCallback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HubError } from './errors.mjs';
const scrypt = promisify(scryptCallback);
const dummySalt = 'invalid-account-timing-salt';
export async function hashPassword(password) {
  if (typeof password !== 'string' || Buffer.byteLength(password) < 12 || Buffer.byteLength(password) > 1024) throw new HubError('密码需为 12 至 1024 字节。', 'INVALID_PASSWORD', 400);
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(password, salt, 32)).toString('hex') };
}
export class HubAuth {
  constructor(store, { now = Date.now } = {}) { this.store = store; this.now = now; this.active = 0; this.attempts = new Map(); }
  limit(key) {
    const now = this.now();
    for (const [ip, record] of this.attempts) if (record.expiresAt <= now) this.attempts.delete(ip);
    if (!this.attempts.has(key) && this.attempts.size >= 1024) throw new HubError('请求过于频繁，请稍后重试。', 'RATE_LIMITED', 429);
    const record = this.attempts.get(key) || { count: 0, expiresAt: now + 15 * 60000 };
    record.count++; this.attempts.set(key, record);
    if (record.count > 20) throw new HubError('请求过于频繁，请稍后重试。', 'RATE_LIMITED', 429);
  }
  async work(action) {
    if (this.active >= 4) throw new HubError('登录处理繁忙，请稍后重试。', 'RATE_LIMITED', 429);
    this.active++; try { return await action(); } finally { this.active--; }
  }
  login(name, password) {
    return this.work(async () => {
      if (typeof password !== 'string' || Buffer.byteLength(password) > 1024) throw new HubError('用户名或密码不正确。', 'INVALID_CREDENTIALS', 401);
      let row; try { row = this.store.userByUsername(name); } catch { row = null; }
      const candidate = await scrypt(password, row?.salt || dummySalt, 32);
      if (!row || row.disabled || !timingSafeEqual(candidate, Buffer.from(row.password_hash, 'hex'))) throw new HubError('用户名或密码不正确。', 'INVALID_CREDENTIALS', 401);
      const user = { id: row.id, username: row.username, role: row.role };
      return { user, ...this.store.issueSession(user.id) };
    });
  }
  register(name, password, invite) {
    return this.work(async () => {
      const { salt, hash } = await hashPassword(password);
      const user = this.store.createUser({ name, salt, hash, invite });
      return { user, ...this.store.issueSession(user.id) };
    });
  }
}
