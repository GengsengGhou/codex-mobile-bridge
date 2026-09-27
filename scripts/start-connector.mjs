import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConnector } from '../hub/connector.mjs';
import { connectorConfigPath } from './setup-connector.mjs';
import { launchWindowsBridge } from './windows-launch.mjs';
import { writeRecoveryFile } from '../src/recovery.mjs';

export async function runSavedConnector({ configPath = connectorConfigPath } = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.version !== 1) throw new Error('连接器配置版本不兼容，请重新配对。');
  return startConnector(config);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--background')) {
      if (process.platform !== 'win32') throw new Error('后台包装仅支持 Windows；Linux 请使用 systemd 或进程管理器。');
      const root = fileURLToPath(new URL('..', import.meta.url));
      const result = await launchWindowsBridge({ root, nodePath: process.execPath, supervisorPath: fileURLToPath(import.meta.url), env: {}, instanceName: 'hub-connector', logName: 'hub-connector' });
      console.log(`连接器已提交后台启动（PID ${result.pid}）。请在 Hub 设备列表核对在线状态。`);
    } else {
      const connector = await runSavedConnector();
      const statePath = fileURLToPath(new URL('../.local/hub-connector-state.json', import.meta.url));
      let writes = Promise.resolve(), lastState;
      const publish = () => {
        const status = connector.status();
        if (status.state !== lastState) { console.log(`连接器状态：${status.state}`); lastState = status.state; }
        const snapshot = { ...status, pid: process.pid, updatedAt: new Date().toISOString() };
        writes = writes.catch(() => {}).then(() => writeRecoveryFile(statePath, snapshot));
        return writes;
      };
      await publish();
      const heartbeat = setInterval(() => { publish().catch(() => {}); }, 1000);
      const stop = () => { clearInterval(heartbeat); connector.stop(); publish().catch(() => {}); };
      process.once('SIGINT', stop); process.once('SIGTERM', stop);
      console.log('连接器已启动，正在连接已配对的 Hub。');
    }
  } catch { console.error('连接器启动失败，请检查已保存的配对配置与 Node.js 版本。'); process.exitCode = 1; }
}
