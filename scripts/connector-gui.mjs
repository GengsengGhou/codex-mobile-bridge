import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairConnector, connectorConfigPath, hubOrigin, parsePairingInformation } from './setup-connector.mjs';
import { chooseFreePort, probeLocalBridge } from './bootstrap-bridge.mjs';
import { registerDeferredConnectorLogin, launchConnectorLoginWatcher } from './connector-login.mjs';
import { createConnectorControl, stopOwnedConnectorProcesses } from './connector-control.mjs';
import { createConnectorUpdater } from './connector-updates.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function guiCommand(command, deps = {}) {
  const appRoot = deps.root || root;
  if (['get-update-state', 'check-update', 'update-preferences', 'download-update'].includes(command.action)) {
    const updater = deps.updater || createConnectorUpdater({ root: appRoot, ...deps.updateOptions });
    if (command.action === 'get-update-state') return updater.state();
    if (command.action === 'check-update') return updater.check({ manual: command.manual ?? true });
    if (command.action === 'update-preferences') return updater.preferences(command.automatic);
    return updater.download();
  }
  const control = deps.control || createConnectorControl({ root: appRoot });
  const configPath = deps.configPath || connectorConfigPath;
  const read = deps.read || (async () => { try { return JSON.parse(await readFile(configPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; } });
  if (command.action === 'status') {
    const config = await read();
    const bridgeConnected = !!config && !!await (deps.probe || probeLocalBridge)(config.bridgePort);
    // Read heartbeat and intent after the potentially slow local Codex probe.
    const intent = await control.read();
    let state = {};
    try { state = deps.readState ? await deps.readState() : JSON.parse(await readFile(resolve(appRoot, '.local/hub-connector-state.json'), 'utf8')); } catch {}
    const age = Date.now() - Date.parse(state.updatedAt);
    const fresh = !!config && Number.isFinite(age) && age >= 0 && age < 6000;
    const hubState = intent.paused ? 'paused' : fresh && ['online','connected','connecting','offline','stopped'].includes(state.state) ? state.state : 'waiting';
    const hubConnected = !intent.paused && fresh && (state.state === 'online' || state.state === 'connected');
    return { paired: !!config, origin: config?.hubOrigin, deviceId: config?.deviceId, deviceName: config?.deviceName || process.env.COMPUTERNAME || hostname(), bridgeConnected, hubConnected, hubState, paused: intent.paused, pauseScope: intent.pauseScope, persistentPaused: intent.pauseScope === 'persistent', autoStart: intent.autoStart === true, lastError: intent.lastError, state: intent.paused ? (intent.disconnectVerified ? 'paused' : 'stopping') : fresh && bridgeConnected ? state.state : 'waiting' };
  }
  if (command.action === 'initialize') return control.initialize();
  if (command.action === 'validate-pairing') {
    const ticket = parsePairingInformation(command.information);
    return { origin: ticket.origin, name: ticket.name, expiresAt: ticket.expiresAt };
  }
  if (command.action === 'disconnect' || command.action === 'quit') return { ...await control.pause(command.action === 'disconnect' ? 'persistent' : 'session'), state: 'paused' };
  if (command.action === 'autostart') return control.configure(command.enabled);
  if (command.action === 'pair') {
    const ticket = command.information === undefined ? null : parsePairingInformation(command.information);
    const pairing = ticket ? { information: command.information } : {
      origin: hubOrigin(command.origin, deps.allowInsecureLocal === true),
      name: (typeof command.name === 'string' ? command.name.trim() : '') || process.env.COMPUTERNAME || hostname(),
      pairingCode: command.code,
    };
    if (!ticket && (!/^[A-Za-z0-9_-]{43}$/.test(pairing.pairingCode || '') || pairing.name.length > 80)) throw new Error('配对码或设备名称无效。');
    const old = await read();
    if (old && !command.replace) throw new Error('已有设备配对；更换服务器前请明确勾选替换现有配对。');
    const priorIntent = await control.read();
    const port = old?.bridgePort || await (deps.choosePort || chooseFreePort)(4317);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本机连接端口无效。');
    const result = await (deps.pair || pairConnector)({ ...pairing, bridgePort: port, configPath, replace: !!old });
    let warning = null;
    let completed = null;
    let recoveryCompleted = false;
    try {
      completed = await control.completePairing(priorIntent.revision, priorIntent.settingsRevision, { newPair: !old });
      if (!completed.superseded && !await control.mayRun(completed.intent.revision)) completed = { ...completed, superseded: true, intent: await control.read() };
      if (!completed.superseded) {
        if (old) await (deps.stopPrevious || (() => stopOwnedConnectorProcesses({ root: appRoot })))();
        await (deps.registerDeferred || registerDeferredConnectorLogin)({ root: appRoot, allowBootstrap: completed.intent.bootstrapPending ?? !old, registerStartup: false });
        if (control.finishBootstrapEnrollment) completed.intent = await control.finishBootstrapEnrollment(completed.intent.revision);
        if (control.finishStartupRegistration) completed.intent = await control.finishStartupRegistration(completed.intent.revision);
        const launched = await (deps.watch || launchConnectorLoginWatcher)({ root: appRoot });
        const current = await control.read();
        if (launched?.paused || current.paused || current.revision !== completed.intent.revision || !await control.mayRun(completed.intent.revision)) completed = { ...completed, superseded: true, intent: current };
        else recoveryCompleted = true;
      }
    } catch {
      warning = '设备已配对，但后台启动未完成。请勿重复使用此配对信息；打开连接器后检查状态并重试连接。';
    }
    const intent = completed?.intent || await control.read().catch(() => ({ paused: true, pauseScope: 'persistent' }));
    if (completed?.superseded) return { paired: true, ...result, autoStart: intent.autoStart === true, state: intent.paused ? 'paused' : 'waiting', paused: intent.paused, pauseScope: intent.pauseScope, persistentPaused: intent.pauseScope === 'persistent', recoveryCompleted: false };
    return { paired: true, ...result, autoStart: intent.autoStart === true, state: warning ? 'partial' : intent.paused ? 'paused' : 'waiting', paused: intent.paused, pauseScope: intent.pauseScope, persistentPaused: intent.pauseScope === 'persistent', recoveryCompleted, partialSuccess: !!warning, ...(warning ? { warning } : {}) };
  }
  if (command.action === 'connect') {
    const config = await read();
    if (!config) throw new Error('请先绑定这台电脑。');
    let intent = await control.resume(command.reason === 'startup' ? 'startup' : 'manual');
    if (intent.paused || (command.reason === 'startup' && !intent.autoStart)) return { paired: true, paused: intent.paused, pauseScope: intent.pauseScope, persistentPaused: intent.pauseScope === 'persistent', state: intent.paused ? 'paused' : 'waiting', recoveryCompleted: false };
    await (deps.registerDeferred || registerDeferredConnectorLogin)({ root: appRoot, ...(intent.bootstrapPending ? { allowBootstrap: true } : {}), registerStartup: false });
    if (control.finishBootstrapEnrollment) intent = await control.finishBootstrapEnrollment(intent.revision);
    if (control.finishStartupRegistration) intent = await control.finishStartupRegistration(intent.revision);
    if (!await control.mayRun(intent.revision)) return { paired: true, paused: true, pauseScope: (await control.read()).pauseScope, state: 'paused', recoveryCompleted: false };
    const launched = await (deps.watch || launchConnectorLoginWatcher)({ root: appRoot });
    const current = await control.read();
    if (launched?.paused || current.paused || current.revision !== intent.revision || !await control.mayRun(intent.revision)) return { paired: true, paused: current.paused, pauseScope: current.pauseScope, persistentPaused: current.pauseScope === 'persistent', state: current.paused ? 'paused' : 'waiting', recoveryCompleted: false };
    return { paired: true, state: 'connecting', recoveryCompleted: true };
  }
  throw new Error('连接程序命令无效。');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let text = '';
  for await (const chunk of process.stdin) { text += chunk; if (text.length > 8192) throw new Error('请求过大。'); }
  try { console.log(JSON.stringify({ ok: true, ...await guiCommand(JSON.parse(text)) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
}
