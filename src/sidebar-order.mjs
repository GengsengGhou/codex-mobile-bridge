import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError } from './desktop.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const empty = () => ({ revision: 0, order: { projects: [], threads: {} } });
export function validateOrder(order) {
  const invalid = () => { throw new BridgeError('排序数据无效，请刷新列表后重试。', 'INVALID_REQUEST', 400); };
  const record = value => value && typeof value === 'object' && !Array.isArray(value);
  const group = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !['__proto__', 'constructor', 'prototype'].includes(value);
  if (!record(order) || !Array.isArray(order.projects) || order.projects.length > 256 || !record(order.threads)) invalid();
  if (!order.projects.every(group) || new Set(order.projects).size !== order.projects.length || Object.keys(order.threads).length > 256) invalid();
  let total = 0;
  const threads = Object.create(null);
  for (const [key, ids] of Object.entries(order.threads)) {
    if (!group(key) || !Array.isArray(ids) || ids.length > 1000 || !ids.every(id => typeof id === 'string' && UUID.test(id)) || new Set(ids).size !== ids.length) invalid();
    total += ids.length; if (total > 10000) invalid();
    threads[key] = [...ids];
  }
  return { projects: [...order.projects], threads };
}

export class SidebarOrderStore {
  constructor(path = fileURLToPath(new URL('../.local/sidebar-order.json', import.meta.url))) {
    this.path = path; this.queue = Promise.resolve();
  }
  async read() {
    try {
      const saved = JSON.parse(await readFile(this.path, 'utf8'));
      if (!Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('revision');
      return { revision: saved.revision, order: validateOrder(saved.order) };
    } catch (error) {
      if (error.code === 'ENOENT') return empty();
      throw new BridgeError('已保存的网页排序无法读取，请检查本机配置。', 'ORDER_UNAVAILABLE', 503);
    }
  }
  save(value) {
    const next = this.queue.then(async () => {
      if (!Number.isSafeInteger(value?.revision) || value.revision < 0) throw new BridgeError('缺少排序版本，请刷新后重试。', 'INVALID_REQUEST', 400);
      const order = validateOrder(value.order);
      const current = await this.read();
      if (value.revision !== current.revision) throw new BridgeError('排序已在另一个页面更新，已保留新顺序，请刷新后重试。', 'ORDER_CONFLICT', 409);
      const saved = { revision: current.revision + 1, order };
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(saved) + '\n', { mode: 0o600 });
      await rename(temporary, this.path);
      return saved;
    });
    this.queue = next.catch(() => {});
    return next;
  }
}
