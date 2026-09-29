import { mkdir, writeFile, rename, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readSecret } from './read-secret.mjs';

export const connectorConfigPath = fileURLToPath(new URL('../.local/hub-connector.json', import.meta.url));
const execute = promisify(execFile);
const pairingFields = ['type', 'version', 'server', 'code', 'name', 'expiresAt'];
export function hubOrigin(value, allowInsecureLocal = false) {
  if (typeof value !== 'string' || value.length > 2048 || value !== value.trim() || !/^https:\/\/[^/?#]+\/?$/i.test(value) && !(allowInsecureLocal && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/?$/i.test(value))) throw new Error('HTTPS 服务器地址无效。');
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(allowInsecureLocal && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('需要 HTTPS 入口地址。');
  return url.origin;
}
export function parsePairingInformation(information, { now = Date.now() } = {}) {
  if (typeof information !== 'string' || Buffer.byteLength(information, 'utf8') > 4096) throw new Error('配对信息无效或过大。');
  let value;
  try { value = JSON.parse(information); } catch { throw new Error('配对信息不是有效 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== pairingFields.length || pairingFields.some(field => !Object.hasOwn(value, field))) throw new Error('配对信息字段不完整或包含不支持的字段。');
  if (value.type !== 'codex-mobile-pairing' || value.version !== 1 || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code) || typeof value.name !== 'string' || value.name.length > 80 || /[\x00-\x1f\x7f]/.test(value.name) || typeof value.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.expiresAt)) throw new Error('配对信息格式无效。');
  const expiry = Date.parse(value.expiresAt);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== value.expiresAt || expiry <= now) throw new Error('配对信息已过期或无效。请在网页重新生成。');
  let server;
  try { server = hubOrigin(value.server); } catch { throw new Error('配对信息中的 HTTPS 服务器地址无效。'); }
  return { server, origin: server, code: value.code, name: value.name.trim(), expiresAt: new Date(expiry).toISOString() };
}
export async function privateFile(path) {
  if (process.platform !== 'win32') return;
  const literal = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.FileSecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','Allow'); $acl.AddAccessRule($rule); [IO.File]::SetAccessControl(${literal},$acl)`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
export async function pairConnector({ information, origin, pairingCode, name, bridgePort = 4317, configPath = connectorConfigPath, replace = false, allowInsecureLocal = false, fetchImpl = fetch } = {}) {
  const ticket = information === undefined ? null : parsePairingInformation(information);
  const hub = hubOrigin(ticket?.server ?? origin, allowInsecureLocal);
  pairingCode = ticket?.code ?? pairingCode;
  name = ticket?.name ?? name;
  if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535 || typeof pairingCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pairingCode) || (name !== undefined && (typeof name !== 'string' || name.length > 80))) throw new Error('配对码、设备名称或本机端口无效。');
  try { await readFile(configPath); if (!replace) throw new Error('已有连接器配置；请先撤销原设备，或明确使用 --replace。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const response = await fetchImpl(`${hub}/api/hub/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: hub, 'X-Bridge-Client': 'mobile-v1' }, body: JSON.stringify({ pairingCode, ...(ticket && !name ? {} : { name }) }), signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('设备配对失败；请在网页检查配对码并重新生成。');
  let value;
  try { value = await response.json(); }
  catch { throw new Error('配对响应无效，请检查服务器并重新生成配对信息。'); }
  if (!/^[a-f0-9-]{36}$/.test(value.deviceId || '') || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceToken || '')) throw new Error('配对响应无效，请从账号设备列表撤销该设备。');
  const config = { version: 1, hubOrigin: hub, deviceId: value.deviceId, deviceToken: value.deviceToken, deviceName: name || process.env.COMPUTERNAME || '我的电脑', bridgePort };
  await mkdir(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(config, null, 2), { mode: 0o600, flag: 'wx' });
    await privateFile(temporary); await rename(temporary, configPath);
  } catch (error) { await unlink(temporary).catch(() => {}); throw new Error('设备已配对，但凭据未能安全保存；请从设备列表撤销该设备后重试。', { cause: error }); }
  return { deviceId: value.deviceId, hubOrigin: hub, deviceName: config.deviceName };
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
