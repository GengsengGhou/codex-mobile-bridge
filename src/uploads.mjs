import { mkdir, open, readFile, rename, rm, realpath, lstat, link } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { BridgeError } from './desktop.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UPLOAD_LIMIT = 20 * 1024 * 1024;
const fail = (message, code = 'UPLOAD_FORBIDDEN', status = 403) => { throw new BridgeError(message, code, status); };
const unavailable = () => new BridgeError('上传记录无法安全读取或保存', 'UPLOAD_STORE_UNAVAILABLE', 503);
const inside = (root, candidate) => { const relative = path.relative(root, candidate); return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || Buffer.byteLength(name) > 240 || /[\x00-\x1f\x7f\\/:<>"|?*]/.test(name) || /^[. ]|[. ]$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || /^(?:credentials|secrets?|id_(?:rsa|dsa|ecdsa|ed25519))(?:\.|$)/i.test(name) || /^(?:node_modules|system volume information|\$recycle\.bin)$/i.test(name) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(name)) fail('文件名无效或不允许上传', 'INVALID_UPLOAD', 400);
  return name;
}
export function uploadMetadata(params) {
  const name = safeName(params.get('name'));
  const sizeText = params.get('size'), sha256 = params.get('sha256');
  if (!/^(?:0|[1-9]\d*)$/.test(sizeText ?? '') || !/^[a-f0-9]{64}$/.test(sha256 ?? '')) fail('上传大小或校验值无效', 'INVALID_UPLOAD', 400);
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size) || size > UPLOAD_LIMIT) fail('附件超过 20 MiB 大小限制', 'UPLOAD_TOO_LARGE', 413);
  return { name, size, sha256 };
}
function validateJournal(data) {
  if (data?.version !== 1 || !Array.isArray(data.uploads) || data.uploads.length > 500) throw unavailable();
  const entries = new Map(); let total = 0;
  for (const e of data.uploads) {
    if (!e || !UUID.test(e.uploadId ?? '') || !UUID.test(e.threadId ?? '') || entries.has(e.uploadId) || !['pending', 'uploaded'].includes(e.state) || !path.isAbsolute(e.cwd ?? '') || !path.isAbsolute(e.rootReal ?? '') || !Number.isInteger(e.size) || e.size < 0 || e.size > UPLOAD_LIMIT || !/^[a-f0-9]{64}$/.test(e.sha256 ?? '') || !Number.isFinite(Date.parse(e.createdAt))) throw unavailable();
    try { safeName(e.name); } catch { throw unavailable(); }
    if (e.directoryIdentity != null && (typeof e.directoryIdentity !== 'string' || !/^\d+$/.test(e.directoryIdentity))) throw unavailable();
    if (e.state === 'uploaded' && (e.receipt?.uploaded !== true || e.receipt.uploadId !== e.uploadId || e.receipt.threadId !== e.threadId || e.receipt.name !== e.name || e.receipt.size !== e.size || e.receipt.sha256 !== e.sha256 || e.receipt.path !== `mobile-uploads/${e.uploadId}/${e.name}` || e.receipt.absolutePath !== path.join(e.cwd, 'mobile-uploads', e.uploadId, e.name) || !Number.isFinite(Date.parse(e.receipt.uploadedAt)))) throw unavailable();
    entries.set(e.uploadId, structuredClone(e)); total += e.size;
  }
  if (total > 1024 * 1024 * 1024) throw unavailable();
  return entries;
}
export class UploadStore {
  constructor({ path: storePath = fileURLToPath(new URL('../.local/uploads.json', import.meta.url)) } = {}) { this.path = storePath; this.entries = null; this.queue = Promise.resolve(); }
  serialize(operation) { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  async load() {
    if (this.entries) return;
    if (!this.path) { this.entries = new Map(); return; }
    try { this.entries = validateJournal(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') this.entries = new Map(); else throw unavailable(); }
  }
  async persist(entries) {
    if (!this.path) return;
    const temporary = `${this.path}.${randomUUID()}.tmp`; let handle;
    try {
      await mkdir(path.dirname(this.path), { recursive: true });
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: 1, uploads: [...entries.values()] }) + '\n');
      await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, this.path);
    } catch { throw unavailable(); }
    finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
  }
  get(id) { return this.serialize(async () => { await this.load(); return structuredClone(this.entries.get(id)); }); }
  reserve(entry) {
    return this.serialize(async () => {
      await this.load();
      if (this.entries.has(entry.uploadId)) fail('上传 ID 已保留', 'UPLOAD_CONFLICT', 409);
      const total = [...this.entries.values()].reduce((sum, e) => sum + e.size, 0);
      if (this.entries.size >= 500 || total + entry.size > 1024 * 1024 * 1024) fail('上传存储已达到上限', 'UPLOAD_LIMIT_REACHED', 429);
      const next = new Map(this.entries); next.set(entry.uploadId, structuredClone(entry));
      await this.persist(next); this.entries = next;
    });
  }
  update(id, fields) {
    return this.serialize(async () => {
      await this.load(); const current = this.entries.get(id);
      if (!current) throw unavailable();
      const entry = { ...current, ...structuredClone(fields) }, next = new Map(this.entries); next.set(id, entry);
      await this.persist(next); this.entries = next; return structuredClone(entry);
    });
  }
}
async function workspace(thread) {
  if (thread?.kind !== 'codex' || (thread.hostId && thread.hostId !== 'local') || thread.archived || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) fail('此会话未开放本机附件上传');
  const cwd = path.resolve(thread.cwd);
  if (cwd === path.parse(cwd).root || /^\\\\|^\/\//.test(cwd)) fail('工作目录不允许上传');
  const stat = await lstat(cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('工作目录不允许上传');
  return { cwd, rootReal: await realpath(cwd) };
}
async function directory(entry, create = false, store) {
  const current = await workspace({ kind: 'codex', hostId: 'local', cwd: entry.cwd });
  if (current.rootReal !== entry.rootReal) fail('会话工作目录已改变', 'UPLOAD_WORKSPACE_CHANGED', 409);
  const parent = path.join(entry.cwd, 'mobile-uploads'), destination = path.join(parent, entry.uploadId);
  if (create) {
    try { await mkdir(parent); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const parentStat = await lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || !inside(entry.rootReal, await realpath(parent))) fail('上传目录不允许访问');
  if (create && !entry.directoryIdentity) {
    try { await mkdir(destination); }
    catch (error) { if (error.code === 'EEXIST') fail('上传目录已存在，无法确认归属', 'UPLOAD_UNKNOWN', 409); throw error; }
    const stat = await lstat(destination, { bigint: true });
    entry = await store.update(entry.uploadId, { directoryIdentity: String(stat.ino) });
  }
  const stat = await lstat(destination, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || !inside(entry.rootReal, await realpath(destination))) fail('上传目录不允许访问');
  if (!entry.directoryIdentity || String(stat.ino) !== entry.directoryIdentity) fail('上传目录无法确认归属', 'UPLOAD_UNKNOWN', 409);
  return { entry, destination, final: path.join(destination, entry.name) };
}
async function finalState(entry, file) {
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return 'absent'; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) return 'changed';
  const handle = await open(file, 'r');
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== stat.ino || opened.size !== entry.size) return 'changed';
    const hash = createHash('sha256'); let count = 0;
    if (entry.size) {
      for await (const chunk of handle.createReadStream({ autoClose: false, end: entry.size - 1 })) { hash.update(chunk); count += chunk.length; }
    }
    return count === entry.size && hash.digest('hex') === entry.sha256 ? 'valid' : 'changed';
  } finally { await handle.close(); }
}
function receiptFor(entry) {
  return { uploaded: true, uploadId: entry.uploadId, threadId: entry.threadId, name: entry.name, size: entry.size, sha256: entry.sha256, path: `mobile-uploads/${entry.uploadId}/${entry.name}`, absolutePath: path.join(entry.cwd, 'mobile-uploads', entry.uploadId, entry.name), uploadedAt: entry.createdAt };
}
export class UploadManager {
  constructor(store) { this.store = store; this.busy = new Set(); }
  async lookup(thread, uploadId) {
    try {
      const current = await workspace(thread);
      const entry = await this.store.get(uploadId);
      if (!entry || entry.threadId !== thread.id) return { state: 'not_found' };
      if (current.cwd !== entry.cwd || current.rootReal !== entry.rootReal) fail('会话工作目录已改变', 'UPLOAD_WORKSPACE_CHANGED', 409);
      if (this.busy.has(uploadId)) return { state: 'uploading' };
      let paths;
      try { paths = await directory(entry); } catch (error) {
        if (error.code === 'ENOENT' && entry.state === 'pending') return { state: 'unknown' };
        if (error.code === 'ENOENT') fail('已上传附件缺失', 'UPLOAD_FILE_CHANGED', 409);
        throw error;
      }
      const state = await finalState(entry, paths.final);
      if (state === 'valid') {
        const receipt = entry.receipt ?? receiptFor(entry);
        if (entry.state !== 'uploaded') await this.store.update(uploadId, { state: 'uploaded', receipt });
        return { state: 'uploaded', receipt };
      }
      if (entry.state === 'uploaded') fail('已上传附件缺失或已改变', 'UPLOAD_FILE_CHANGED', 409);
      return { state: 'unknown' };
    } catch (error) { throw publicError(error); }
  }
  async upload(thread, uploadId, meta, req) {
    if (this.busy.has(uploadId)) fail('上传正在进行，请查询结果', 'UPLOAD_BUSY', 409);
    this.busy.add(uploadId); let temporary, handle;
    try {
      const current = await workspace(thread);
      let entry = await this.store.get(uploadId);
      if (entry) {
        if (entry.threadId !== thread.id || entry.name !== meta.name || entry.size !== meta.size || entry.sha256 !== meta.sha256) fail('上传 ID 已用于其他文件', 'UPLOAD_CONFLICT', 409);
        if (entry.cwd !== current.cwd || entry.rootReal !== current.rootReal) fail('会话工作目录已改变', 'UPLOAD_WORKSPACE_CHANGED', 409);
      } else {
        entry = { ...meta, ...current, uploadId, threadId: thread.id, state: 'pending', createdAt: new Date().toISOString(), directoryIdentity: null };
        await this.store.reserve(entry);
      }
      const paths = await directory(entry, true, this.store); entry = paths.entry;
      const existing = await finalState(entry, paths.final);
      if (existing === 'valid') {
        req.resume(); const receipt = entry.receipt ?? receiptFor(entry);
        if (entry.state !== 'uploaded') await this.store.update(uploadId, { state: 'uploaded', receipt });
        return receipt;
      }
      if (existing !== 'absent' || entry.state === 'uploaded') fail('已上传附件已改变或结果无法确认', entry.state === 'uploaded' ? 'UPLOAD_FILE_CHANGED' : 'UPLOAD_UNKNOWN', 409);
      await directory(entry);
      temporary = path.join(paths.destination, `.upload-${randomUUID()}.tmp`);
      handle = await open(temporary, 'wx', 0o600);
      let count = 0; const hash = createHash('sha256');
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        count += chunk.length;
        if (count > meta.size || count > UPLOAD_LIMIT) { req.resume(); fail('上传内容超过声明大小', 'UPLOAD_TOO_LARGE', 413); }
        hash.update(chunk); await handle.writeFile(chunk);
      }
      if (req.aborted || count !== meta.size || hash.digest('hex') !== meta.sha256) fail('上传未完成或校验失败', 'UPLOAD_INTEGRITY', 400);
      await handle.sync(); await handle.close(); handle = null;
      await directory(entry);
      try { await link(temporary, paths.final); }
      catch (error) { if (error.code === 'EEXIST') fail('上传文件已存在，未覆盖', 'UPLOAD_UNKNOWN', 409); throw error; }
      await rm(temporary); temporary = null;
      const receipt = receiptFor(entry);
      await this.store.update(uploadId, { state: 'uploaded', receipt });
      return receipt;
    } catch (error) { throw publicError(error); }
    finally {
      await handle?.close().catch(() => {});
      if (temporary) await rm(temporary, { force: true }).catch(() => {});
      this.busy.delete(uploadId);
    }
  }
}
function publicError(error) {
  if (error instanceof BridgeError) return error;
  if (['ECONNRESET', 'ABORT_ERR'].includes(error.code)) return new BridgeError('上传连接已中断，请查询结果后重试', 'UPLOAD_INTERRUPTED', 400);
  return new BridgeError('无法安全保存或读取附件', 'UPLOAD_UNAVAILABLE', 503);
}
