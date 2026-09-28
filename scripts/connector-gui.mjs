import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairConnector, connectorConfigPath } from './setup-connector.mjs';
import { chooseFreePort, probeLocalBridge } from './bootstrap-bridge.mjs';
import { registerDeferredConnectorLogin, launchConnectorLoginWatcher } from './connector-login.mjs';
import { createConnectorControl, stopOwnedConnectorProcesses } from './connector-control.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function guiCommand(command, deps = {}) {
  const appRoot = deps.root || root;
  const control = deps.control || createConnectorControl({ root: appRoot });
  const configPath = deps.configPath || connectorConfigPath;
  const read = deps.read || (async () => { try { return JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } });
  if (command.action === 'status') {
    const intent = await control.read();
    const config = await read();
    let state = {};
    try { state = JSON.parse(await readFile(resolve(appRoot, '.local/hub-connector-state.json'), 'utf8')); } catch {}
    const bridgeConnected = !!config && !!await (deps.probe || probeLocalBridge)(config.bridgePort);
    return { paired: !!config, origin: config?.hubOrigin, deviceId: config?.deviceId, bridgeConnected, paused: intent.paused, autoStart: intent.autoStart === true, lastError: intent.lastError, state: intent.paused ? (intent.disconnectVerified ? 'paused' : 'stopping') : Date.now() - Date.parse(state.updatedAt) < 6000 && bridgeConnected ? state.state : 'waiting' };
  }
  if (command.action === 'initialize') return control.initialize();
  if (command.action === 'disconnect' || command.action === 'quit') return { ...await control.pause(), state: 'paused' };
  if (command.action === 'autostart') return control.configure(command.enabled);
  if (command.action === 'pair') {
    const old = await read();
    if (old && !command.replace) throw new Error('已有设备配对；更换服务器前请明确勾选替换现有配对。');
    const intent = await control.resume('manual');
    const port = old?.bridgePort || await (deps.choosePort || chooseFreePort)(4317);
    // pairConnector validates the server response before atomically replacing saved credentials.
    const result = await (deps.pair || pairConnector)({ origin: command.origin, name: command.name, pairingCode: command.code, bridgePort: port, configPath, replace: !!old });
    if (old) await (deps.stopPrevious || (() => stopOwnedConnectorProcesses({ root: appRoot })))();
    await (deps.registerDeferred || registerDeferredConnectorLogin)({ root: appRoot, allowBootstrap: !old, registerStartup: false });
    if (!await control.mayRun(intent.revision)) return { paired: true, ...result, state: 'paused', paused: true };
    await (deps.watch || launchConnectorLoginWatcher)({ root: appRoot });
    return { paired: true, ...result, state: 'waiting', paused: false };
  }
  if (command.action === 'connect') {
    const config = await read();
    if (!config) throw new Error('请先绑定这台电脑。');
    const intent = await control.resume(command.reason === 'startup' ? 'startup' : 'manual');
    if (intent.paused || (command.reason === 'startup' && !intent.autoStart)) return { paired: true, paused: true, state: 'paused' };
    await (deps.registerDeferred || registerDeferredConnectorLogin)({ root: appRoot, registerStartup: false });
    if (!await control.mayRun(intent.revision)) return { paired: true, paused: true, state: 'paused' };
    await (deps.watch || launchConnectorLoginWatcher)({ root: appRoot });
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
