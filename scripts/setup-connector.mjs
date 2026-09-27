import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSecret } from './read-secret.mjs';

export const connectorConfigPath = fileURLToPath(new URL('../.local/hub-connector.json', import.meta.url));
const execute = promisify(execFile);
export function hubOrigin(value, allowInsecureLocal = false) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(allowInsecureLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('需要 HTTPS 入口地址。');
  return url.origin;
}
export async function privateFile(path) {
  if (process.platform !== 'win32') return;
  const literal = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.FileSecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl(${literal},$acl)`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
export async function pairConnector({ origin, pairingCode, name, bridgePort = 4317, configPath = connectorConfigPath, replace = false, allowInsecureLocal = false, fetchImpl = fetch } = {}) {
  const hub = hubOrigin(origin, allowInsecureLocal);
  if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535 || typeof pairingCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pairingCode)) throw new Error('配对码或本机端口无效。');
  try { await readFile(configPath); if (!replace) throw new Error('已有连接器配置；请先撤销原设备，或明确使用 --replace。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(`${hub}/api/hub/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: hub, 'X-Bridge-Client': 'mobile-v1' }, body: JSON.stringify({ pairingCode, name }), signal: AbortSignal.timeout(15000) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '设备配对失败。');
  if (!/^[a-f0-9-]{36}$/.test(value.deviceId || '') || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceToken || '')) throw new Error('配对响应无效，请从账号设备列表撤销该设备。');
  const config = { version: 1, hubOrigin: hub, deviceId: value.deviceId, deviceToken: value.deviceToken, bridgePort };
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    await privateFile(temporary); await rename(temporary, configPath);
  } catch (error) { await unlink(temporary).catch(() => {}); throw new Error('设备已配对，但凭据未能安全保存；请从设备列表撤销该设备后重试。', { cause: error }); }
  return { deviceId: value.deviceId, hubOrigin: hub };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const origin = process.argv[2], name = process.argv[3] || '我的电脑';
    if (!origin) throw new Error('Usage: node scripts/setup-connector.mjs https://YOUR-HUB [DEVICE-NAME] [--replace]');
    const pairingCode = await readSecret('配对码（不会显示）: ');
    let bridgePort = 4317;
    try { bridgePort = JSON.parse(await readFile(new URL('../.local/runtime.json', import.meta.url), 'utf8')).port || bridgePort; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const result = await pairConnector({ origin, name, pairingCode, bridgePort, replace: process.argv.includes('--replace') });
    console.log(`设备配对完成: ${result.deviceId}。运行 npm run connector:start 启动连接器。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
