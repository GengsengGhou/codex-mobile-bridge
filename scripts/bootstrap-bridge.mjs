import net from 'node:net';
import { open, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { DesktopBridge } from '../src/desktop.mjs';
import { createDesktopRequest } from '../src/discovery.mjs';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { startBridge } from './start.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 2 * 1024 * 1024;
const quiet = { log() {}, error() {} };
function validPort(value) { return Number.isInteger(value) && value >= 1024 && value <= 65535; }
async function smallJson(path) {
  if ((await stat(path)).size > LIMIT) throw new Error('配置文件过大，请检查本机配置。');
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > LIMIT) throw new Error('配置文件过大，请检查本机配置。');
  return JSON.parse(text);
}

export async function localThreadCandidates({ codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex'), maxCandidates = 80 } = {}) {
  const choices = new Map();
  const add = (id, title) => { if (UUID.test(id || '') && choices.size < maxCandidates && !choices.has(id)) choices.set(id, { id, title: typeof title === 'string' ? title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120) : '本机会话' }); };
  let file;
  try {
    file = await open(resolve(codexHome, 'session_index.jsonl'), 'r');
    const size = (await file.stat()).size, offset = Math.max(0, size - LIMIT);
    const bytes = Buffer.alloc(Math.min(size, LIMIT)); const result = await file.read(bytes, 0, bytes.length, offset);
    const lines = bytes.subarray(0, result.bytesRead).toString('utf8').split('\n');
    if (offset) lines.shift();
    for (const line of lines.reverse()) { try { const item = JSON.parse(line); add(item.id, item.thread_name || item.title); } catch {} }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 Codex 会话索引，请检查 Codex 本机数据目录。'); }
  finally { await file?.close(); }
  if (choices.size < maxCandidates) {
    try {
      const state = await smallJson(resolve(codexHome, '.codex-global-state.json'));
      for (const id of [...(state['projectless-thread-ids'] || []), ...(state['pinned-thread-ids'] || [])]) add(id);
      for (const [id, assignment] of Object.entries(state['thread-project-assignments'] || {})) if (!assignment?.hostId || assignment.hostId === 'local') add(id);
      for (const order of Object.values(state['sidebar-project-thread-orders'] || {})) for (const id of Array.isArray(order) ? order : order?.threadIds || []) add(id);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 Codex 侧栏配置，请先打开 Codex 并选择一个普通本机会话。'); }
  }
  return [...choices.values()];
}

export async function probeLocalBridge(port, fetchImpl = fetch) {
  try {
    const origin = `http://127.0.0.1:${port}`;
    const root = await fetchImpl(`${origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    if (!root.ok) return null;
    const cookie = root.headers.get('set-cookie')?.match(/(?:^|,\s*)bridge_session=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!cookie || !(await root.text()).includes('<title>Codex 手机桥接</title>')) return null;
    const response = await fetchImpl(`${origin}/api/status`, { headers: { cookie: `bridge_session=${cookie}`, 'x-bridge-client': 'mobile-v1' }, signal: AbortSignal.timeout(16000) });
    if (!response.ok) return null;
    const status = await response.json();
    return status.connected === true && status.mode === 'desktop-pipe' && typeof status.canSend === 'boolean' && UUID.test(status.callerThreadId || '') ? status : null;
  } catch { return null; }
}

export async function chooseFreePort(preferred = 4317) {
  async function bind(port) {
    const server = net.createServer();
    return new Promise((resolvePort, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { const selected = server.address().port; server.close(error => error ? reject(error) : resolvePort(selected)); });
    });
  }
  try { return await bind(preferred); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; return bind(0); }
}

async function promptThread(choices) {
  if (!process.stdin.isTTY) throw new Error('首次配置需要选择普通本机会话；请在交互终端运行，或传入 --thread 会话ID。');
  process.stderr.write('请选择用于启动桥接的现有普通本机会话：\n');
  choices.forEach((choice, index) => process.stderr.write(`${index + 1}. ${choice.title} (${choice.id})\n`));
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try { const value = (await reader.question('输入编号：')).trim(); if (!/^\d+$/.test(value) || !choices[Number(value) - 1]) throw new Error('选择无效，请重新运行并选择会话。'); return choices[Number(value) - 1].id; }
  finally { reader.close(); }
}

export async function selectOrdinaryLocalThread(choices, bridgeFactory = options => new DesktopBridge({ ...options, request: createDesktopRequest() })) {
  for (const choice of choices) {
    try {
      const candidate = bridgeFactory({ callerThreadId: choice.id });
      const data = await candidate.call('read_thread', { threadId: choice.id, hostId: 'local', turnLimit: 1, includeOutputs: false });
      const thread = data?.thread;
      if (thread?.id === choice.id && thread.kind === 'codex' && !thread.archived && !thread.parentThreadId && !thread.isSubagent && !thread.isSubAgent && thread.agentRole !== 'subagent' && (!thread.hostId || thread.hostId === 'local')) return choice.id;
    } catch {}
  }
  throw new Error('请在 Codex 中打开一个现有普通本机会话后重试。');
}

export async function ensureLocalBridge({ root = defaultRoot, callerThreadId, port, selectThread = promptThread, codexHome, platform = process.platform, probe = probeLocalBridge, candidates = localThreadCandidates, request = createDesktopRequest(), bridgeFactory = options => new DesktopBridge(options), choosePort = chooseFreePort, loadConfig = loadRuntimeConfig, start = startBridge } = {}) {
  root = resolve(root);
  if (port !== undefined && !validPort(port)) throw new Error('桥接端口必须是 1024 至 65535 的整数。');
  if (callerThreadId !== undefined && !UUID.test(callerThreadId)) throw new Error('会话ID格式无效。');
  const configPath = resolve(root, '.local/runtime.json');
  let saved;
  try { saved = await smallJson(configPath); } catch (error) { if (error.code !== 'ENOENT') throw new Error('已有桥接配置损坏，请检查 .local/runtime.json。'); }
  if (saved && (!UUID.test(saved.callerThreadId || '') || !validPort(saved.port) || !['single', 'all-local'].includes(saved.sendScope))) throw new Error('已有桥接配置无效，请检查 .local/runtime.json。');
  const preferred = port ?? saved?.port ?? 4317;
  const existing = await probe(preferred);
  if (existing) return { port: preferred, started: false, connected: true, url: `http://127.0.0.1:${preferred}` };
  if (platform !== 'win32') throw new Error('首次自动配置仅支持 Windows；请在 Windows 上打开 Codex 后重试。');
  const seed = callerThreadId || saved?.callerThreadId;
  const bridge = bridgeFactory({ callerThreadId: seed, request, ...(codexHome ? { sidebarPath: resolve(codexHome, '.codex-global-state.json') } : {}) });
  const tools = await bridge.capabilities();
  if (!['list_threads', 'read_thread'].every(name => tools.includes(name))) throw new Error('Codex 桌面缺少读取接口，请更新并打开 Codex 后重试。');
  let selected = seed;
  if (!selected) {
    const choices = await candidates({ codexHome });
    if (!choices.length) throw new Error('未找到本机会话，请先在 Codex 中建立或打开一个普通本机会话，再运行安装。');
    selected = await selectThread(choices, options => bridgeFactory({ ...options, request }));
    if (!choices.some(choice => choice.id === selected)) throw new Error('请选择列表中的现有本机会话。');
  }
  if (!UUID.test(selected || '')) throw new Error('未选择有效的本机会话。');
  bridge.callerThreadId = selected;
  const data = await bridge.call('read_thread', { threadId: selected, hostId: 'local', turnLimit: 1, includeOutputs: false });
  const thread = data?.thread;
  if (!thread || thread.id !== selected || thread.kind !== 'codex' || thread.archived || thread.hostId && thread.hostId !== 'local' || thread.parentThreadId || thread.isSubagent || thread.isSubAgent || thread.agentRole === 'subagent') throw new Error('所选会话不是可用的普通本机会话；请在 Codex 中选择未归档的普通本机会话后重试。');
  const chosenPort = await choosePort(preferred);
  if (port !== undefined && chosenPort !== port) throw new Error('指定的桥接端口已被其他程序占用。');
  const env = saved ? { BRIDGE_PORT: String(chosenPort), ...(callerThreadId ? { CODEX_THREAD_ID: selected } : {}) } : { CODEX_THREAD_ID: selected, BRIDGE_ENABLE_SEND: '1', BRIDGE_SEND_SCOPE: 'all-local', BRIDGE_PORT: String(chosenPort) };
  const config = await loadConfig({ env, configPath });
  const launch = await start({ root, platform: 'win32', loadConfig: async () => config, output: quiet });
  const ready = await probe(chosenPort);
  if (!ready || ready.callerThreadId !== config.callerThreadId) throw new Error('桥接未能连接所选 Codex 会话，已停止配对步骤；请检查 Codex 是否打开和 .local/bridge.stderr.log。');
  return { port: chosenPort, started: launch.started, connected: true, url: `http://127.0.0.1:${chosenPort}` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flags = new Map();
    for (let index = 2; index < process.argv.length; index++) { const key = process.argv[index]; if (key === '--json') flags.set(key, true); else if (['--thread', '--port', '--root'].includes(key) && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) flags.set(key, process.argv[++index]); else throw new Error('用法: bootstrap-bridge.mjs [--json] [--thread 会话ID] [--port 端口] [--root 安装目录]'); }
    const result = await ensureLocalBridge({ root: flags.get('--root') || defaultRoot, callerThreadId: flags.get('--thread'), port: flags.has('--port') ? Number(flags.get('--port')) : undefined });
    if (flags.get('--json')) console.log(JSON.stringify(result)); else console.log(`本机桥接已连接 Codex：${result.url}`);
  } catch (error) { console.error(`本机桥接配置失败，尚未配对：${error.message}`); process.exitCode = 1; }
}
