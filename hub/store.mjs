import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { HubError } from './errors.mjs';

export const secretHash = value => createHash('sha256').update(String(value)).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const USERNAME = /^[a-z0-9._-]{3,64}$/;
export function username(value) {
  if (typeof value !== 'string' || !USERNAME.test(value.toLowerCase())) throw new HubError('用户名需为 3 至 64 个字母、数字或 ._-。', 'INVALID_REQUEST', 400);
  return value.toLowerCase();
}
export function deviceName(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80 || /[\x00-\x1f\x7f]/.test(value)) throw new HubError('设备名称需为 1 至 80 个字符。', 'INVALID_REQUEST', 400);
  return value.trim();
}
const publicUser = row => row ? { id: row.id, username: row.username, role: row.role } : null;

export class HubStore {
  constructor({ path = ':memory:', now = Date.now, maxUsers = 256, maxDeviceRecords = 4096, revokedRetentionDays = 7 } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path); this.now = now; this.maxUsers = maxUsers; this.maxDeviceRecords = maxDeviceRecords; this.revokedRetentionMs = revokedRetentionDays * 86400000;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_size_limit=1048576; PRAGMA wal_autocheckpoint=100;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')), salt TEXT NOT NULL, password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invitations(hash TEXT PRIMARY KEY, creator_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairings(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id); CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);`);
    if (!this.db.prepare('PRAGMA table_info(devices)').all().some(column => column.name === 'revoked_at')) this.db.exec('ALTER TABLE devices ADD COLUMN revoked_at INTEGER');
    // Older revoked rows get a full retention window from migration, not creation.
    this.db.prepare('UPDATE devices SET revoked_at=? WHERE revoked=1 AND revoked_at IS NULL').run(this.now());
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = action(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  userByUsername(name) { return this.db.prepare('SELECT * FROM users WHERE username=?').get(username(name)); }
  createUser({ name, salt, hash, role = 'user', invite = null, initialAdmin = false }) {
    const normalized = username(name);
    return this.transaction(() => {
      if (initialAdmin && this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n !== 0) throw new HubError('管理员已初始化，请使用现有管理员邀请注册。', 'ALREADY_INITIALIZED', 409);
      if (this.userByUsername(normalized)) throw new HubError('用户名已被使用。', 'USERNAME_TAKEN', 409);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= this.maxUsers) throw new HubError('账号数量已达到入口上限。', 'LIMIT_REACHED', 429);
      if (!initialAdmin) {
        const consumed = this.db.prepare('UPDATE invitations SET used_at=? WHERE hash=? AND used_at IS NULL AND expires_at>?').run(this.now(), secretHash(invite), this.now());
        if (consumed.changes !== 1) throw new HubError('邀请码已失效或已使用。', 'INVALID_INVITE', 400);
        role = 'user';
      } else if (role !== 'admin') throw new HubError('初始化必须创建管理员。', 'INVALID_REQUEST', 400);
      const id = randomUUID();
      this.db.prepare('INSERT INTO users(id,username,role,salt,password_hash,created_at) VALUES(?,?,?,?,?,?)').run(id, normalized, role, salt, hash, this.now());
      return { id, username: normalized, role };
    });
  }
  session(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT users.*, sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND sessions.expires_at>? AND users.disabled=0').get(secretHash(token), this.now());
    return row ? { user: publicUser(row), expiresAt: row.expires_at } : null;
  }
  issueSession(userId) {
    const token = secret(), expiresAt = this.now() + 7 * 86400000;
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(this.now());
      this.db.prepare('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 9)').run(userId, userId);
      this.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(secretHash(token), userId, expiresAt, this.now());
    });
    return { token, expiresAt };
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(secretHash(token)); }
  invite(userId) {
    const row = this.db.prepare("SELECT id FROM users WHERE id=? AND role='admin' AND disabled=0").get(userId);
    if (!row) throw new HubError('只有管理员可以创建邀请。', 'FORBIDDEN', 403);
    const pending = this.db.prepare('SELECT COUNT(*) AS n FROM invitations WHERE used_at IS NULL AND expires_at>?').get(this.now()).n;
    if (pending >= 50) throw new HubError('未使用的邀请已达到上限。', 'LIMIT_REACHED', 429);
    const invite = secret(), expiresAt = this.now() + 86400000;
    this.db.prepare('INSERT INTO invitations VALUES(?,?,?,NULL)').run(secretHash(invite), userId, expiresAt);
    return { invite, expiresAt };
  }
  pairing(userId, name = '我的电脑') {
    const validName = deviceName(name);
    const pending = this.db.prepare('SELECT COUNT(*) AS n FROM pairings WHERE user_id=? AND used_at IS NULL AND expires_at>?').get(userId, this.now()).n;
    if (pending >= 3) throw new HubError('请先使用已有配对码或等待其过期。', 'LIMIT_REACHED', 429);
    const pairingCode = secret(), expiresAt = this.now() + 600000;
    this.db.prepare('INSERT INTO pairings VALUES(?,?,?,?,NULL)').run(secretHash(pairingCode), userId, validName, expiresAt);
    return { pairingCode, expiresAt };
  }
  consumePairing(code, name) {
    return this.transaction(() => {
      const pairing = this.db.prepare('SELECT * FROM pairings WHERE hash=? AND used_at IS NULL AND expires_at>?').get(secretHash(code), this.now());
      const owner = pairing && this.db.prepare('SELECT id FROM users WHERE id=? AND disabled=0').get(pairing.user_id);
      if (!owner) throw new HubError('配对码已失效或已使用。', 'INVALID_PAIRING', 400);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n >= this.maxDeviceRecords) throw new HubError('入口设备记录已达到上限，请等待过期记录清理。', 'LIMIT_REACHED', 429);
      if (this.devices(pairing.user_id).length >= 10) throw new HubError('账号最多绑定 10 台设备。', 'LIMIT_REACHED', 429);
      const validName = name === undefined ? pairing.name : deviceName(name);
      this.db.prepare('UPDATE pairings SET used_at=? WHERE hash=? AND used_at IS NULL').run(this.now(), pairing.hash);
      const deviceId = randomUUID(), deviceToken = secret();
      this.db.prepare('INSERT INTO devices(id,user_id,name,token_hash,created_at) VALUES(?,?,?,?,?)').run(deviceId, pairing.user_id, validName, secretHash(deviceToken), this.now());
      return { deviceId, deviceToken };
    });
  }
  devices(userId) { return this.db.prepare('SELECT id,name,created_at AS createdAt,revoked FROM devices WHERE user_id=? AND revoked=0 ORDER BY created_at,id').all(userId).map(row => ({ ...row, revoked: false })); }
  device(id, userId) {
    const row = this.db.prepare('SELECT devices.*,users.disabled FROM devices JOIN users ON users.id=devices.user_id WHERE devices.id=? AND devices.revoked=0 AND users.disabled=0').get(id);
    if (!row || (userId !== undefined && row.user_id !== userId)) return null;
    return { id: row.id, userId: row.user_id, name: row.name, createdAt: row.created_at, revoked: false };
  }
  authenticateDevice(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.db.prepare('SELECT id FROM devices WHERE token_hash=? AND revoked=0').get(secretHash(token));
    return row ? this.device(row.id) : null;
  }
  renameDevice(userId, id, name) {
    if (!this.device(id, userId)) throw new HubError('设备不存在。', 'NOT_FOUND', 404);
    this.db.prepare('UPDATE devices SET name=? WHERE id=? AND user_id=?').run(deviceName(name), id, userId);
    return this.device(id, userId);
  }
  revokeDevice(userId, id) {
    if (!this.device(id, userId)) throw new HubError('设备不存在。', 'NOT_FOUND', 404);
    this.db.prepare('UPDATE devices SET revoked=1,revoked_at=? WHERE id=? AND user_id=?').run(this.now(), id, userId);
  }
  maintenance() {
    const now = this.now();
    const removed = this.transaction(() => ({
      sessions: this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(now).changes,
      invitations: this.db.prepare('DELETE FROM invitations WHERE expires_at<=? OR used_at IS NOT NULL').run(now).changes,
      pairings: this.db.prepare('DELETE FROM pairings WHERE expires_at<=? OR used_at IS NOT NULL').run(now).changes,
      devices: this.db.prepare('DELETE FROM devices WHERE revoked=1 AND revoked_at IS NOT NULL AND revoked_at<=?').run(now - this.revokedRetentionMs).changes,
    }));
    // Reuse freed database pages; truncate the sidecar after the infrequent sweep.
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return removed;
  }
  close() { this.db.close(); }
}
