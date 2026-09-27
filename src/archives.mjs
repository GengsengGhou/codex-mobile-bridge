import { BridgeError } from './desktop.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validLocal = t => t?.kind === 'codex' && t.hostId === 'local' && UUID.test(t.id ?? '');

export function createArchiveHandler({ bridge, inScope }) {
  // A restore can only target a recently listed local archive. No client-supplied host.
  const listed = new Map(), restoring = new Set();
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  return async function handleArchives(req, res, url) {
    const restore = url.pathname.match(/^\/api\/archives\/([^/]+)\/restore$/);
    if (url.pathname !== '/api/archives' && !restore) return false;
    const names = await bridge.capabilities();
    if (!names.includes('list_archived_threads') || typeof bridge.call !== 'function') throw new BridgeError('当前桌面不支持读取归档会话', 'ARCHIVES_UNAVAILABLE', 503);
    for (const [id, at] of listed) if (Date.now() - at > 10 * 60 * 1000) listed.delete(id);
    if (!restore) {
      if (req.method !== 'GET') throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
      const cursor = url.searchParams.get('cursor');
      if (cursor && (cursor.length > 512 || /[\x00-\x1f]/.test(cursor))) throw new BridgeError('归档分页参数无效', 'INVALID_REQUEST', 400);
      const data = await bridge.call('list_archived_threads', { source: 'codex', hostId: 'local', limit: 30, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(data?.threads) || (data.nextCursor != null && (typeof data.nextCursor !== 'string' || data.nextCursor.length > 512))) throw new BridgeError('归档列表格式不兼容', 'PROTOCOL_ERROR', 502);
      const threads = data.threads.filter(validLocal).map(t => {
        listed.delete(t.id); listed.set(t.id, Date.now());
        const canRestore = inScope(t.id) && names.includes('set_thread_archived');
        return { id: t.id, title: typeof t.title === 'string' && t.title ? t.title : '未命名会话', cwd: typeof t.cwd === 'string' ? t.cwd : '', updatedAt: t.updatedAt, canRestore };
      });
      while (listed.size > 1000) listed.delete(listed.keys().next().value);
      json(res, 200, { threads, nextCursor: data.nextCursor || null }); return true;
    }
    if (req.method !== 'POST') throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
    const id = restore[1];
    if (!UUID.test(id)) throw new BridgeError('无效的会话地址', 'INVALID_REQUEST', 400);
    if (!inScope(id) || !names.includes('set_thread_archived')) throw new BridgeError('当前范围未开放恢复归档', 'RESTORE_DISABLED', 403);
    if (!listed.has(id)) throw new BridgeError('请刷新归档列表后再恢复', 'ARCHIVE_STALE', 409);
    if (restoring.has(id)) throw new BridgeError('此会话正在恢复，请稍后刷新核对', 'RESTORE_BUSY', 409);
    if (req.headers['content-length'] && req.headers['content-length'] !== '0' || req.headers['transfer-encoding']) throw new BridgeError('恢复请求不应包含正文', 'INVALID_REQUEST', 400);
    restoring.add(id);
    try {
      const { thread } = await bridge.read(id, undefined, { turnLimit: 1 });
      if (!validLocal(thread) || thread.id !== id) throw new BridgeError('此会话不是本机 Codex 会话', 'RESTORE_DISABLED', 403);
      // Consume the grant before dispatch. An ambiguous result must be checked by listing again.
      listed.delete(id);
      await bridge.manage(id, 'archive', false);
      json(res, 200, { accepted: true, threadId: id, archived: false }); return true;
    } finally { restoring.delete(id); }
  };
}
