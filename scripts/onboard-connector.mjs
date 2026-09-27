import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureLocalBridge } from './bootstrap-bridge.mjs';
import { pairConnector, hubOrigin, connectorConfigPath } from './setup-connector.mjs';
import { readSecret } from './read-secret.mjs';
import { launchWindowsBridge } from './windows-launch.mjs';

export async function onboardConnector({ origin, name = '我的电脑', root = fileURLToPath(new URL('..', import.meta.url)), ensureBridge = ensureLocalBridge,
  configPath = connectorConfigPath, pair = pairConnector, readCode = () => readSecret('配对码（不会显示）: '), launch = launchWindowsBridge } = {}) {
  const hub = hubOrigin(origin);
  const bridge = await ensureBridge({ root });
  if (!bridge?.connected || !Number.isInteger(bridge.port)) throw new Error('本机 Codex 桥接尚未就绪，未进行配对。');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (config) {
    if (config.hubOrigin !== hub || config.bridgePort !== bridge.port) throw new Error('已有连接器绑定其他入口或端口；请先停止并撤销旧设备后重新配置。');
  } else {
    await pair({ origin: hub, name, bridgePort: bridge.port, configPath, pairingCode: await readCode() });
    config = JSON.parse(await readFile(configPath, 'utf8'));
  }
  const result = await launch({ root, nodePath: process.execPath, supervisorPath: resolve(root, 'scripts/start-connector.mjs'), env: {}, instanceName: 'hub-connector', logName: 'hub-connector' });
  return { deviceId: config.deviceId, bridgePort: bridge.port, submitted: true, pid: result.pid };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error('Usage: node scripts/onboard-connector.mjs HTTPS-HUB [DEVICE-NAME]');
    const result = await onboardConnector({ origin: process.argv[2], name: process.argv[3] || '我的电脑' });
    console.log(`本机桥接已连接；设备 ${result.deviceId} 的连接器已提交后台启动。请在 Hub 中核对在线状态。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
