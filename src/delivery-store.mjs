import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './desktop.mjs';

export const DELIVERY_LIMIT = 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new BridgeError('发送记录无法安全保存或读取，请检查本机配置。', 'DELIVERY_STORE_UNAVAILABLE', 503);
export const promptHash = prompt => createHash('sha256').update(prompt, 'utf8').digest('hex');

function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.deliveries) || value.deliveries.length > DELIVERY_LIMIT) throw unavailable();
  const entries = new Map();
  for (const entry of value.deliveries) {
    if (!entry || !UUID.test(entry.requestId ?? '') || !UUID.test(entry.threadId ?? '') ||
        !/^[a-f0-9]{64}$/.test(entry.promptHash ?? '') || !['pending', 'unknown', 'accepted'].includes(entry.state) ||
        typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt)) || entries.has(entry.requestId)) throw unavailable();
    if (entry.state === 'accepted' && (entry.receipt?.accepted !== true || entry.receipt.threadId !== entry.threadId ||
        entry.receipt.requestId !== entry.requestId || typeof entry.receipt.acceptedAt !== 'string' || !Number.isFinite(Date.parse(entry.receipt.acceptedAt)) ||
        entry.receipt.permissionMode !== undefined && !['request-approval', 'full-access'].includes(entry.receipt.permissionMode))) throw unavailable();
    // Copy only journal fields; raw prompts and arbitrary host output never enter storage.
    entries.set(entry.requestId, { requestId: entry.requestId, threadId: entry.threadId, promptHash: entry.promptHash,
      state: entry.state, createdAt: entry.createdAt, ...(entry.state === 'accepted' ? { receipt: {
        accepted: true, threadId: entry.threadId, requestId: entry.requestId, acceptedAt: entry.receipt.acceptedAt,
        ...(entry.receipt.permissionMode !== undefined ? { permissionMode: entry.receipt.permissionMode } : {}),
      } } : {}) });
  }
  return entries;
}

export class DeliveryStore {
  // A null path is an isolated in-memory ledger for embedded servers and tests.
  constructor({ path = fileURLToPath(new URL('../.local/deliveries.json', import.meta.url)) } = {}) {
    this.path = path; this.entries = null; this.queue = Promise.resolve();
  }
  serialize(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  async load() {
    if (this.entries) return;
    if (!this.path) { this.entries = new Map(); return; }
    try { this.entries = validate(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') this.entries = new Map(); else throw unavailable(); }
  }
  async persist(entries) {
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let file;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ version: 1, deliveries: [...entries.values()] }) + '\n');
      await file.sync(); await file.close(); file = null;
      await rename(temporary, this.path);
    } catch { throw unavailable(); }
    finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  get(requestId) {
    return this.serialize(async () => { await this.load(); return structuredClone(this.entries.get(requestId)); });
  }
  reserve({ requestId, threadId, promptHash: hash }) {
    return this.serialize(async () => {
      await this.load();
      if (this.entries.has(requestId)) throw new BridgeError('请求 ID 已保留，请先核对发送结果。', 'CONFLICT', 409);
      if (this.entries.size >= DELIVERY_LIMIT) throw new BridgeError('发送记录已达到上限，请检查本机配置。', 'LIMIT_REACHED', 429);
      const entry = { requestId, threadId, promptHash: hash, state: 'pending', createdAt: new Date().toISOString() };
      const next = new Map(this.entries); next.set(requestId, entry);
      await this.persist(next); this.entries = next;
    });
  }
  accept(requestId, receipt) {
    return this.update(requestId, entry => ({ ...entry, state: 'accepted', receipt: structuredClone(receipt) }));
  }
  remove(requestId) { return this.update(requestId, () => null); }
  update(requestId, transform) {
    return this.serialize(async () => {
      await this.load();
      const current = this.entries.get(requestId);
      if (!current) throw unavailable();
      const next = new Map(this.entries), entry = transform(current);
      if (entry) next.set(requestId, entry); else next.delete(requestId);
      await this.persist(next); this.entries = next;
    });
  }
}
