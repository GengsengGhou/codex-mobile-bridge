import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pairConnector, connectorConfigPath } from './setup-connector.mjs';
import { chooseFreePort, probeLocalBridge } from './bootstrap-bridge.mjs';
import { registerDeferredConnectorLogin, launchConnectorLoginWatcher } from './connector-login.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
async function stopPreviousConnector() {
  let state;
  try { state = JSON.parse(await readFile(resolve(root, '.local/hub-connector-state.json'), 'utf8')); } catch { return; }
  if (!Number.isInteger(state.pid) || state.pid < 1) return;
  const literal = value => `'${value.replaceAll("'", "''")}'`;
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${state.pid}'; if ($p -and $p.ExecutablePath -ceq ${literal(process.execPath)} -and $p.CommandLine.Contains(${literal(resolve(root, 'scripts/start-connector.mjs'))})) { Stop-Process -Id $p.ProcessId -Force }`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
export async function guiCommand(command, deps = {}) {
  const configPath = deps.configPath || connectorConfigPath;
  const read = deps.read || (async () => { try { return JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } });
  if (command.action === 'status') {
    const config = await read();
    let state = {};
    try { state = JSON.parse(await readFile(resolve(root, '.local/hub-connector-state.json'), 'utf8')); } catch {}
    const bridgeConnected = !!config && !!await (deps.probe || probeLocalBridge)(config.bridgePort);
    return { paired: !!config, origin: config?.hubOrigin, deviceId: config?.deviceId, bridgeConnected, state: Date.now() - Date.parse(state.updatedAt) < 15000 && bridgeConnected ? state.state : 'waiting' };
  }
  if (command.action === 'pair') {
    const old = await read();
    if (old && !command.replace) throw new Error('已有设备配对；更换服务器前请明确勾选替换现有配对。');
    const port = old?.bridgePort || await (deps.choosePort || chooseFreePort)(4317);
    // pairConnector validates the server response before atomically replacing saved credentials.
    const result = await (deps.pair || pairConnector)({ origin: command.origin, name: command.name, pairingCode: command.code, bridgePort: port, configPath, replace: !!old });
    if (old) await (deps.stopPrevious || stopPreviousConnector)();
    await (deps.registerDeferred || registerDeferredConnectorLogin)({ root, allowBootstrap: !old });
    await (deps.watch || launchConnectorLoginWatcher)({ root });
    return { paired: true, ...result, state: 'waiting' };
  }
  if (command.action === 'connect') {
    const config = await read();
    if (!config) throw new Error('请先绑定这台电脑。');
    await (deps.registerDeferred || registerDeferredConnectorLogin)({ root });
    await (deps.watch || launchConnectorLoginWatcher)({ root });
    return { paired: true, state: 'connecting' };
  }
  throw new Error('连接程序命令无效。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw new Error('请求过大。'); }
  try { console.log(JSON.stringify({ ok: true, ...await guiCommand(JSON.parse(text)) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
