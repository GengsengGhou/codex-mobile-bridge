import { realpath, lstat, access } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { effectivePolicy, readPrivate, reservePrivate, localBridge, validRoot, UUID, fail, definitiveRejection } from './collaboration-common.mjs';

const operations = new Set(['capabilities', 'projects', 'threads', 'read', 'status', 'create', 'send', 'receipt', 'stop', 'files', 'file']);
const fields = ['operation', 'projectId', 'threadId', 'operationId', 'prompt', 'title', 'cursor', 'turnId', 'turnLimit', 'path', 'kind'];
export function createCollaborationExecutor({ root, config, configPath = resolve(root, '.local/hub-connector.json'), bridge = localBridge, readPolicy = () => readPrivate(resolve(root, '.local/computer-collaboration.json')) }) {
  root = resolve(root);
  const journalPath = resolve(root, '.local/collaboration-receipts'); let queue = Promise.resolve();
  const bridgeCall = bridge;
  bridge = (source, path, body, options) => bridgeCall({ ...config, collaborationSourceDeviceId: source }, path, body, options);
  const serialized = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function policy(sourceDeviceId) {
    try { await access(root + '.upgrade-journal.json'); fail('COLLABORATION_UPGRADING', 503); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const current = await readPrivate(configPath);
    if (!current || current.deviceId !== config.deviceId || current.deviceToken !== config.deviceToken || current.hubOrigin !== config.hubOrigin) fail('COLLABORATION_BINDING_CHANGED');
    const p = effectivePolicy(await readPolicy(), config);
    if (!p.receiveEnabled || !p.allowedDeviceIds.includes(sourceDeviceId) || sourceDeviceId === config.deviceId) fail('COLLABORATION_NOT_AUTHORIZED');
    return p;
  }
  async function rootAllowed(path, p) {
    if (!validRoot(path)) return false;
    const absolute = resolve(path);
    try {
      // Reject links/junctions in every segment, including links above the selected directory.
      let current = absolute;
      while (true) { if ((await lstat(current)).isSymbolicLink()) return false; const parent = resolve(current, '..'); if (parent === current) break; current = parent; }
      const canonical = await realpath(absolute);
      return p.allowedProjectRoots.some(root => validRoot(root) && resolve(root) === absolute) && canonical === await realpath(absolute);
    } catch { return false; }
  }
  async function projects(source) {
    const p = await policy(source); const data = await bridge(source, '/api/projects');
    if (!Array.isArray(data.projects)) fail('DESKTOP_PROTOCOL_ERROR', 502);
    const allowed = [];
    for (const project of data.projects) if (project.hostId === 'local' && await rootAllowed(project.path, p)) allowed.push(project);
    await policy(source); return allowed;
  }
  async function thread(source, id) {
    if (!UUID.test(id || '')) fail('INVALID_THREAD', 400);
    const p = await policy(source); const result = await bridge(source, `/api/threads/${id}/metadata`);
    const t = result.thread;
    if (t?.id !== id || t.kind !== 'codex' || t.hostId !== 'local' || t.archived || t.delegated || !validRoot(t.cwd)) fail('THREAD_NOT_AUTHORIZED');
    const candidates = await projects(source);
    const project = candidates.find(project => project.projectId === t.projectId || !t.projectId && resolve(project.path) === resolve(t.cwd));
    if (!project || resolve(t.cwd) !== resolve(project.path) || !await rootAllowed(t.cwd, p)) fail('THREAD_NOT_AUTHORIZED');
    return { result, project };
  }
  async function lookup(source, id) {
    if (!UUID.test(id || '')) fail('INVALID_OPERATION_ID', 400);
    const entry = await readPrivate(resolve(journalPath, id + '.json'));
    if (!entry || entry.sourceDeviceId !== source) return { state: 'not_found', operationId: id };
    if (!(await projects(source)).some(p => p.projectId === entry.projectId && resolve(p.path) === entry.projectRoot)) fail('PROJECT_NOT_AUTHORIZED');
    if (entry.threadId) await thread(source, entry.threadId);
    const result = await bridge(source, entry.operation === 'create' ? `/api/thread-creations/${id}` : `/api/threads/${entry.threadId}/messages/${id}`);
    if (result.receipt) {
      const receipt = result.receipt;
      if (receipt.requestId !== id || entry.operation === 'create' && (receipt.projectId !== entry.projectId || receipt.hostId !== 'local') || entry.operation === 'send' && receipt.threadId !== entry.threadId) fail('DESKTOP_PROTOCOL_ERROR', 502);
      if (entry.operation === 'create') await thread(source, receipt.threadId);
    }
    return { ...result, operationId: id, ...(result.state === 'not_found' ? { state: 'unknown' } : {}) };
  }
  return async function execute({ sourceDeviceId, targetDeviceId, request }) {
    if (!UUID.test(sourceDeviceId || '') || targetDeviceId !== config.deviceId || !request || Object.keys(request).some(k => !fields.includes(k)) || !operations.has(request.operation)) fail('INVALID_COLLABORATION_REQUEST', 400);
    await policy(sourceDeviceId);
    const q = request, source = sourceDeviceId;
    if (q.operation === 'capabilities') return { version: 1, deviceId: config.deviceId, operations: [...operations] };
    if (q.operation === 'projects') return { projects: await projects(source) };
    if (q.operation === 'receipt') return serialized(() => lookup(source, q.operationId));
    if (q.operation === 'threads') {
      const data = await bridge(source, '/api/threads'); if (!Array.isArray(data.threads)) fail('DESKTOP_PROTOCOL_ERROR', 502);
      const candidates = await projects(source); const p = await policy(source);
      const allowed = [];
      // Filter the fresh native metadata list. Avoid transcript hydration for each sidebar item.
      for (const item of data.threads.slice(0, 100)) {
        if (!UUID.test(item?.id || '') || item.kind !== 'codex' || item.hostId !== 'local' || item.archived || item.delegated || !validRoot(item.cwd)) continue;
        const project = candidates.find(project => project.projectId === item.projectId || !item.projectId && resolve(project.path) === resolve(item.cwd));
        if (project && resolve(item.cwd) === resolve(project.path) && await rootAllowed(item.cwd, p)) allowed.push({ id: item.id, title: String(item.title || '').slice(0, 200), kind: 'codex', hostId: 'local', cwd: item.cwd, projectId: project.projectId, status: item.status });
      }
      await policy(source); return { threads: allowed, limitedToRecent: true };
    }
    if (q.operation === 'create' || q.operation === 'send') return serialized(async () => {
      if (!UUID.test(q.operationId || '') || typeof q.prompt !== 'string' || !q.prompt.trim() || q.prompt.length > 12000 || q.title !== undefined && (typeof q.title !== 'string' || q.title.length > 200)) fail('INVALID_OPERATION', 400);
      let project;
      if (q.operation === 'send') project = (await thread(source, q.threadId)).project;
      else project = (await projects(source)).find(p => p.projectId === q.projectId);
      if (!project) fail('PROJECT_NOT_AUTHORIZED');
      const recordPath = resolve(journalPath, q.operationId + '.json');
      const payloadHash = createHash('sha256').update(JSON.stringify(q)).digest('hex'); const previous = await readPrivate(recordPath);
      if (previous) { if (previous.sourceDeviceId !== source || previous.payloadHash !== payloadHash) fail('OPERATION_CONFLICT', 409); return lookup(source, q.operationId); }
      const entry = { sourceDeviceId: source, operation: q.operation, threadId: q.threadId, projectId: project.projectId, projectRoot: resolve(project.path), payloadHash };
      if (!await reservePrivate(recordPath, entry)) { const concurrent = await readPrivate(recordPath); if (concurrent?.sourceDeviceId !== source || concurrent?.payloadHash !== payloadHash) fail('OPERATION_CONFLICT', 409); return lookup(source, q.operationId); }
      await policy(source); if (q.operation === 'send') await thread(source, q.threadId); else if (!(await projects(source)).some(p => p.projectId === project.projectId && resolve(p.path) === resolve(project.path))) fail('PROJECT_NOT_AUTHORIZED');
      let result;
      try { result = await bridge(source, q.operation === 'create' ? '/api/threads' : `/api/threads/${q.threadId}/messages`, { requestId: q.operationId, prompt: q.prompt, ...(q.operation === 'create' ? { projectId: project.projectId, ...(q.title ? { title: q.title } : {}) } : {}) }); }
      catch (e) { return { state: definitiveRejection(e.code) ? 'rejected' : 'unknown', operationId: q.operationId, code: e.code || 'DELIVERY_UNKNOWN', message: definitiveRejection(e.code) ? 'The desktop rejected this request before accepting it.' : 'Query this operation receipt; never replay with a new ID.' }; }
      try {
        await policy(source);
        if (result.requestId !== q.operationId || !UUID.test(result.threadId || '') || q.operation === 'send' && result.threadId !== q.threadId || q.operation === 'create' && (result.projectId !== project.projectId || result.hostId !== 'local')) fail('DESKTOP_PROTOCOL_ERROR', 502);
        await thread(source, result.threadId);
      } catch (e) { return { state: 'unknown', operationId: q.operationId, code: 'DELIVERY_UNKNOWN', reason: e.code || 'POSTFLIGHT_FAILED', message: 'The desktop operation was dispatched, but its current authorization/result cannot be confirmed. Query receipt after restoring authorized access; never replay.' }; }
      return { state: q.operation === 'create' ? 'created' : 'accepted', operationId: q.operationId, receipt: result };
    });
    const { result } = await thread(source, q.threadId);
    let output;
    if (q.operation === 'read') {
      if (q.cursor !== undefined && (typeof q.cursor !== 'string' || q.cursor.length > 4096)) fail('INVALID_CURSOR', 400);
      const turnLimit = q.turnLimit ?? 3; if (!Number.isInteger(turnLimit) || turnLimit < 1 || turnLimit > 10) fail('INVALID_TURN_LIMIT', 400);
      output = await bridge(source, `/api/threads/${q.threadId}?turnLimit=${turnLimit}${q.cursor ? '&cursor=' + encodeURIComponent(q.cursor) : ''}`);
      if (output.thread?.id !== q.threadId || output.thread.cwd !== result.thread.cwd) fail('DESKTOP_PROTOCOL_ERROR', 502);
    } else if (q.operation === 'status' || q.operation === 'stop') {
      const control = await bridge(source, `/api/threads/${q.threadId}/control`);
      if (control.threadId !== q.threadId) fail('DESKTOP_PROTOCOL_ERROR', 502);
      if (q.operation === 'stop') {
        if (typeof q.turnId !== 'string' || !q.turnId || control.turnId !== q.turnId || !control.canStop) fail('RUN_CHANGED', 409);
        await thread(source, q.threadId); await policy(source);
        output = await bridge(source, `/api/threads/${q.threadId}/stop`, { turnId: q.turnId });
        if (output.threadId !== q.threadId || output.turnId !== q.turnId) fail('DESKTOP_PROTOCOL_ERROR', 502);
      } else output = { threadId: q.threadId, status: result.thread.status, available: control.available, turnId: control.turnId, needsAttention: control.pendingRequestCount > 0, canStop: control.canStop, ...(control.code ? { code: control.code } : {}) };
    } else {
      if (typeof q.path !== 'string' || q.path.length > 4096 || q.path.includes('\\') || q.path.includes(':') || q.path.startsWith('/') || q.path.split('/').some(s => s === '..' || s.startsWith('.')) || /[\x00-\x1f]/.test(q.path)) fail('FILE_NOT_AUTHORIZED');
      if (q.operation === 'files') output = await bridge(source, `/api/threads/${q.threadId}/files?path=${encodeURIComponent(q.path)}`);
      else {
        const path = `/api/threads/${q.threadId}/file?path=${encodeURIComponent(q.path)}`;
        const info = await bridge(source, path);
        if (!['text', 'image', 'pdf'].includes(info.previewKind) || info.size > 1024 * 1024 || info.path !== q.path) fail('FILE_NOT_AUTHORIZED');
        await thread(source, q.threadId); await policy(source);
        const bytes = await bridge(source, path + '&mode=download', undefined, { binary: true, maxBytes: 1024 * 1024 });
        if (bytes.length !== info.size) fail('FILE_CHANGED', 409);
        output = { threadId: q.threadId, path: info.path, name: info.name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.toString('base64') };
      }
    }
    await thread(source, q.threadId); await policy(source); return output;
  };
}
