import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { BridgeError, DesktopBridge, THREAD_MANAGEMENT_TOOLS } from './desktop.mjs';
import { createDesktopRequest } from './discovery.mjs';
import { loadRuntimeConfig } from './runtime.mjs';
import { SidebarOrderStore } from './sidebar-order.mjs';
import { DeliveryStore, promptHash } from './delivery-store.mjs';
import { DesktopControl } from './desktop-control.mjs';
import { publicPendingRequest } from './pending-requests.mjs';
import { CreationStore } from './creation-store.mjs';
import { listThreadFiles, serveThreadFile } from './thread-files.mjs';
import { UploadStore, UploadManager, uploadMetadata } from './uploads.mjs';
import { createArchiveHandler } from './archives.mjs';
import { createRecoveryManager } from './recovery.mjs';
import { createRemoteAccessManager } from './remote-access.mjs';
import { advertisedModels, modelSelection, validateModelSelection } from './model-settings.mjs';
import { permissionSelection, permissionOptions } from './permission-settings.mjs';
import { readGitContext, hydrateAgentContext } from './thread-context.mjs';
import { publicAssets, assetContentType, appCsp } from './static-assets.mjs';

const publicRoot = new URL('../public/', import.meta.url);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ownerStandby(error, thread) {
  return error.code === 'OWNER_UNAVAILABLE' && error.controlDiagnostic?.reason === 'no-client-found' && String(thread?.status).toLowerCase() === 'notloaded';
}
function ownerReadReason(error, subject, canSend, thread) {
  const reason = error.controlDiagnostic?.reason;
  if (ownerStandby(error, thread)) {
    return `会话待命${canSend ? '，发送时沿用桌面设置' : '，运行状态尚未载入'}`;
  }
  const message = reason === 'request-timeout' ? `读取${subject}超时，可刷新重试`
    : ['client-disconnected', 'server-closed'].includes(reason) ? `${subject}连接已断开，正在重试`
      : `暂时无法读取${subject}，可刷新重试`;
  return `${message}${canSend ? '；沿用桌面设置仍可发送消息' : ''}`;
}
async function creationSupplementRead(operation) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new BridgeError('新会话补充读取超时', 'CREATION_SUPPLEMENT_TIMEOUT', 503)), 300);
    })]);
  } finally { clearTimeout(timer); }
}
export function createBridgeServer({ bridge, enableSend = false, allowedSendThreadId = bridge.callerThreadId, sendScope = 'single', orderStore = new SidebarOrderStore(), deliveryStore = new DeliveryStore({ path: null }), creationStore = new CreationStore({ path: null }), uploadStore = new UploadStore({ path: null }), control = null, recovery = null, remoteAccess = null } = {}) {
  const session = randomBytes(32).toString('hex');
  const uploads = new UploadManager(uploadStore);
  const sending = new Set();
  const requestInFlight = new Set();
  const unsupported = new Set();
  const creating = new Set();
  const creationReadFailures = new Map();
  // Share only work that is currently in flight. Never retain a snapshot for a
  // later poll or reuse this read path for a mutation's fresh preflight.
  const supplementalReads = new Map(), supplementalSnapshots = new Map();
  const sharedRead = (map, key, operation) => {
    if (!map.has(key)) {
      const pending = Promise.resolve().then(operation).finally(() => { if (map.get(key) === pending) map.delete(key); });
      map.set(key, pending);
    }
    return map.get(key);
  };
  const readSupplement = id => sharedRead(supplementalReads, id, () => bridge.read(id, undefined, { turnLimit: 1 }));
  const readSnapshot = (id, thread, context = false) => {
    const method = context && thread.delegated ? 'context' : 'snapshot';
    return sharedRead(supplementalSnapshots, `${method}:${id}`, () => {
      // Context-only adapters remain supported; ordinary native snapshots
      // already carry the context and can serve both GETs safely.
      const read = method === 'snapshot' && typeof control?.snapshot !== 'function' && context ? control?.context : control?.[method];
      if (typeof read !== 'function') throw new BridgeError('信息读取未连接', 'CONTROL_UNAVAILABLE', 503);
      return read.call(control, id);
    });
  };
  const creationEnabled = names => enableSend && sendScope === 'all-local' && typeof bridge.create === 'function' && typeof bridge.projects === 'function' && ['create_thread', 'list_projects'].every(n => names.includes(n));
  const activeStatuses = ['active', 'running', 'in_progress', 'inprogress'];
  const inScope = id => enableSend && (sendScope === 'all-local' || id === allowedSendThreadId);
  const handleArchives = createArchiveHandler({ bridge, inScope });
  const controlAccess = thread => inScope(thread.id) && thread.kind === 'codex' && (!thread.hostId || thread.hostId === 'local') && !thread.archived && !thread.delegated && !unsupported.has(thread.id);
  const managementAccess = thread => {
    const status = String(thread.status ?? '').toLowerCase();
    const canManage = inScope(thread.id) && thread.kind === 'codex' && (!thread.hostId || thread.hostId === 'local') &&
      !thread.archived && !thread.delegated && !unsupported.has(thread.id) && ['idle', 'notloaded', ...activeStatuses].includes(status);
    return { canManage, canArchive: canManage && !activeStatuses.includes(status) && thread.id !== bridge.callerThreadId };
  };
  const sendAccess = (thread) => {
    const status = String(thread.status ?? '').toLowerCase();
    let reason = null;
    if (!enableSend) reason = '本机服务未开启发送';
    else if (sendScope !== 'all-local' && thread.id !== allowedSendThreadId) reason = '此会话不在当前发送范围内';
    else if (thread.kind !== 'codex' || (thread.hostId && thread.hostId !== 'local') || thread.archived) reason = '仅支持本机未归档的 Codex 会话';
    else if (thread.delegated || unsupported.has(thread.id)) reason = '桌面不支持向此子任务直接发送消息';
    else if (!['idle', 'notloaded', ...activeStatuses].includes(status)) reason = '会话状态暂不可发送，请稍后刷新';
    return { canSend: !reason, sendDisabledReason: reason, sendMode: activeStatuses.includes(status) ? 'follow-up' : 'message' };
  };
  const json = (res, status, data) => {
    const body = JSON.stringify(data);
    const req = res.req;
    if (status === 200 && req.method === 'GET' && /^\/api\/(?:status|threads(?:\/[0-9a-f-]+(?:\/control)?)?)(?:\?|$)/i.test(req.url)) {
      const etag = `"${createHash('sha256').update(session).update(req.url).update(body).digest('hex')}"`;
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === etag)) { res.writeHead(304); res.end(); return; }
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(body);
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', appCsp);
    try {
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host)) throw new BridgeError('只允许本机访问', 'FORBIDDEN', 403);
      const origin = `http://${req.headers.host}`;
      if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) throw new BridgeError('拒绝跨站请求', 'FORBIDDEN', 403);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && publicAssets.has(url.pathname)) {
        if (url.pathname === '/') res.setHeader('Set-Cookie', `bridge_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const content = await readFile(new URL(file, publicRoot));
        if (url.pathname !== '/') {
          const etag = `"${createHash('sha256').update(content).digest('hex')}"`;
          res.setHeader('Cache-Control', 'private, no-cache'); res.setHeader('ETag', etag);
          if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
        }
        res.setHeader('Content-Type', assetContentType(file));
        res.end(content); return;
      }
      if (!url.pathname.startsWith('/api/')) { json(res, 404, { error: '页面不存在' }); return; }
      const cookie = (req.headers.cookie ?? '').split(';').map(c => c.trim()).find(c => c.startsWith('bridge_session='));
      if (cookie !== `bridge_session=${session}` || req.headers['x-bridge-client'] !== 'mobile-v1') throw new BridgeError('请重新打开本机页面', 'UNAUTHORIZED', 401);
      if (req.method === 'GET' && url.pathname === '/api/access') {
        json(res, 200, { mode: 'local', authenticated: true }); return;
      }
      if (url.pathname === '/api/remote-access') {
        if (!['GET', 'POST'].includes(req.method)) throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
        if (req.method === 'GET') {
          json(res, 200, remoteAccess ? await remoteAccess.status() : { supported: false, installed: false, state: 'stopped', url: null, lastError: null });
        } else {
          if (!remoteAccess) throw new BridgeError('当前服务未开放手机访问设置', 'REMOTE_UNAVAILABLE', 503);
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BridgeError('需要 JSON 请求', 'INVALID_REQUEST', 400);
          const body = await readJson(req);
          if (Object.keys(body).length !== 1 || !['start', 'stop'].includes(body.action)) throw new BridgeError('手机访问设置参数无效', 'INVALID_REQUEST', 400);
          json(res, 200, await remoteAccess[body.action]());
        }
        return;
      }
      if (url.pathname === '/api/recovery') {
        if (!['GET', 'PUT'].includes(req.method)) throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
        if (req.method === 'GET') {
          json(res, 200, recovery ? await recovery.status() : { supported: false, autoStart: false, autoRestart: false, supervisorRunning: false, state: 'unmanaged', restartCount: 0, lastRestartAt: null, lastError: null });
        } else {
          if (!recovery) throw new BridgeError('当前服务未开放运行设置', 'RECOVERY_UNAVAILABLE', 503);
          if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BridgeError('需要 JSON 请求', 'INVALID_REQUEST', 400);
          const body = await readJson(req);
          if (!Object.keys(body).length || Object.keys(body).some(key => !['autoStart', 'autoRestart'].includes(key) || typeof body[key] !== 'boolean')) throw new BridgeError('运行设置参数无效', 'INVALID_REQUEST', 400);
          json(res, 200, await recovery.configure(body));
        }
        return;
      }
      if (await handleArchives(req, res, url)) return;
      const uploadMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/uploads\/([^/]+)$/);
      if (uploadMatch) {
        if (!UUID.test(uploadMatch[1]) || !UUID.test(uploadMatch[2])) throw new BridgeError('无效的上传地址', 'INVALID_REQUEST', 400);
        if (!['GET', 'POST'].includes(req.method)) throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
        if (!inScope(uploadMatch[1])) throw new BridgeError('此会话未开放附件上传', 'UPLOAD_DISABLED', 403);
        const { thread } = await bridge.read(uploadMatch[1], undefined, { turnLimit: 1 });
        if (thread?.id !== uploadMatch[1] || !sendAccess(thread).canSend) throw new BridgeError('此会话未开放附件上传', 'UPLOAD_DISABLED', 403);
        if (req.method === 'GET') json(res, 200, await uploads.lookup(thread, uploadMatch[2]));
        else {
          if (req.headers['content-type'] !== 'application/octet-stream') throw new BridgeError('需要原始附件字节', 'INVALID_UPLOAD', 400);
          const meta = uploadMetadata(url.searchParams);
          if (req.headers['content-length'] && Number(req.headers['content-length']) !== meta.size) throw new BridgeError('上传大小与声明不符', 'UPLOAD_INTEGRITY', 400);
          json(res, 200, await uploads.upload(thread, uploadMatch[2], meta, req));
        }
        return;
      }
      const fileMatch = url.pathname.match(/^\/api\/threads\/([^/]+)\/(files|file)$/);
      if (fileMatch) {
        if (!UUID.test(fileMatch[1])) throw new BridgeError('无效的任务地址', 'INVALID_REQUEST', 400);
        if (req.method !== 'GET') throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
        const input = url.searchParams.get('path') ?? '';
        if (fileMatch[2] === 'files') json(res, 200, await listThreadFiles(bridge, fileMatch[1], input));
        else {
          const info = await serveThreadFile(bridge, fileMatch[1], input, url.searchParams.get('mode') ?? 'info', req, res);
          if (info) json(res, 200, info);
        }
        return;
      }
      if (url.pathname === '/api/sidebar-order') {
        if (req.method === 'GET') { json(res, 200, await orderStore.read()); return; }
        if (req.method !== 'PUT') throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BridgeError('需要 JSON 请求', 'INVALID_REQUEST', 400);
        json(res, 200, await orderStore.save(await readJson(req))); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let connected = false, sendAvailable = false, canCreate = false, error = null;
        const threadManagement = { rename: false, pin: false, archive: false };
        try {
          const names = await bridge.capabilities();
          if (!['list_threads', 'read_thread'].every(n => names.includes(n))) throw new BridgeError('Codex 桌面未提供所需的读取接口。', 'PROTOCOL_ERROR', 502);
          await bridge.read(bridge.callerThreadId, undefined, { turnLimit: 1 });
          connected = true; sendAvailable = names.includes('send_message_to_thread');
          canCreate = creationEnabled(names);
          for (const [action, tool] of Object.entries(THREAD_MANAGEMENT_TOOLS)) {
            threadManagement[action] = enableSend && names.includes(tool) &&
              (action !== 'archive' || sendScope === 'all-local' || allowedSendThreadId !== bridge.callerThreadId);
          }
        } catch (cause) {
          error = cause instanceof BridgeError ? { code: cause.code, message: cause.message } : { code: 'DESKTOP_UNAVAILABLE', message: '暂时无法连接 Codex 桌面。' };
        }
        const modelOptions = Object.fromEntries(['send_message_to_thread', 'create_thread'].map(name => [name === 'create_thread' ? 'create' : 'send', advertisedModels(bridge.toolCatalog?.find(tool => tool.name === name))]));
        json(res, 200, { connected, error, canCreate, modelOptions, permissionOptions: { send: connected && enableSend && typeof control?.send === 'function' ? permissionOptions : [], create: [] }, threadContext: typeof control?.context === 'function', threadManagement, executionControl: !!control && enableSend, mode: 'desktop-pipe', callerThreadId: bridge.callerThreadId, defaultThreadId: enableSend && sendScope === 'single' ? allowedSendThreadId : bridge.callerThreadId, allowedSendThreadId: enableSend && sendScope === 'single' ? allowedSendThreadId : null, sendScope: enableSend ? sendScope : 'disabled', canSend: enableSend && connected && sendAvailable, limitations: ['实验性桌面内部接口，升级后可能失效', '每 3 秒同步，不是逐字实时流', '未识别的审批或问题不能从网页处理', !enableSend ? '发送未开启' : sendScope === 'all-local' ? '可向本机普通会话发送和追加消息' : '仅向指定会话开放发送', '手机入口需单独开启并登录'] }); return;
      }
      const creationLookup = url.pathname.match(/^\/api\/thread-creations\/([^/]+)$/);
      if (creationLookup && req.method === 'GET') {
        if (!UUID.test(creationLookup[1])) throw new BridgeError('无效的新建请求 ID', 'INVALID_REQUEST', 400);
        const entry = await creationStore.get(creationLookup[1]);
        json(res, 200, { state: !entry ? 'not_found' : entry.state === 'created' ? 'created' : 'unknown', ...(entry?.state === 'created' ? { receipt: entry.receipt } : {}) }); return;
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const canCreate = creationEnabled(await bridge.capabilities());
        json(res, 200, { canCreate, projects: canCreate ? await bridge.projects() : [] }); return;
      }
      if (url.pathname === '/api/threads' && req.method === 'POST') {
        if (!enableSend || sendScope !== 'all-local') throw new BridgeError('当前范围未开放新建会话', 'CREATE_DISABLED', 403);
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BridgeError('需要 JSON 请求', 'INVALID_REQUEST', 400);
        const body = await readJson(req);
        if (Object.keys(body).some(k => !['requestId', 'prompt', 'projectId', 'title', 'model', 'thinking'].includes(k)) || !UUID.test(body.requestId ?? '') ||
          typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000 ||
          (body.projectId != null && (typeof body.projectId !== 'string' || !body.projectId || body.projectId.length > 256)) ||
          (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200))) throw new BridgeError('新建会话参数无效', 'INVALID_REQUEST', 400);
        const selection = modelSelection(body);
        const args = { prompt: body.prompt, projectId: body.projectId ?? null, ...(body.title === undefined ? {} : { title: body.title.trim() }), ...selection };
        const hash = promptHash(JSON.stringify(args)), key = body.requestId;
        const previous = await creationStore.get(key);
        if (previous) {
          if (previous.payloadHash !== hash) throw new BridgeError('请求 ID 已用于其他新建内容', 'CONFLICT', 409);
          if (previous.state === 'created') { json(res, 200, previous.receipt); return; }
          throw new BridgeError('新建结果未知，请刷新会话列表核对，勿重复创建', 'DELIVERY_UNKNOWN', 409);
        }
        if (creating.has(key)) throw new BridgeError('新建请求正在检查，请勿重复提交', 'CREATE_BUSY', 409);
        creating.add(key);
        let reserved = false;
        try {
          if (!creationEnabled(await bridge.capabilities())) throw new BridgeError('当前桌面未开放新建会话', 'CREATE_DISABLED', 403);
          validateModelSelection(selection, advertisedModels(bridge.toolCatalog?.find(tool => tool.name === 'create_thread')));
          const result = await bridge.create(args, { beforeDispatch: async () => {
            await creationStore.reserve({ requestId: key, payloadHash: hash }); reserved = true;
          } });
          if (!reserved || !UUID.test(result?.threadId ?? '') || result.hostId !== 'local' || result.clientThreadId != null) throw new BridgeError('新建结果未知', 'DELIVERY_UNKNOWN', 409);
          const receipt = { created: true, requestId: key, threadId: result.threadId, hostId: 'local', projectId: args.projectId, createdAt: new Date().toISOString() };
          try { await creationStore.accept(key, receipt); }
          catch { throw new BridgeError('会话已创建但回执未保存，请刷新会话列表核对，勿重复创建', 'DELIVERY_UNKNOWN', 409); }
          json(res, 200, receipt); return;
        } catch (error) {
          if (reserved) throw new BridgeError('新建结果未知，请刷新会话列表核对，勿重复创建', 'DELIVERY_UNKNOWN', 409);
          throw error;
        } finally { creating.delete(key); }
      }
      if (req.method === 'GET' && url.pathname === '/api/threads') {
        const data = await bridge.list();
        let recentCreations = [];
        try {
          recentCreations = (await creationSupplementRead(() => creationStore.recent())).filter(r => Date.now() - Date.parse(r.createdAt) < 300000 && !data.threads.some(t => t.id === r.threadId)).slice(0, 5);
        } catch (error) {
          data.creationSupplement = { available: false, code: error.code === 'CREATION_STORE_UNAVAILABLE' ? error.code : 'CREATION_SUPPLEMENT_UNAVAILABLE' };
        }
        const candidates = recentCreations.filter(r => Date.now() - (creationReadFailures.get(r.threadId) ?? 0) >= 15000);
        const reads = await Promise.allSettled(candidates.map(r => creationSupplementRead(() => bridge.read(r.threadId, undefined, { turnLimit: 1 }))));
        for (let i = 0; i < reads.length; i++) {
          const result = reads[i];
          if (result.status === 'rejected') {
            creationReadFailures.set(candidates[i].threadId, Date.now());
            data.creationSupplement = { available: false, code: 'CREATION_SUPPLEMENT_UNAVAILABLE' }; continue;
          }
          const thread = result.value.thread;
          if (thread?.id === candidates[i].threadId && thread.kind === 'codex' && (!thread.hostId || thread.hostId === 'local') && !thread.archived) data.threads.push(thread);
        }
        for (const [id, at] of creationReadFailures) if (Date.now() - at > 300000) creationReadFailures.delete(id);
        // A newly created task may not appear in the desktop's cached/recent sidebar list yet.
        // Keep the configured test target reachable from search and task switching.
        if (enableSend && sendScope === 'single' && !data.threads.some(t => t.id === allowedSendThreadId)) {
          try {
            const { thread } = await bridge.read(allowedSendThreadId);
            data.threads.unshift({ ...thread, kind: 'codex', hostId: 'local' });
          } catch { /* Keep the other readable tasks available. */ }
        }
        json(res, 200, data); return;
      }
      const match = url.pathname.match(/^\/api\/threads\/([^/]+)(\/messages(?:\/([^/]+))?|\/settings|\/context|\/control|\/stop|\/respond)?$/);
      if (!match || !UUID.test(match[1]) || (match[3] && !UUID.test(match[3]))) throw new BridgeError('无效的任务地址', 'INVALID_REQUEST', 400);
      const id = match[1];
      if (req.method === 'GET' && match[2] === '/context') {
        const { thread } = await readSupplement(id);
        const unavailable = reason => ({ available: false, items: [], reason });
        if (thread.kind !== 'codex' || thread.hostId && thread.hostId !== 'local') {
          json(res, 200, { threadId: id, available: false, reason: '仅支持本机 Codex 会话', permissions: { supported: false, current: 'unknown', canOverride: false, options: [] }, git: unavailable('当前会话不是本机会话'), agents: unavailable('当前会话不是本机会话'), sources: unavailable('当前会话不是本机会话') }); return;
        }
        try {
          if (typeof control?.context !== 'function') throw new BridgeError('信息读取未连接', 'CONTROL_UNAVAILABLE', 503);
          const snapshot = await readSnapshot(id, thread, true);
          if (snapshot.threadId !== id || !snapshot.threadContext) throw new BridgeError('会话信息不匹配', 'PROTOCOL_ERROR', 502);
          const context = snapshot.threadContext;
          const canOverride = context.permissions.supported && typeof control.send === 'function' && sendAccess(thread).canSend && !snapshot.permissionActive;
          const [git, agents] = await Promise.all([readGitContext(snapshot.cwd), hydrateAgentContext(context.agents, bridge)]);
          json(res, 200, { threadId: id, available: true, permissions: { supported: context.permissions.supported && typeof control.send === 'function', current: context.permissions.current, canOverride, options: context.permissions.options,
            ...(!canOverride ? { reason: snapshot.permissionActive ? '正在运行，权限选择将在下一轮发送时生效' : '此会话当前不能覆盖权限' } : {}) }, git, agents, sources: context.sources });
        } catch (error) {
          const code = ['PROTOCOL_ERROR', 'PROTOCOL_INCOMPATIBLE', 'OWNER_UNAVAILABLE', 'UNSUPPORTED_THREAD'].includes(error.code) ? error.code : 'CONTROL_UNAVAILABLE';
          const reason = code === 'OWNER_UNAVAILABLE' ? ownerReadReason(error, '会话权限与运行状态', sendAccess(thread).canSend, thread) : '暂时无法读取会话信息，可刷新重试';
          json(res, 200, { threadId: id, available: false, code, reason, ...(ownerStandby(error, thread) ? { standby: true } : {}), permissions: { supported: false, current: 'unknown', canOverride: false, options: [] }, git: await readGitContext(thread.cwd), agents: unavailable(reason), sources: unavailable(reason) });
        }
        return;
      }
      if (req.method === 'GET' && match[2] === '/control') {
        const { thread } = await readSupplement(id);
        if (!control || !controlAccess(thread)) {
          json(res, 200, { available: false, canStop: false, threadId: id, reason: '此会话未开放运行控制' }); return;
        }
        try {
          const snapshot = await readSnapshot(id, thread);
          if (snapshot.threadId !== id) throw new BridgeError('运行状态不匹配', 'PROTOCOL_ERROR', 502);
          const pendingRequests = await Promise.all((snapshot.pendingRequests ?? []).map(async pending => {
            const visible = publicPendingRequest(pending), previous = pending.attemptId ? await deliveryStore.get(pending.attemptId) : null;
            if (previous) Object.assign(visible, { actionable: false, responseState: previous.state === 'accepted' ? 'delivered' : 'unknown', disabledReason: previous.state === 'accepted' ? '回复已投递，等待桌面处理' : '回复投递结果未知，请勿重复提交' });
            return visible;
          }));
          json(res, 200, { available: true, threadId: id, canStop: !!snapshot.currentTurnId, turnId: snapshot.currentTurnId,
            pendingRequestCount: pendingRequests.length, pendingRequests,
            ...(snapshot.historicalQuestions?.length ? { historicalQuestions: snapshot.historicalQuestions.map(publicPendingRequest) } : {}) });
        } catch (error) {
          const code = ['PROTOCOL_ERROR', 'PROTOCOL_INCOMPATIBLE', 'OWNER_UNAVAILABLE', 'UNSUPPORTED_THREAD'].includes(error.code) ? error.code : 'CONTROL_UNAVAILABLE';
          const reason = ['PROTOCOL_ERROR', 'PROTOCOL_INCOMPATIBLE'].includes(code) ? '当前桌面版本的运行控制不兼容，会话读写仍可使用'
            : code === 'OWNER_UNAVAILABLE' ? ownerReadReason(error, '运行状态', sendAccess(thread).canSend, thread)
              : code === 'UNSUPPORTED_THREAD' ? '此类会话暂不支持网页运行控制'
                : '暂时无法读取运行状态，可刷新重试';
          json(res, 200, { available: false, canStop: false, threadId: id, code, reason, ...(ownerStandby(error, thread) ? { standby: true } : {}) });
        }
        return;
      }
      if (req.method === 'GET' && match[3]) {
        const delivery = await deliveryStore.get(match[3]);
        const state = !delivery || delivery.threadId !== id ? 'not_found' : delivery.state === 'accepted' ? 'accepted' : 'unknown';
        json(res, 200, { state, ...(state === 'accepted' ? { receipt: delivery.receipt } : {}) }); return;
      }
      if (req.method === 'GET' && !match[2]) {
        const cursor = url.searchParams.get('cursor');
        if (cursor?.length > 4096) throw new BridgeError('分页参数过长', 'INVALID_REQUEST', 400);
        const data = await bridge.read(id, cursor);
        json(res, 200, { ...data, ...sendAccess(data.thread), ...managementAccess(data.thread) }); return;
      }
      if (req.method !== 'POST' || !match[2] || match[3]) throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
      if (!enableSend || (sendScope !== 'all-local' && id !== allowedSendThreadId)) throw new BridgeError('此会话未开放发送。', 'SEND_DISABLED', 403);
      if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new BridgeError('需要 JSON 请求', 'INVALID_REQUEST', 400);
      const body = await readJson(req);
      if (match[2] === '/respond') {
        if (!control?.respond) throw new BridgeError('请求回复未连接', 'CONTROL_UNAVAILABLE', 503);
        if (sending.has(id)) throw new BridgeError('会话仍有操作进行中，请稍后再试', 'SEND_BUSY', 409);
        sending.add(id);
        let attemptId;
        try {
          const { thread } = await bridge.read(id, undefined, { turnLimit: 1 });
          if (!controlAccess(thread)) throw new BridgeError('此会话未开放请求回复', 'CONTROL_DISABLED', 403);
          const result = await control.respond(id, body, { beforeDispatch: async pending => {
            if (!UUID.test(pending.attemptId ?? '') || !/^[a-f0-9]{64}$/.test(pending.fingerprint ?? '')) throw new BridgeError('回复记录无法确认', 'PROTOCOL_ERROR', 502);
            if (await deliveryStore.get(pending.attemptId)) throw new BridgeError('此请求已尝试回复，请刷新查看处理结果', 'RESPONSE_ALREADY_ATTEMPTED', 409);
            await deliveryStore.reserve({ requestId: pending.attemptId, threadId: id, promptHash: pending.fingerprint });
            attemptId = pending.attemptId;
          } });
          if (result.threadId !== id || result.delivered !== true || !attemptId) throw new BridgeError('回复结果未知，请勿重发', 'DELIVERY_UNKNOWN', 409);
          try { await deliveryStore.accept(attemptId, { accepted: true, threadId: id, requestId: attemptId, acceptedAt: new Date().toISOString() }); }
          catch { throw new BridgeError('回复已投递但回执无法保存，请勿重发', 'DELIVERY_UNKNOWN', 409); }
          json(res, 200, { threadId: id, requestId: result.requestId, delivered: true }); return;
        } finally { sending.delete(id); }
      }
      if (match[2] === '/stop') {
        if (!control) throw new BridgeError('运行控制未连接', 'CONTROL_UNAVAILABLE', 503);
        if (typeof body.turnId !== 'string' || !body.turnId || body.turnId.length > 256) throw new BridgeError('缺少当前运行轮次，请刷新', 'INVALID_REQUEST', 400);
        if (sending.has(id)) throw new BridgeError('会话仍有操作进行中，请稍后再试', 'SEND_BUSY', 409);
        sending.add(id);
        try {
          const { thread } = await bridge.read(id, undefined, { turnLimit: 1 });
          if (!controlAccess(thread)) throw new BridgeError('此会话不允许停止操作', 'CONTROL_DISABLED', 403);
          const result = await control.stop(id, body.turnId);
          json(res, 200, { threadId: id, turnId: body.turnId, stopped: result.stopped === true, goalPauseError: result.goalPauseError === true }); return;
        } finally { sending.delete(id); }
      }
      if (match[2] === '/control') throw new BridgeError('不支持的操作', 'METHOD_NOT_ALLOWED', 405);
      if (match[2] === '/settings') {
        const { action } = body;
        let { value } = body;
        if (!Object.hasOwn(THREAD_MANAGEMENT_TOOLS, action ?? '') ||
            (action === 'rename' && (typeof value !== 'string' || !value.trim() || value.trim().length > 200)) ||
            (action === 'pin' && typeof value !== 'boolean') || (action === 'archive' && value !== true)) {
          throw new BridgeError('会话设置无效', 'INVALID_REQUEST', 400);
        }
        if (action === 'rename') value = value.trim();
        if (sending.has(id)) throw new BridgeError('此会话仍有操作进行中，请稍后刷新', 'SEND_BUSY', 409);
        sending.add(id);
        try {
          const { thread } = await bridge.read(id);
          const access = managementAccess(thread);
          if (!access.canManage || (action === 'archive' && !access.canArchive)) throw new BridgeError('当前会话不允许此操作', 'MANAGEMENT_DISABLED', 403);
          const names = await bridge.capabilities();
          if (!names.includes(THREAD_MANAGEMENT_TOOLS[action])) throw new BridgeError('桌面未提供此会话管理接口', 'MANAGEMENT_UNAVAILABLE', 503);
          await bridge.manage(id, action, value);
          json(res, 200, { threadId: id, action, value, accepted: true }); return;
        } finally { sending.delete(id); }
      }
      if (Object.keys(body).some(k => !['requestId', 'prompt', 'model', 'thinking', 'permissionMode'].includes(k)) || !UUID.test(body.requestId ?? '') || typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 12000) throw new BridgeError('消息或请求 ID 无效', 'INVALID_REQUEST', 400);
      const key = body.requestId;
      const selection = { ...modelSelection(body), ...permissionSelection(body) };
      const hash = promptHash(Object.keys(selection).length ? JSON.stringify({ prompt: body.prompt, ...selection }) : body.prompt);
      const previous = await deliveryStore.get(key);
      if (previous) {
        if (previous.threadId !== id || previous.promptHash !== hash) throw new BridgeError('请求 ID 已用于其他消息', 'CONFLICT', 409);
        if (previous.state === 'accepted') { json(res, 200, previous.receipt); return; }
        throw new BridgeError('此消息已尝试发送，请先查看桌面，勿直接重发。', 'DELIVERY_UNKNOWN', 409);
      }
      if (requestInFlight.has(key)) throw new BridgeError('此请求仍在检查，请勿重复提交。', 'SEND_BUSY', 409);
      if (sending.has(id)) throw new BridgeError('此会话的上一条消息仍在发送', 'SEND_BUSY', 409);
      sending.add(id);
      requestInFlight.add(key);
      try {
        const data = await bridge.read(id);
        const access = sendAccess(data.thread);
        if (!access.canSend) throw new BridgeError(access.sendDisabledReason, 'SEND_DISABLED', 403);
        if (selection.permissionMode) {
          if (access.sendMode === 'follow-up') throw new BridgeError('正在运行的回合不能切换权限，请等待完成后再发送', 'PERMISSION_CHANGE_ACTIVE', 409);
          if (typeof control?.send !== 'function') throw new BridgeError('当前桌面连接不支持权限覆盖', 'PERMISSION_UNAVAILABLE', 503);
        }
        if (selection.model) {
          if (access.sendMode === 'follow-up') throw new BridgeError('正在运行的回合不能切换模型或推理强度。请等待完成，或选择沿用桌面设置后追加消息', 'MODEL_CHANGE_ACTIVE', 409);
          await bridge.capabilities();
          validateModelSelection(selection, advertisedModels(bridge.toolCatalog?.find(tool => tool.name === 'send_message_to_thread')));
        }
        let reserved = false;
        const reserve = async () => { await deliveryStore.reserve({ requestId: key, threadId: id, promptHash: hash }); reserved = true; };
        try {
          if (selection.permissionMode) {
            const native = await control.send(id, body.prompt, selection, { beforeDispatch: reserve });
            if (native.threadId !== id || native.delivered !== true) throw new BridgeError('权限消息投递结果未知，请核对桌面', 'DELIVERY_UNKNOWN', 409);
          } else { await reserve(); await bridge.send(id, body.prompt, selection); }
        }
        catch (error) {
          if (error.code === 'UNSUPPORTED_THREAD') unsupported.add(id);
          if (reserved && (error.controlNotDispatched === true || ['UNSUPPORTED_THREAD', 'DESKTOP_REJECTED', 'DESKTOP_UNAVAILABLE'].includes(error.code))) await deliveryStore.remove(key);
          throw error;
        }
        const result = { accepted: true, threadId: id, requestId: key, acceptedAt: new Date().toISOString(), ...(selection.permissionMode ? { permissionMode: selection.permissionMode } : {}) };
        try { await deliveryStore.accept(key, result); }
        catch { throw new BridgeError('桌面已接收但发送回执未能保存，请核对桌面记录。', 'DELIVERY_UNKNOWN', 409); }
        json(res, 200, result);
      } finally { sending.delete(id); requestInFlight.delete(key); }
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof BridgeError ? error.status : 500, { error: error instanceof BridgeError ? error.message : '读取失败，请稍后刷新。', code: error.code ?? 'INTERNAL_ERROR' });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  return server;
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new BridgeError('请求过大', 'INVALID_REQUEST', 413);
    chunks.push(chunk);
  }
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error(); return parsed; } catch { throw new BridgeError('JSON 格式无效', 'INVALID_REQUEST', 400); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { callerThreadId, port, enableSend, allowedSendThreadId, sendScope } = await loadRuntimeConfig();
    const bridge = new DesktopBridge({ callerThreadId, request: createDesktopRequest({ preferredPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH }) });
    const server = createBridgeServer({ bridge, enableSend, allowedSendThreadId, sendScope, deliveryStore: new DeliveryStore(), creationStore: new CreationStore(), uploadStore: new UploadStore(), control: new DesktopControl(), recovery: createRecoveryManager(), remoteAccess: createRemoteAccessManager() });
    server.on('error', error => { console.error(`启动失败：${error.code}`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => console.log(`Codex mobile prototype: http://127.0.0.1:${port} (local only; send ${enableSend ? 'experimental' : 'disabled'})`));
    process.on('SIGINT', () => server.close());
    process.on('SIGTERM', () => server.close());
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
