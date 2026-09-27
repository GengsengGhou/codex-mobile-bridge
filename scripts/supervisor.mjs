import { spawn } from 'node:child_process';
import { open, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { readRecoveryFile, writeRecoveryFile, RECOVERY_ROOT } from '../src/recovery.mjs';

export const restartDelay = (failures, { baseMs = 1000, maximumMs = 30000 } = {}) => Math.min(maximumMs, baseMs * 2 ** Math.min(Math.max(0, failures - 1), 20));

export const portOccupied = port => new Promise(done => {
  const socket = createConnection({ host: '127.0.0.1', port });
  const finish = occupied => { socket.destroy(); done(occupied); };
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
  socket.setTimeout(2000, () => finish(true));
});

export async function runSupervisor({ root = RECOVERY_ROOT, serverPath = resolve(root, 'src/server.mjs'), spawnProcess = spawn,
  loadConfig = () => loadRuntimeConfig({ env: {}, configPath: resolve(root, '.local/runtime.json') }),
  isPortOccupied = portOccupied,
  sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now,
  heartbeatMs = 1000, stableMs = 60000, backoff = {}, writeState = writeRecoveryFile } = {}) {
  await mkdir(resolve(root, '.local'), { recursive: true });
  const statePath = resolve(root, '.local/recovery-state.json');
  const preferencePath = resolve(root, '.local/recovery.json');
  const state = { supervisorPid: process.pid, childPid: null, state: 'waiting', restartCount: 0, lastRestartAt: null, lastError: null };
  let writeQueue = Promise.resolve();
  const publish = () => {
    const snapshot = { ...state, updatedAt: new Date(now()).toISOString() };
    writeQueue = writeQueue.catch(() => {}).then(() => writeState(statePath, snapshot));
    return writeQueue;
  };
  const heartbeat = setInterval(() => { publish().catch(() => {}); }, heartbeatMs);
  let failures = 0;
  try {
    while (true) {
      let startedAt = now();
      let stdout, stderr;
      try {
        const config = await loadConfig();
        if (await isPortOccupied(config.port)) {
          state.lastError = '桥接端口已被占用；请先关闭占用该端口的服务。';
          break;
        }
        const env = { ...process.env, CODEX_THREAD_ID: config.callerThreadId, BRIDGE_PORT: String(config.port),
          BRIDGE_ENABLE_SEND: config.enableSend ? '1' : '0', BRIDGE_SEND_SCOPE: config.sendScope,
          BRIDGE_SEND_THREAD_ID: config.allowedSendThreadId };
        delete env.CODEX_APP_TOOLS_PIPE_PATH;
        stdout = await open(resolve(root, '.local/bridge.stdout.log'), 'a');
        stderr = await open(resolve(root, '.local/bridge.stderr.log'), 'a');
        const child = spawnProcess(process.execPath, [serverPath], { cwd: root, env, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
        // Resolve errors too: spawning can fail before the first async state write.
        const exited = new Promise(done => { child.once('error', error => done({ error })); child.once('exit', (code, signal) => done({ code, signal })); });
        state.childPid = child.pid || null;
        state.state = 'running';
        try { await publish(); }
        catch { state.lastError = '恢复状态暂时无法保存；桥接仍在运行。'; }
        const exit = await exited;
        state.lastError = exit.error ? `桥接启动失败：${exit.error.message}` : `桥接进程已退出（${exit.signal || exit.code}）。`;
      } catch (error) { state.lastError = error.message; }
      finally { await stdout?.close(); await stderr?.close(); }
      state.childPid = null;
      const preferences = await readRecoveryFile(preferencePath, { autoRestart: true });
      if (!preferences.autoRestart) break;
      failures = now() - startedAt >= stableMs ? 1 : failures + 1;
      state.state = 'waiting';
      await publish();
      await sleep(restartDelay(failures, backoff));
      if (!(await readRecoveryFile(preferencePath, { autoRestart: true })).autoRestart) break;
      state.restartCount += 1;
      state.lastRestartAt = new Date(now()).toISOString();
    }
  } finally {
    clearInterval(heartbeat);
    state.state = 'stopped';
    state.childPid = null;
    await publish();
  }
  return state;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runSupervisor(); }
  catch (error) { console.error(`Bridge supervisor failed: ${error.message}`); process.exitCode = 1; }
}
