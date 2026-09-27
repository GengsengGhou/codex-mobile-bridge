import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig } from './runtime.mjs';
import { launchWindowsBridge } from '../scripts/windows-launch.mjs';
import { BridgeError } from './desktop.mjs';

export const remoteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function remoteStatePath(root, runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(runId)) throw new Error('Invalid remote run identity.');
  return resolve(root, `.local/remote-access-state.${runId}.json`);
}
export async function readRemoteJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function writeRemoteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

export function createRemoteAccessManager({ root = remoteRoot, platform = process.platform,
  launchWindows = launchWindowsBridge, isAlive = processAlive, now = Date.now,
  sleep = ms => new Promise(done => setTimeout(done, ms)), stopTimeoutMs = 10000,
  loadConfig = loadRuntimeConfig, createAuth, gatewayPort = 4318 } = {}) {
  const configPath = resolve(root, '.local/remote-access.json');
  const executable = resolve(root, '.local/tools/cloudflared.exe');
  const unavailable = message => new BridgeError(message, 'REMOTE_UNAVAILABLE', 503);
  const busy = message => new BridgeError(message, 'REMOTE_BUSY', 409);
  const safe = async action => {
    try { return await action(); }
    catch (error) { throw error instanceof BridgeError ? error : unavailable('远程访问配置无法安全读取或保存，请检查本机配置。'); }
  };
  let queue = Promise.resolve();
  const serialized = action => {
    const next = queue.then(() => safe(action));
    queue = next.catch(() => {});
    return next;
  };
  const auth = async () => createAuth ? createAuth(resolve(root, '.local/remote-auth.json'))
    : new (await import('./remote-auth.mjs')).RemoteAuth({ path: resolve(root, '.local/remote-auth.json') });
  async function installed() { try { await access(executable); return true; } catch { return false; } }
  async function snapshot() {
    const config = await readRemoteJson(configPath);
    const state = config ? await readRemoteJson(remoteStatePath(root, config.runId)) : null;
    const matching = state && config && state.runId === config.runId;
    const age = matching ? now() - state.updatedAt : Infinity;
    const fresh = matching && age >= 0 && age < 6000 && isAlive(state.pid);
    const pending = config?.enabled && (!matching || state.state !== 'stopped');
    return { supported: platform === 'win32', installed: await installed(),
      state: fresh ? state.state : pending ? 'waiting' : 'stopped',
      url: fresh && state.state === 'running' ? state.url : null,
      lastError: fresh ? state.lastError || null : pending ? '远程连接暂未报告有效状态，请稍后刷新。' : null };
  }
  async function start() {
    const current = await snapshot();
    if (!current.supported) throw unavailable('远程访问目前需要 Windows。');
    if (!current.installed) throw unavailable('尚未安装 cloudflared，请先完成本机远程访问配置。');
    const previous = await readRemoteJson(configPath);
    const state = previous ? await readRemoteJson(remoteStatePath(root, previous.runId)) : null;
    if (previous?.enabled) return current;
    if (previous?.wrapperPid && state?.runId === previous.runId && state.state === 'stopped') {
      const deadline = now() + stopTimeoutMs;
      while (isAlive(previous.wrapperPid) && now() < deadline) await sleep(100);
      if (isAlive(previous.wrapperPid)) throw busy('上一次远程启动进程仍在退出，请稍后重试。');
    }
    if (previous && !(state?.runId === previous.runId && state.state === 'stopped')) {
      if (isAlive(state?.pid) || isAlive(previous.wrapperPid)) throw busy('上一次远程连接尚未安全停止，请先停止并稍后重试。');
      if (!previous.launchFailed && !previous.wrapperPid) throw busy('无法确认上一次远程启动状态，请检查本机进程后重试。');
    }
    const runtime = await loadConfig({ env: {}, configPath: resolve(root, '.local/runtime.json') });
    const accessCode = randomBytes(32).toString('base64url');
    const remoteAuth = await auth();
    await remoteAuth.configure(accessCode);
    const config = { enabled: true, runId: randomUUID(), bridgePort: runtime.port, gatewayPort };
    await writeRemoteJson(configPath, config);
    await writeRemoteJson(remoteStatePath(root, config.runId), { runId: config.runId, pid: null, state: 'starting', url: null, lastError: null, updatedAt: now() });
    try {
      const launched = await launchWindows({ root, nodePath: process.execPath,
        supervisorPath: resolve(root, 'scripts/remote-runner.mjs'),
        env: { BRIDGE_REMOTE_RUN_ID: config.runId },
        instanceName: `remote-${config.runId.replaceAll('-', '')}`, logName: 'remote' });
      config.wrapperPid = launched.pid;
      await writeRemoteJson(configPath, config);
    } catch {
      // A delayed WMI child is tied to this run and cannot join a later configuration.
      await writeRemoteJson(configPath, { ...config, enabled: false, launchFailed: true });
      throw unavailable('远程连接启动失败，请检查 .local/remote.stderr.log 后重试。');
    }
    return { ...(await snapshot()), state: 'starting', accessCode };
  }
  async function stop() {
    const config = await readRemoteJson(configPath);
    if (!config) return snapshot();
    await writeRemoteJson(configPath, { ...config, enabled: false });
    const deadline = now() + stopTimeoutMs;
    while (true) {
      const state = await readRemoteJson(remoteStatePath(root, config.runId));
      const confirmed = state?.runId === config.runId && state.state === 'stopped';
      const dead = state?.runId === config.runId && state.pid && !isAlive(state.pid)
        && !isAlive(config.wrapperPid);
      const neverStarted = state?.runId === config.runId && state.pid === null
        && state.state === 'starting' && (config.launchFailed || (config.wrapperPid && !isAlive(config.wrapperPid)));
      if (confirmed || dead || neverStarted) { await (await auth()).revokeAll(); return snapshot(); }
      if (now() >= deadline) throw busy('尚未确认远程连接已停止，登录凭据已保留；请稍后重试。');
      await sleep(100);
    }
  }
  return { status: () => safe(snapshot), start: () => serialized(start), stop: () => serialized(stop) };
}
