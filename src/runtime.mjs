import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../.local/runtime.json', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadRuntimeConfig({ env = process.env, configPath = DEFAULT_CONFIG_PATH } = {}) {
  let saved = {};
  try { saved = JSON.parse(await readFile(configPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('启动配置损坏，请在 Codex 任务中重新配置。'); }
  const callerThreadId = env.CODEX_THREAD_ID || saved.callerThreadId;
  const enableSend = env.BRIDGE_ENABLE_SEND === undefined ? saved.enableSend === true : env.BRIDGE_ENABLE_SEND === '1';
  const allowedSendThreadId = env.BRIDGE_SEND_THREAD_ID || saved.allowedSendThreadId || callerThreadId;
  const sendScope = env.BRIDGE_SEND_SCOPE || saved.sendScope || 'single';
  const port = Number(env.BRIDGE_PORT ?? saved.port ?? 4317);
  if (!UUID.test(callerThreadId ?? '')) throw new Error('首次启动请在 Codex 任务内运行 npm start，以记录连接任务。');
  if (!UUID.test(allowedSendThreadId ?? '')) throw new Error('Invalid BRIDGE_SEND_THREAD_ID');
  if (!['single', 'all-local'].includes(sendScope)) throw new Error('Invalid BRIDGE_SEND_SCOPE');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid BRIDGE_PORT');
  // Never persist pipe paths, provider settings, environment dumps, or credentials.
  const config = { callerThreadId, enableSend, allowedSendThreadId, sendScope, port };
  if (JSON.stringify(saved) !== JSON.stringify(config)) {
    await mkdir(dirname(configPath), { recursive: true });
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, configPath);
  }
  return config;
}
