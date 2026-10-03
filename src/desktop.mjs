import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSidebarMetadata, projectForThread, applySidebarOrder, visibleUserText } from './presentation.mjs';

export const MAX_FRAME = 8 * 1024 * 1024;
export const THREAD_MANAGEMENT_TOOLS = Object.freeze({ rename: 'set_thread_title', pin: 'set_thread_pinned', archive: 'set_thread_archived' });
export class BridgeError extends Error {
  constructor(message, code = 'DESKTOP_UNAVAILABLE', status = 503, cause) {
    super(message, cause === undefined ? undefined : { cause }); this.code = code; this.status = status;
  }
}
export function encodeFrame(message) {
  const data = Buffer.from(JSON.stringify(message));
  if (data.length > MAX_FRAME) throw new BridgeError('请求过大', 'INVALID_REQUEST', 400);
  const header = Buffer.alloc(4); header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
}

// This is the desktop's bundled app-tools protocol, NOT a second Codex engine.
// One socket per call isolates timeouts and stale responses. Mutations are never retried.
export function pipeRequest(pipePath, method, params, { timeoutMs = 12000, mutation = false } = {}) {
  if (!pipePath) return Promise.reject(new BridgeError('请从 Codex 桌面任务环境启动，未发现桌面连接。'));
  const frame = encodeFrame({ jsonrpc: '2.0', id: 1, method, params });
  return new Promise((resolve, reject) => {
    let socket, sent = false, settled = false, buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket?.destroy();
      error ? reject(error) : resolve(value);
    };
    const disconnected = () => finish(new BridgeError(
      mutation && sent ? '发送结果未知，请先查看桌面记录，切勿直接重发。' : '桌面连接已断开，请确认 Codex 正在运行。',
      mutation && sent ? 'DELIVERY_UNKNOWN' : 'DESKTOP_UNAVAILABLE', mutation && sent ? 409 : 503));
    const timer = setTimeout(disconnected, timeoutMs);
    try { socket = net.createConnection(pipePath); }
    catch { disconnected(); return; }
    socket.once('connect', () => { sent = true; socket.write(frame); });
    socket.on('error', disconnected);
    socket.on('close', disconnected);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const size = buffer.readUInt32LE(0);
      if (size > MAX_FRAME || size === 0 || buffer.length > MAX_FRAME + 4) {
        if (mutation && sent) return disconnected();
        return finish(new BridgeError('桌面返回的数据超出限制', 'PROTOCOL_ERROR', 502));
      }
      if (buffer.length < size + 4) return;
      try {
        const response = JSON.parse(buffer.subarray(4, size + 4).toString('utf8'));
        if (response.jsonrpc !== '2.0' || response.id !== 1 || (!('result' in response) && !response.error)) throw new Error();
        if (response.error) {
          if ([-32601, -32602].includes(response.error.code)) return finish(new BridgeError('Codex 桌面接口已变化，需要更新桥接适配。', 'PROTOCOL_ERROR', 502, response.error));
          return finish(new BridgeError('桌面拒绝了请求，请在桌面确认当前状态。', 'DESKTOP_REJECTED', 502, response.error));
        }
        finish(null, response.result);
      } catch {
        if (mutation && sent) return disconnected();
        finish(new BridgeError('桌面接口格式不兼容', 'PROTOCOL_ERROR', 502));
      }
    });
  });
}

export class DesktopBridge {
  constructor({ pipePath, callerThreadId, request = pipeRequest, sidebarPath = join(process.env.CODEX_HOME || homedir() + '/.codex', '.codex-global-state.json'), metadataReader = readSidebarMetadata }) {
    this.pipePath = pipePath; this.callerThreadId = callerThreadId; this.request = request;
    this.sidebarPath = sidebarPath; this.metadataReader = metadataReader; this.metadata = null; this.metadataAt = 0;
  }
  async sidebarMetadata({ fresh = false } = {}) {
    if (fresh || !this.metadata || Date.now() - this.metadataAt > 3000) {
      if (!this.metadataRead) this.metadataRead = Promise.resolve().then(() => this.metadataReader(this.sidebarPath))
        .then(metadata => { this.metadata = metadata; this.metadataAt = Date.now(); return metadata; })
        .finally(() => { this.metadataRead = null; });
      return this.metadataRead;
    }
    return this.metadata;
  }
  async capabilities() {
    const catalog = await this.request(this.pipePath, 'tools/list', { threadStartKind: 'all' });
    if (!Array.isArray(catalog?.tools)) throw new BridgeError('桌面工具目录格式不兼容', 'PROTOCOL_ERROR', 502);
    this.toolCatalog = catalog.tools.filter(t => t.namespace === 'codex_app');
    return this.toolCatalog.map(t => t.name);
  }
  async call(tool, args, mutation = false) {
    if (!['list_threads', 'list_archived_threads', 'read_thread', 'send_message_to_thread', 'list_projects', 'create_thread', ...Object.values(THREAD_MANAGEMENT_TOOLS)].includes(tool)) throw new BridgeError('不支持的操作', 'FORBIDDEN', 403);
    if (!this.callerThreadId) throw new BridgeError('未提供启动任务 ID，请从 Codex 桌面环境运行。');
    const result = await this.request(this.pipePath, 'tools/call', {
      namespace: 'codex_app', tool, arguments: args, callerSource: 'codex', threadId: this.callerThreadId,
      turnId: `mobile-${randomUUID()}`, callId: `mobile-${randomUUID()}`,
    }, { mutation, timeoutMs: mutation ? 20000 : 12000 });
    // Preserve a diagnostic cause in-process, but never forward raw host output to HTTP clients.
    if (!result?.success) {
      if (JSON.stringify(result).includes('direct app-server input is not allowed for multi-agent v2 sub-agents')) {
        throw new BridgeError('子智能体任务不能直接接收消息，请选择普通桌面任务。', 'UNSUPPORTED_THREAD', 409, result);
      }
      throw new BridgeError('桌面未确认操作成功，请查看桌面。', mutation ? 'DELIVERY_UNKNOWN' : 'DESKTOP_REJECTED', mutation ? 409 : 502, result);
    }
    const blocks = result.contentItems?.filter(c => c.type === 'inputText').map(c => c.text) ?? [];
    for (const text of blocks) {
      try { return JSON.parse(text); } catch { /* a successful send may return plain text */ }
    }
    if (mutation) return { message: blocks.join('\n') };
    throw new BridgeError('桌面接口未返回可读取的数据', 'PROTOCOL_ERROR', 502);
  }
  async list() {
    const data = await this.call('list_threads', { limit: 50 });
    const metadata = await this.sidebarMetadata({ fresh: true });
    if (!Array.isArray(data.threads) || !Array.isArray(data.pinnedThreads)) throw new BridgeError('任务列表格式不兼容', 'PROTOCOL_ERROR', 502);
    const unique = new Map([...data.pinnedThreads, ...data.threads].filter(t => t.kind === 'codex' && (!t.hostId || t.hostId === 'local')).map(t => [t.id, {
      id: t.id, title: t.title || '未命名任务', kind: t.kind, status: statusOf(t.status), hostId: 'local', cwd: t.cwd,
      ...projectForThread(t, metadata),
      pinned: Number.isInteger(t.pinnedIndex), pinnedIndex: t.pinnedIndex ?? null, updatedAt: t.updatedAt,
      ...(isDelegatedThread(t) ? { delegated: true } : {}),
    }]));
    return { threads: applySidebarOrder([...unique.values()], metadata), unavailableHosts: data.unavailableHosts ?? [], unavailableSources: data.unavailableSources ?? [] };
  }
  async read(id, cursor, { turnLimit = 10 } = {}) {
    // Delegated user input is carried in a functionCallOutput envelope on this desktop version.
    // Read it here, but normalizeThread only forwards the recognized input, never arbitrary outputs.
    const args = { threadId: id, hostId: 'local', turnLimit, includeOutputs: true, maxOutputCharsPerItem: 20000 };
    if (cursor) args.cursor = cursor;
    let data, outputsAvailable = true;
    try { data = await this.call('read_thread', args); }
    catch (error) {
      // Some desktop histories fail only while hydrating raw tool outputs.
      // Retry this read once without outputs; never relax identity/shape checks,
      // retry protocol faults, or use this path for mutations.
      if (error.code !== 'DESKTOP_REJECTED') throw error;
      data = await this.call('read_thread', { ...args, includeOutputs: false });
      outputsAvailable = false;
    }
    if (data?.thread?.id !== id || !Array.isArray(data.turns)) throw new BridgeError('桌面返回了不匹配的任务', 'PROTOCOL_ERROR', 502);
    const normalized = normalizeThread(data);
    if (!outputsAvailable) normalized.outputsAvailable = false;
    const project = projectForThread(data.thread, await this.sidebarMetadata());
    // A singleton read cannot rank the complete sidebar. Keep the fresh list's
    // computed ranks when the frontend merges transcript metadata into it.
    delete project.projectThreadOrder; delete project.projectOrder;
    Object.assign(normalized.thread, project);
    return normalized;
  }
  async readMetadata(id) {
    // Eligibility and connection probes need fresh native thread metadata, not
    // transcript/tool output hydration. Preserve the same identity checks.
    const data = await this.call('read_thread', { threadId: id, hostId: 'local', turnLimit: 1, includeOutputs: false });
    if (data?.thread?.id !== id || !Array.isArray(data.turns)) throw new BridgeError('桌面返回了不匹配的任务', 'PROTOCOL_ERROR', 502);
    const normalized = normalizeThread({ thread: data.thread, turns: [] });
    const project = projectForThread(data.thread, await this.sidebarMetadata());
    delete project.projectThreadOrder; delete project.projectOrder;
    Object.assign(normalized.thread, project);
    return normalized;
  }
  async send(id, prompt, selection = {}) {
    return this.call('send_message_to_thread', { threadId: id, hostId: 'local', prompt, ...selection }, true);
  }
  async projects() {
    const data = await this.call('list_projects', {});
    if (data?.schemaVersion !== 2 || !Array.isArray(data.projects)) throw new BridgeError('项目目录格式不兼容', 'PROTOCOL_ERROR', 502);
    const projects = data.projects.filter(p => p.projectKind === 'local' && p.hostId === 'local');
    if (projects.some(p => typeof p.projectId !== 'string' || !p.projectId || p.projectId.length > 256 || typeof p.label !== 'string' ||
      typeof p.path !== 'string' || !p.path || typeof p.isGitRepository !== 'boolean') || new Set(projects.map(p => p.projectId)).size !== projects.length) {
      throw new BridgeError('本机项目目录格式不兼容', 'PROTOCOL_ERROR', 502);
    }
    return projects.map(p => ({ projectId: p.projectId, label: p.label, path: p.path, hostId: 'local', isGitRepository: p.isGitRepository }));
  }
  async create({ projectId = null, prompt, title, model, thinking }, { beforeDispatch = async () => {} } = {}) {
    const projects = await this.projects();
    if (projectId !== null && !projects.some(p => p.projectId === projectId)) throw new BridgeError('所选本机项目已不可用，请刷新项目列表', 'PROJECT_UNAVAILABLE', 409);
    const target = projectId === null ? { type: 'projectless' } : { type: 'project', projectId, environment: { type: 'local' } };
    await beforeDispatch();
    const result = await this.call('create_thread', { prompt, target, ...(title ? { title } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }, true);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(result?.threadId ?? '') || result.hostId !== 'local' || result.clientThreadId != null) {
      throw new BridgeError('新建结果未知，请刷新会话列表核对，勿重复创建', 'DELIVERY_UNKNOWN', 409);
    }
    return { threadId: result.threadId, hostId: 'local' };
  }
  async manage(id, action, value) {
    if (!Object.hasOwn(THREAD_MANAGEMENT_TOOLS, action)) throw new BridgeError('不支持的会话操作', 'INVALID_REQUEST', 400);
    const args = { threadId: id, source: 'codex' };
    if (action === 'rename') args.title = value;
    else if (action === 'pin') args.pinned = value;
    else { args.archived = value; args.hostId = 'local'; }
    return this.call(THREAD_MANAGEMENT_TOOLS[action], args, true);
  }
}
export function statusOf(status) { return typeof status === 'string' ? status : status?.type ?? 'unknown'; }
export function isDelegatedThread(state) {
  return Boolean(state.parentThreadId || state.agentNickname || state.source && typeof state.source === 'object' && ('subAgent' in state.source || 'subagent' in state.source));
}
export function normalizeThread(data) {
  const turns = data.page?.order === 'newest_first' ? [...data.turns].reverse() : [...data.turns];
  return {
    thread: { id: data.thread.id, kind: data.thread.kind, hostId: data.thread.hostId, archived: data.thread.archived === true, title: data.thread.title, status: statusOf(data.thread.status), cwd: data.thread.cwd, ...(isDelegatedThread(data.thread) ? { delegated: true } : {}) },
    page: { hasMore: Boolean(data.page?.hasMore), nextCursor: data.page?.nextCursor ?? null },
    turns: turns.map(t => ({ id: t.id, status: t.status, startedAt: t.startedAt, completedAt: t.completedAt, durationMs: t.durationMs, items: (t.items ?? []).flatMap(item => {
      if (item.type === 'functionCallOutput' && item.namespace === 'codex_app' && ['send_message_to_thread', 'create_thread'].includes(item.name)) {
        const input = item.output?.text?.match(/^<codex_delegation>\s*<source_thread_id>[^<]+<\/source_thread_id>\s*<input>([\s\S]*)<\/input>\s*<\/codex_delegation>$/);
        if (input && !item.output.truncated) return [{ type: 'userMessage', id: item.id, text: visibleUserText(input[1]), source: 'desktop-bridge' }];
      }
      if (item.type === 'userMessage') return [{ type: item.type, id: item.id, text: visibleUserText((item.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n')) }];
      if (item.type === 'agentMessage') return [{ type: item.type, id: item.id, text: item.text ?? '', phase: item.phase }];
      // Do not forward reasoning, credentials, tool arguments, or raw command output to the UI.
      const label = { commandExecution: '执行命令', fileChange: '更新文件', mcpToolCall: '调用工具', functionCall: '调用工具', functionCallOutput: '工具结果', subAgentActivity: '子任务', webSearch: '搜索资料' }[item.type];
      const name = item.name || item.tool;
      const status = { completed: '已完成', inProgress: '进行中', in_progress: '进行中', failed: '失败' }[item.status] || item.status;
      const paths = item.type === 'fileChange' ? (item.changes ?? []).map(c => c.path).filter(p => typeof p === 'string').join('\n') : '';
      return label ? [{ type: 'activity', id: item.id, text: `${label}${name ? ` · ${name}` : ''}${status ? ` · ${status}` : ''}`, detail: paths }] : [];
    }) })),
  };
}
