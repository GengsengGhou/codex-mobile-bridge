import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConnector } from '../hub/connector.mjs';
import { connectorConfigPath } from './setup-connector.mjs';
import { launchWindowsBridge } from './windows-launch.mjs';
import { writeRecoveryFile } from '../src/recovery.mjs';
import { connectorMayRun } from './connector-control.mjs';
import { createCollaborationExecutor } from './collaboration-executor.mjs';
import { elapsedNow } from '../src/elapsed-time.mjs';

export async function runSavedConnector({ configPath = connectorConfigPath } = {}) {
  if (!await connectorMayRun(resolve(configPath, '../..'))) throw new Error('连接器已暂停。');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1) throw new Error('连接器配置版本不兼容，请重新配对。');
  const connector = startConnector({ ...config, collaborationExecutor: createCollaborationExecutor({ root: resolve(configPath, '../..'), config, configPath }) });
  return {
    ...connector,
    status: () => ({ ...connector.status(), hubOrigin: config.hubOrigin, deviceId: config.deviceId }),
    bindingCurrent: async () => {
      const current = JSON.parse(await readFile(configPath, 'utf8'));
      return current.hubOrigin === config.hubOrigin && current.deviceId === config.deviceId && current.deviceToken === config.deviceToken;
    },
  };
}

// Own the connector and its heartbeat as one lifetime. In particular, a failed
// first heartbeat must not leave retry sockets/timers alive under the Windows
// launcher's mutex: that would prevent the login watcher from replacing it.
export async function runConnectorForeground({
  run = runSavedConnector,
  root = fileURLToPath(new URL('..', import.meta.url)),
  statePath = resolve(root, '.local/hub-connector-state.json'),
  writeState = writeRecoveryFile,
  mayRun = connectorMayRun,
  signals = process,
  intervalMs = 1000,
  output = console,
} = {}) {
  const connector = await run();
  let stopped = false, timer, wake, lastState;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    connector.stop();
    wake?.();
  };
  const publish = async () => {
    const status = connector.status();
    if (status.state !== lastState) { output.log(`连接器状态：${status.state}`); lastState = status.state; }
    try {
      await writeState(statePath, { ...status, pid: process.pid, heartbeatMonotonicMs: elapsedNow(), updatedAt: new Date().toISOString() });
    } catch (cause) {
      throw Object.assign(new Error('连接器状态文件写入失败；已停止连接，恢复监测会自动重试。', { cause }), { code: 'CONNECTOR_STATE_WRITE_FAILED' });
    }
  };
  signals.once('SIGINT', stop); signals.once('SIGTERM', stop);
  try {
    await publish();
    output.log('连接器已启动，正在连接已配对的 Hub。');
    while (!stopped) {
      await new Promise(done => { wake = done; timer = setTimeout(done, intervalMs); });
      wake = null;
      if (stopped) break;
      if (!await mayRun(root) || !await connector.bindingCurrent()) { stop(); break; }
      if (!stopped) await publish();
    }
    await publish();
  } finally {
    stop();
    signals.removeListener('SIGINT', stop); signals.removeListener('SIGTERM', stop);
  }
}

export function connectorFailureMessage(error) {
  if (error?.code === 'CONNECTOR_STATE_WRITE_FAILED') {
    const systemCode = ['EPERM', 'EACCES', 'EBUSY', 'ENOENT', 'ENOSPC', 'EROFS', 'EMFILE', 'ENFILE', 'EIO'].includes(error.cause?.code) ? `（${error.cause.code}）` : '';
    return `连接器状态文件写入失败${systemCode}；连接已停止，恢复监测会自动重试。请检查安装目录写入权限或安全软件占用。`;
  }
  return '连接器启动或运行失败，请检查已保存的配对配置与 Node.js 版本。';
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--background')) {
      if (process.platform !== 'win32') throw new Error('后台包装仅支持 Windows；Linux 请使用 systemd 或进程管理器。');
      const root = fileURLToPath(new URL('..', import.meta.url));
      const result = await launchWindowsBridge({ root, nodePath: process.execPath, supervisorPath: fileURLToPath(import.meta.url), env: {}, instanceName: 'hub-connector', logName: 'hub-connector' });
      console.log(`连接器已提交后台启动（PID ${result.pid}）。请在 Hub 设备列表核对在线状态。`);
    } else {
      await runConnectorForeground();
    }
  } catch (error) { console.error(connectorFailureMessage(error)); process.exitCode = 1; }
}
