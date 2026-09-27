import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './desktop.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unavailable = () => new BridgeError('新建记录无法安全保存或读取', 'CREATION_STORE_UNAVAILABLE', 503);
const validReceipt = (r, id) => r?.created === true && r.requestId === id && UUID.test(r.threadId ?? '') && r.hostId === 'local' &&
  (r.projectId === null || typeof r.projectId === 'string') && Number.isFinite(Date.parse(r.createdAt));

export class CreationStore {
  constructor({ path = fileURLToPath(new URL('../.local/thread-creations.json', import.meta.url)) } = {}) {
    this.path = path; this.entries = null; this.queue = Promise.resolve();
  }
  serialize(operation) {
    const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result;
  }
  async load() {
    if (this.entries) return;
    if (!this.path) { this.entries = new Map(); return; }
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.creations) || value.creations.length > 1000) throw unavailable();
      const entries = new Map();
      for (const e of value.creations) {
        if (!UUID.test(e.requestId ?? '') || !/^[a-f0-9]{64}$/.test(e.payloadHash ?? '') || !['pending', 'created'].includes(e.state) ||
            !Number.isFinite(Date.parse(e.createdAt)) || entries.has(e.requestId) || (e.state === 'created' && !validReceipt(e.receipt, e.requestId))) throw unavailable();
        entries.set(e.requestId, { requestId: e.requestId, payloadHash: e.payloadHash, state: e.state, createdAt: e.createdAt,
          ...(e.state === 'created' ? { receipt: { created: true, requestId: e.requestId, threadId: e.receipt.threadId, hostId: 'local', projectId: e.receipt.projectId, createdAt: e.receipt.createdAt } } : {}) });
      }
      this.entries = entries;
    } catch (error) { if (error.code === 'ENOENT') this.entries = new Map(); else throw unavailable(); }
  }
  async persist(entries) {
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`; let file;
    try {
      await mkdir(dirname(this.path), { recursive: true }); file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ version: 1, creations: [...entries.values()] }) + '\n');
      await file.sync(); await file.close(); file = null; await rename(temporary, this.path);
    } catch { throw unavailable(); }
    finally { await file?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  get(id) { return this.serialize(async () => { await this.load(); return structuredClone(this.entries.get(id)); }); }
  recent() { return this.serialize(async () => { await this.load(); return [...this.entries.values()].filter(e => e.state === 'created').slice(-50).reverse().map(e => structuredClone(e.receipt)); }); }
  reserve({ requestId, payloadHash }) {
    return this.serialize(async () => {
      await this.load();
      if (this.entries.has(requestId)) throw new BridgeError('新建请求已保留', 'CONFLICT', 409);
      if (this.entries.size >= 1000) throw new BridgeError('新建记录已达到上限', 'LIMIT_REACHED', 429);
      const next = new Map(this.entries); next.set(requestId, { requestId, payloadHash, state: 'pending', createdAt: new Date().toISOString() });
      await this.persist(next); this.entries = next;
    });
  }
  accept(id, receipt) {
    return this.serialize(async () => {
      await this.load(); if (!this.entries.has(id) || !validReceipt(receipt, id)) throw unavailable();
      const next = new Map(this.entries); next.set(id, { ...next.get(id), state: 'created', receipt: structuredClone(receipt) });
      await this.persist(next); this.entries = next;
    });
  }
}
