import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename } from 'node:path';
import { currentPermissionMode, permissionOptions, permissionRoots } from './permission-settings.mjs';
import { isDelegatedThread } from './desktop.mjs';
export { isDelegatedThread } from './desktop.mjs';

const run = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value, limit = 256) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f\x7f]/.test(value) ? value : null;
export function safeSourceUrl(value) {
  if (!text(value, 2048)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    // Query/fragment metadata can contain authentication or signed download tokens.
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}
function sourcesForTurns(turns) {
  const found = new Map(); let truncated = false;
  const add = (key, item) => {
    if (found.has(key)) { if (item.type === 'tool' || item.type === 'web-search') found.get(key).count++; return; }
    if (found.size >= 100) { truncated = true; return; }
    found.set(key, item);
  };
  const file = value => {
    const path = text(value?.fsPath ?? value?.path, 4096);
    if (path) add(`file:${path}`, { type: 'file', label: text(value.label) ?? basename(path.replaceAll('\\', '/')), path });
  };
  const external = (urlValue, label) => {
    const url = safeSourceUrl(urlValue); if (url) add(`url:${url}`, { type: 'web', label: text(label) ?? new URL(url).hostname, url });
  };
  for (const turn of turns) {
    for (const attachment of (turn.params?.attachments ?? []).slice(0, 100)) file(attachment);
    for (const item of (turn.items ?? []).slice(0, 5000)) {
      if (item.type === 'userMessage' || item.type === 'steeringUserMessage') {
        for (const attachment of (item.attachments ?? []).slice(0, 100)) file(attachment);
        for (const input of (item.content ?? item.input ?? []).slice(0, 100)) if (input.type === 'localImage') file(input);
      } else if (item.type === 'mcpToolCall') {
        const server = text(item.server, 128), tool = text(item.tool, 128);
        if (server && tool) add(`tool:${server}:${tool}`, { type: 'tool', label: `${server} · ${tool}`, count: 1 });
        // Recognized Notion fetch metadata only; never forward arbitrary result text.
        if (tool?.replaceAll('_', '-') === 'notion-fetch') for (const block of (item.result?.content ?? []).slice(0, 20)) {
          if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length > 20000) continue;
          try { const data = JSON.parse(block.text); if (data?.metadata?.type === 'page') external(data.url, data.title); } catch { /* Unrecognized results are omitted. */ }
        }
      } else if (item.type === 'webSearch') {
        add('web-search', { type: 'web-search', label: '网页搜索', count: 1 });
        if (['openPage', 'findInPage'].includes(item.action?.type)) external(item.action.url);
      }
    }
  }
  return { available: true, items: [...found.values()], partial: true, ...(truncated ? { reason: '仅显示前 100 个可识别来源' } : { reason: '仅显示已载入历史中的附件、网页及工具来源' }) };
}
function agentsForTurns(turns, parentId) {
  const found = new Map(); let truncated = false;
  const update = (id, patch) => {
    if (!UUID.test(id ?? '') || id === parentId) return;
    if (!found.has(id) && found.size >= 40) { truncated = true; return; }
    found.set(id, { threadId: id, name: '子智能体', path: null, parentThreadId: null, status: 'unknown', canRead: false, ...found.get(id), ...patch });
  };
  for (const turn of turns) for (const item of turn.items ?? []) {
    if (item.type === 'subAgentActivity') {
      const path = text(item.agentPath, 512);
      const status = { started: 'running', interacted: 'unknown', interrupted: 'interrupted', completed: 'completed' }[item.kind] ?? 'unknown';
      update(item.agentThreadId, { ...(path ? { name: path.split('/').filter(Boolean).at(-1) ?? path, path } : {}), status });
    } else if (item.type === 'collabAgentToolCall') {
      for (const id of (item.receiverThreadIds ?? []).slice(0, 40)) {
        const status = item.agentsStates?.[id]?.status;
        update(id, { ...(['pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound'].includes(status) ? { status } : {}), ...(item.tool === 'spawnAgent' && UUID.test(item.senderThreadId ?? '') ? { parentThreadId: item.senderThreadId } : {}) });
      }
    }
  }
  return { available: true, items: [...found.values()], partial: true, ...(truncated ? { reason: '仅显示前 40 个已记录子智能体' } : { reason: '仅显示已载入历史中的子智能体，状态来自最新读取' }) };
}
export function summarizeThreadContext(state, turns, latestTurn) {
  const roots = permissionRoots(state);
  return {
    permissions: { supported: !isDelegatedThread(state) && roots !== null, current: currentPermissionMode(state, latestTurn), options: permissionOptions },
    agents: agentsForTurns(turns, state.id), sources: sourcesForTurns(turns),
    delegated: isDelegatedThread(state), permissionRoots: roots,
  };
}
export async function readGitContext(cwd, execute = run) {
  if (!text(cwd, 4096)) return { available: false, reason: '会话没有可读取的工作目录' };
  try {
    const result = await execute('git', ['--no-optional-locks', '-C', cwd, 'status', '--porcelain=v2', '--branch', '--untracked-files=normal'], { timeout: 2500, maxBuffer: 256 * 1024, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
    const lines = result.stdout.split(/\r?\n/);
    const head = lines.find(line => line.startsWith('# branch.head '))?.slice(14);
    const oid = lines.find(line => line.startsWith('# branch.oid '))?.slice(13);
    if (!head || !oid) return { available: false, reason: 'Git 状态格式无法识别' };
    const detached = head === '(detached)';
    return { available: true, branch: detached ? null : text(head), commit: /^[a-f0-9]{40,64}$/.test(oid) ? oid : null, detached, dirty: lines.some(line => /^[12u?] /.test(line)) };
  } catch { return { available: false, reason: '工作目录不属于可读取的 Git 仓库' }; }
}

export async function hydrateAgentContext(agents, bridge) {
  const items = await Promise.all(agents.items.map(async item => {
    try {
      const data = typeof bridge.readMetadata === 'function' ? await bridge.readMetadata(item.threadId)
        : await bridge.read(item.threadId, undefined, { turnLimit: 1 });
      if (data.thread?.id !== item.threadId || data.thread.kind !== 'codex' || data.thread.hostId && data.thread.hostId !== 'local') return item;
      const nativeStatus = text(data.thread.status, 64) ?? 'unknown';
      // A dormant snapshot describes loading state, not the latest recorded completion event.
      const status = item.status === 'completed' && ['idle', 'notLoaded', 'notloaded', 'not_loaded', 'unknown'].includes(nativeStatus) ? 'completed' : nativeStatus;
      return { ...item, name: text(data.thread.title) ?? item.name, status, canRead: true };
    } catch { return { ...item, status: item.status === 'completed' ? 'completed' : 'unknown', canRead: false }; }
  }));
  return { ...agents, items };
}
