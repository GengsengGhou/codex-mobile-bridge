import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { launchWindowsBridge } from './windows-launch.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_MARKERS = ['<title>Codex Mobile Bridge</title>', '<title>Codex 手机桥接</title>'];
export function isBridgeRoot(html) { return ROOT_MARKERS.some(marker => html.includes(marker)); }

async function readBridgeRoot(baseUrl, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  if (!response.ok) return null;
  const cookie = response.headers.get('set-cookie')?.match(/(?:^|,\s*)bridge_session=([^;,\s]+)/)?.[1];
  const html = await response.text();
  if (!cookie || !isBridgeRoot(html)) return null;
  return `bridge_session=${cookie}`;
}

export async function verifyBridge(baseUrl, fetchImpl = fetch) {
  try {
    const cookie = await readBridgeRoot(baseUrl, fetchImpl);
    if (!cookie) return false;
    const response = await fetchImpl(`${baseUrl}/api/status`, {
      headers: { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1' },
      signal: AbortSignal.timeout(16000)
    });
    if (!response.ok) return false;
    const status = await response.json();
    return typeof status.connected === 'boolean'
      && typeof status.canSend === 'boolean'
      && typeof status.callerThreadId === 'string';
  } catch {
    return false;
  }
}

async function waitForBridge(baseUrl, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const cookie = await readBridgeRoot(baseUrl, fetchImpl);
      if (cookie) {
        const response = await fetchImpl(`${baseUrl}/api/status`, {
          headers: { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1' },
          signal: AbortSignal.timeout(Math.max(1000, deadline - Date.now()))
        });
        if (response.ok) {
          const status = await response.json();
          if (typeof status.connected === 'boolean' && typeof status.canSend === 'boolean'
            && typeof status.callerThreadId === 'string') return status;
        }
      }
    } catch { /* The child may still be binding its local listener. */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250));
  }
  throw new Error('桥接服务未能在时限内通过就绪检查；请查看 .local/bridge.stderr.log。');
}

export async function startBridge({
  loadConfig = loadRuntimeConfig,
  spawnProcess = spawn,
  fetchImpl = fetch,
  root = projectRoot,
  waitForReady = waitForBridge,
  platform = process.platform,
  launchWindows = launchWindowsBridge,
  output = console
} = {}) {
  const config = await loadConfig();
  const baseUrl = `http://127.0.0.1:${config.port}`;
  if (await verifyBridge(baseUrl, fetchImpl)) {
    output.log(`Codex 手机桥接已在运行：${baseUrl}`);
    return { started: false, url: baseUrl };
  }

  mkdirSync(resolve(root, '.local'), { recursive: true });
  const bridgeEnv = {
    CODEX_THREAD_ID: config.callerThreadId,
    BRIDGE_ENABLE_SEND: config.enableSend ? '1' : '0',
    BRIDGE_SEND_SCOPE: config.sendScope || 'single',
    BRIDGE_SEND_THREAD_ID: config.allowedSendThreadId || config.callerThreadId,
    BRIDGE_PORT: String(config.port)
  };
  if (process.env.CODEX_HOME) bridgeEnv.CODEX_HOME = process.env.CODEX_HOME;
  let launched;
  let childExited;
  if (platform === 'win32') {
    launched = await launchWindows({ root, nodePath: process.execPath, serverPath: resolve(root, 'src/server.mjs'), supervisorPath: resolve(root, 'scripts/supervisor.mjs'), env: bridgeEnv });
    output.log(`Windows independent launch: ${launched.mode} (PID ${launched.pid})`);
  } else {
    const stdoutFd = openSync(resolve(root, '.local/bridge.stdout.log'), 'a');
    const stderrFd = openSync(resolve(root, '.local/bridge.stderr.log'), 'a');
    let child;
    try {
      const childEnv = { ...process.env, ...bridgeEnv };
      delete childEnv.CODEX_APP_TOOLS_PIPE_PATH;
      child = spawnProcess(process.execPath, [resolve(root, 'src/server.mjs')], {
        cwd: root,
        env: childEnv,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', stdoutFd, stderrFd]
      });
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }

    child.unref();
    childExited = new Promise((_, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`桥接进程提前退出（${signal || code}）`)));
    });
    launched = { pid: child.pid, mode: 'detached' };
  }
  try {
    const ready = waitForReady(baseUrl, { fetchImpl });
    const status = await (childExited ? Promise.race([ready, childExited]) : ready);
    output.log(`Codex 手机桥接已就绪：${baseUrl}`);
    if (!status.connected) output.error('桥接已启动，但桌面 Codex 当前不可用；服务会继续运行并等待恢复。');
    return { started: true, url: baseUrl, pid: launched.pid, mode: launched.mode };
  } catch (error) {
    if (await verifyBridge(baseUrl, fetchImpl)) {
      output.log(`Codex 手机桥接已在运行：${baseUrl}`);
      return { started: false, url: baseUrl };
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await startBridge();
  } catch (error) {
    console.error(`启动手机桥接失败：${error.message}`);
    process.exitCode = 1;
  }
}
