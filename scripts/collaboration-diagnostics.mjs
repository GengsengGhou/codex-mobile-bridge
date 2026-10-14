import { readFile, lstat } from 'node:fs/promises';
import { resolve, join, dirname, basename, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
const serverName = 'codex_mobile_computer_collaboration';
const comparable = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const pathEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && isAbsolute(a) && isAbsolute(b) && comparable(a) === comparable(b);
const hash = text => createHash('sha256').update(text).digest('hex');
const safePath = (value, suffix) => typeof value === 'string' && isAbsolute(value) && !/[\r\n"<>|]/.test(value) && value.toLowerCase().endsWith(suffix) ? value : null;
async function text(path) {
  for (let parent = resolve(path);; parent = dirname(parent)) {
    try { if ((await lstat(parent)).isSymbolicLink()) return { status: 'linked' }; }
    catch (error) { if (error.code !== 'ENOENT') return { status: 'unreadable' }; }
    if (dirname(parent) === parent) break;
  }
  try { const bytes = await readFile(path); return bytes.length > 2 * 1024 * 1024 ? { status: 'oversized' } : { status: 'ok', value: bytes.toString('utf8'), sha256: hash(bytes) }; }
  catch (error) { return { status: error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
}
async function json(path) {
  const value = await text(path); if (value.status !== 'ok') return value;
  try { return { status: 'ok', value: JSON.parse(value.value) }; } catch { return { status: 'invalid-json' }; }
}
async function ordinaryFileStatus(path) {
  for (let parent = resolve(path);; parent = dirname(parent)) {
    try { const info = await lstat(parent); if (info.isSymbolicLink()) return 'linked'; if (parent === resolve(path) && !info.isFile()) return 'not-file'; }
    catch (error) { return error.code === 'ENOENT' ? 'absent' : 'unreadable'; }
    if (dirname(parent) === parent) return 'ok';
  }
}
export async function readCollaborationDiagnostics({ root, configPath = join(root, '.local/hub-connector.json') } = {}) {
  root = resolve(root);
  const paths = { pairing: resolve(configPath), mcpPairing: join(root, '.local/hub-connector.json'), policy: join(root, '.local/computer-collaboration.json'), registrationState: join(root, '.local/collaboration-registration-state.json'), connectorControl: join(root, '.local/connector-control.json'), upgradeJournal: root + '.upgrade-journal.json' };
  const [pairing, policy, state, control] = await Promise.all([json(paths.pairing), json(paths.policy), json(paths.registrationState), json(paths.connectorControl)]);
  const upgradeStatus = await ordinaryFileStatus(paths.upgradeJournal);
  const both = pairing.status === 'ok' && policy.status === 'ok';
  const hubOriginMatches = both ? pairing.value?.hubOrigin === policy.value?.hubOrigin : null;
  const deviceIdMatches = both ? pairing.value?.deviceId === policy.value?.deviceId : null;
  const requiresAuthorization = policy.value?.requiresAuthorization === true || both && (!hubOriginMatches || !deviceIdMatches);
  const validPolicy = both && policy.value?.version === 1 && hubOriginMatches && deviceIdMatches && Array.isArray(policy.value?.allowedDeviceIds) && Array.isArray(policy.value?.allowedProjectRoots);
  const hashes = {};
  for (const path of ['scripts/collaboration-mcp.mjs', 'scripts/collaboration-registration.mjs', 'scripts/collaboration-settings.mjs', 'scripts/setup-connector.mjs', 'deploy/windows/ui/connector.js']) {
    const source = await text(join(root, path));
    hashes[path] = { readStatus: source.status, sha256: source.sha256 || null };
  }
  const knownCodes = ['MCP_CONFIG_CHANGED', 'MCP_CONFIG_INVALID', 'MCP_CONFIG_UNSAFE', 'MCP_REGISTRATION_CONFLICT', 'MCP_REGISTRATION_RECOVERY_REQUIRED', 'MCP_REGISTRATION_ROOT_MISMATCH', 'MCP_REGISTRATION_UNAVAILABLE', 'COLLABORATION_REGISTRATION_FAILED'];
  const controlValid = control.status === 'absent' || control.status === 'ok' && (control.value?.version === 1 && typeof control.value.paused === 'boolean' && typeof control.value.autoStart === 'boolean' && typeof control.value.revision === 'string' && (!control.value.paused || typeof control.value.pausedSession === 'string') || control.value?.version === 2 && typeof control.value.paused === 'boolean' && ['none', 'session', 'persistent'].includes(control.value.pauseScope) && (typeof control.value.pausedSession === 'string' || control.value.pausedSession === null) && typeof control.value.autoStart === 'boolean' && typeof control.value.autoStartSelected === 'boolean' && typeof control.value.revision === 'string' && typeof control.value.settingsRevision === 'string' && typeof control.value.disconnectVerified === 'boolean' && (control.value.startupPending === undefined || typeof control.value.startupPending === 'boolean') && (control.value.bootstrapPending === undefined || typeof control.value.bootstrapPending === 'boolean') && (control.value.paused ? control.value.pauseScope !== 'none' : control.value.pauseScope === 'none') && (control.value.pauseScope !== 'session' || typeof control.value.pausedSession === 'string'));
  return { readOnly: true, sampledAt: new Date().toISOString(), paths, readStatus: { pairing: pairing.status, policy: policy.status, registrationState: state.status, connectorControl: control.status, upgradeJournal: upgradeStatus }, configPathMatchesMcpPath: pathEqual(paths.pairing, paths.mcpPairing), binding: { bothPresent: both, hubOriginMatches, deviceIdMatches, credentialShapeValid: pairing.status === 'ok' ? /^[A-Za-z0-9_-]{43}$/.test(pairing.value?.deviceToken || '') : null }, savedPolicy: { requiresAuthorization: policy.value?.requiresAuthorization === true, controlPending: policy.value?.controlPending === true, controlEnabled: policy.value?.controlEnabled === true, receiveEnabled: policy.value?.receiveEnabled === true }, effectivePolicy: { valid: validPolicy, requiresAuthorization: !!requiresAuthorization, controlEnabled: !!(validPolicy && !requiresAuthorization && !policy.value?.controlPending && policy.value?.controlEnabled), receiveEnabled: !!(validPolicy && !requiresAuthorization && policy.value?.receiveEnabled) }, registrationState: { status: ['disabled', 'ready', 'error', 'recovering', 'authorization-required', 'registered', 'preserved'].includes(state.value?.status) ? state.value.status : state.status === 'ok' ? 'other' : null, code: knownCodes.includes(state.value?.code) ? state.value.code : state.value?.code ? 'OTHER' : null }, connectorControl: { valid: !!controlValid, paused: control.status === 'absent' ? false : typeof control.value?.paused === 'boolean' ? control.value.paused : null, pauseScope: ['none', 'session', 'persistent'].includes(control.value?.pauseScope) ? control.value.pauseScope : control.value?.version === 1 ? control.value.paused ? 'session' : 'none' : null, mayRun: controlValid ? control.value?.paused !== true : false }, upgradeJournalPresent: upgradeStatus !== 'absent', moduleHashes: hashes, existingCodexTransport: 'unknown' };
}
function withoutRegistration(value) { const copy = structuredClone(value); if (copy.mcp_servers) { delete copy.mcp_servers[serverName]; if (!Object.keys(copy.mcp_servers).length) delete copy.mcp_servers; } return copy; }
function toolMetadata(tools) {
  const table = value => !!value && Object.getPrototypeOf(value) === Object.prototype;
  const entries = table(tools) ? Object.values(tools) : [];
  const fields = entries.filter(table).flatMap(value => Object.entries(value));
  return { present: tools !== undefined, tableShape: table(tools), fieldKeyNames: [...new Set(fields.map(([key]) => key))].sort(), fieldValueTypes: [...new Set(fields.map(([, value]) => Array.isArray(value) ? 'array' : typeof value))].sort(), officiallySupportedShape: table(tools) && entries.every(value => table(value) && Object.entries(value).every(([key, item]) => key === 'approval_mode' && ['auto', 'prompt', 'writes', 'approve'].includes(item) || key === 'output_token_limit' && Number.isSafeInteger(item) && item > 0)) };
}
// Keep the diagnostic executable independent: support copies frozen outside the
// installation rather than importing code from the potentially stale view.
function launcherDirectory(root) {
  const appData = process.env.LOCALAPPDATA && comparable(dirname(process.env.LOCALAPPDATA)), candidate = comparable(root);
  return appData && (candidate === appData || candidate.startsWith(appData + '\\')) ? join(homedir(), '.codex-mobile-bridge/launchers', hash(candidate).slice(0, 24)) : join(root, '.local/collaboration-launchers');
}
async function ownedCollaborationLaunch(root, entry) {
  if (!entry || !pathEqual(dirname(entry.command || ''), launcherDirectory(root)) || !/^CollaborationLauncher-[a-f0-9]{64}\.exe$/.test(basename(entry.command || '')) || !isDeepStrictEqual(entry.args, ['--install-root', resolve(root)])) return false;
  const [owner, executable] = await Promise.all([json(join(dirname(entry.command), 'owner.json')), text(entry.command)]);
  return owner.status === 'ok' && owner.value?.version === 1 && owner.value?.application === 'codex-mobile-bridge' && pathEqual(owner.value?.root, root) && executable.status === 'ok' && executable.sha256 === basename(entry.command).slice(22, -4);
}
async function readCollaborationLaunch(root) {
  const manifest = await json(join(root, '.local/collaboration-launcher.json'));
  if (manifest.status !== 'ok' || manifest.value?.version !== 1 || !pathEqual(manifest.value?.root, root) || !/^[a-f0-9]{64}$/.test(manifest.value?.sha256 || '')) return null;
  const entry = { command: manifest.value.command, args: ['--install-root', resolve(root)] };
  return pathEqual(entry.command, join(launcherDirectory(root), `CollaborationLauncher-${manifest.value.sha256}.exe`)) && await ownedCollaborationLaunch(root, entry) ? entry : null;
}
function sameOwnedLaunchWithPreferences(current, ledgerEntry) {
  const supported = Object.entries(current).every(([key, value]) => ['command', 'args'].includes(key) || key === 'tools' && toolMetadata(value).officiallySupportedShape || key === 'enabled' && typeof value === 'boolean' || ['startup_timeout_sec', 'tool_timeout_sec'].includes(key) && Number.isFinite(value) && value > 0 || ['enabled_tools', 'disabled_tools'].includes(key) && Array.isArray(value) && value.every(name => typeof name === 'string' && name.length > 0));
  return supported && isDeepStrictEqual(current.command, ledgerEntry.command) && isDeepStrictEqual(current.args, ledgerEntry.args);
}
export async function diagnoseRegistration({ root, codexConfig } = {}) {
  if (typeof root !== 'string' || typeof codexConfig !== 'string' || !isAbsolute(root) || !isAbsolute(codexConfig) || /^(?:\\\\|\/\/)/.test(root) || /^(?:\\\\|\/\/)/.test(codexConfig)) throw new Error('Explicit ordinary local absolute paths are required.');
  root = resolve(root); codexConfig = resolve(codexConfig);
  const paths = { pairing: join(root, '.local/hub-connector.json'), policy: join(root, '.local/computer-collaboration.json'), ledger: join(root, '.local/collaboration-registration.json'), entryScript: join(root, 'scripts/collaboration-mcp.mjs') };
  const [packageInfo, pairing, policy, ledger, source] = await Promise.all([json(join(root, 'package.json')), json(paths.pairing), json(paths.policy), json(paths.ledger), text(codexConfig)]);
  const result = { readOnly: true, networkRequests: 0, writes: 0, paths: { installRoot: root, codexConfig, ...paths }, packageVersion: /^\d+\.\d+\.\d+$/.test(packageInfo.value?.version || '') ? packageInfo.value.version : null, readStatus: { package: packageInfo.status, pairing: pairing.status, policy: policy.status, ledger: ledger.status, codexConfig: source.status }, pairingAndPolicy: { bothPresent: pairing.status === 'ok' && policy.status === 'ok', hubOriginMatches: pairing.status === 'ok' && policy.status === 'ok' ? pairing.value?.hubOrigin === policy.value?.hubOrigin : null, deviceIdMatches: pairing.status === 'ok' && policy.status === 'ok' ? pairing.value?.deviceId === policy.value?.deviceId : null, credentialShapeValid: pairing.status === 'ok' ? /^[A-Za-z0-9_-]{43}$/.test(pairing.value?.deviceToken || '') : null, requiresAuthorization: policy.value?.requiresAuthorization === true, controlPending: policy.value?.controlPending === true, controlEnabled: policy.value?.controlEnabled === true, receiveEnabled: policy.value?.receiveEnabled === true } };
  let TOML;
  try { TOML = createRequire(join(root, 'package.json'))('@iarna/toml'); }
  catch { result.registration = { parserAvailable: false, status: 'parser-unavailable' }; return result; }
  let parsed;
  try { if (source.status === 'ok') parsed = TOML.parse(source.value); }
  catch { result.registration = { parserAvailable: true, status: 'invalid-toml' }; return result; }
  const entry = parsed?.mcp_servers?.[serverName], saved = ledger.value;
  let block, blockValid = false;
  try { if (typeof saved?.block === 'string') { block = TOML.parse(saved.block); blockValid = !!block.mcp_servers?.[serverName] && !Object.keys(withoutRegistration(block)).length; } } catch {}
  const ledgerChecks = { schema: saved?.version === 1, configPathExactMatch: saved?.configPath === codexConfig, configPathSameWindowsPath: pathEqual(saved?.configPath, codexConfig), blockHashMatches: typeof saved?.block === 'string' && hash(saved.block) === saved.blockHash, blockContainsOnlyOwnedEntry: blockValid, blockEntryMatchesLedger: blockValid && isDeepStrictEqual(block.mcp_servers[serverName], saved?.entry) };
  const valid = ledger.status === 'ok' && ledgerChecks.schema && ledgerChecks.configPathExactMatch && ledgerChecks.blockHashMatches && ledgerChecks.blockContainsOnlyOwnedEntry && ledgerChecks.blockEntryMatchesLedger;
  const keys = entry && saved?.entry ? [...new Set([...Object.keys(entry), ...Object.keys(saved.entry)])].sort() : [];
  const changedKeys = keys.filter(key => !isDeepStrictEqual(entry[key], saved.entry[key]));
  const owned = valid && !!entry && isDeepStrictEqual(entry, saved.entry);
  const toolSettings = toolMetadata(entry?.tools), core = entry ? { ...entry } : null; if (core) delete core.tools;
  const ownedCoreWithTools = valid && !!entry && Object.hasOwn(entry, 'tools') && !Object.hasOwn(saved.entry, 'tools') && toolSettings.officiallySupportedShape && isDeepStrictEqual(core, saved.entry);
  const scriptPath = Array.isArray(entry?.args) && typeof entry.args[0] === 'string' && basename(entry.args[0]) === 'collaboration-mcp.mjs' ? safePath(entry.args[0], '.mjs') : null;
  let nativeLaunch = false; try { nativeLaunch = await ownedCollaborationLaunch(root, entry); } catch {}
  const ownedPreferences = valid && nativeLaunch && sameOwnedLaunchWithPreferences(entry, saved.entry);
  result.registration = {
    parserAvailable: true, sameNameEntryPresent: !!entry, ledgerPresent: ledger.status !== 'absent', ledgerValid: valid && !saved?.pending, ledgerPending: saved?.pending === true, ledgerChecks,
    ledgerCodexConfigPath: safePath(saved?.configPath, '.toml'), registeredCommandPath: safePath(entry?.command, '.exe'), registeredScriptPath: scriptPath,
    argumentCount: Array.isArray(entry?.args) ? entry.args.length : null,
    commandMatchesLedger: entry && saved?.entry ? isDeepStrictEqual(entry.command, saved.entry.command) : null,
    argsMatchLedger: entry && saved?.entry ? isDeepStrictEqual(entry.args, saved.entry.args) : null,
    commandSameWindowsPathAsLedger: entry && saved?.entry ? pathEqual(entry.command, saved.entry.command) : null,
    scriptBelongsToInstallRoot: nativeLaunch || Array.isArray(entry?.args) && entry.args.length === 1 && pathEqual(scriptPath, paths.entryScript),
    sharedStateLauncher: nativeLaunch,
    currentEntryExactlyOwned: owned,
    currentEntryCoreOwnedWithSupportedTools: ownedCoreWithTools, toolSettings,
    currentEntryCoreOwnedWithSupportedPreferences: ownedPreferences,
    changedKeyNames: changedKeys, extraKeyNames: entry && saved?.entry ? Object.keys(entry).filter(key => !Object.hasOwn(saved.entry, key)).sort() : [],
    missingKeyNames: entry && saved?.entry ? Object.keys(saved.entry).filter(key => !Object.hasOwn(entry, key)).sort() : [],
    enabledOption: typeof entry?.enabled === 'boolean' ? entry.enabled : null,
    containsEnvOption: !!entry && Object.hasOwn(entry, 'env'),
    status: saved?.pending ? 'pending-recovery' : ledger.status !== 'absent' && !valid ? 'ownership-recovery-required' : entry && !(owned || ownedCoreWithTools || ownedPreferences) ? 'registration-conflict' : (owned || ownedCoreWithTools || ownedPreferences) && !(nativeLaunch || Array.isArray(entry.args) && entry.args.length === 1 && pathEqual(scriptPath, paths.entryScript)) ? 'owned-other-installation' : ownedCoreWithTools ? 'owned-core-with-supported-tools' : owned || ownedPreferences ? 'owned-current-installation' : 'no-same-name-entry',
  };
  return result;
}
export async function probeCollaborationStdio({ command, script, args = [script], root, timeoutMs = 5000 } = {}) {
  const result = { probeKind: 'new-isolated-stdio-client', existingCodexTransport: 'unknown', networkRequests: 0, toolCalls: 0, initialize: false, toolsList: false, toolCount: null, delayedPing: false, exitedBeforeDelayedPing: false, exitCode: null, stdoutProtocolValid: true, stderrPresent: false };
  const environment = { ...process.env }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
  result.nodeStartupOverridesRemoved = { nodeOptions: !!process.env.NODE_OPTIONS, nodePath: !!process.env.NODE_PATH };
  const child = spawn(command, args, { cwd: root, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map(); let nextId = 0, bytes = 0, closed = false;
  child.stdin.on('error', () => {});
  child.stderr.on('data', () => { result.stderrPresent = true; });
  child.once('error', () => { result.spawnFailed = true; });
  child.once('exit', code => { closed = true; result.exitCode = code; });
  lines.on('line', line => {
    bytes += Buffer.byteLength(line);
    if (bytes > 512 * 1024) { result.stdoutProtocolValid = false; child.kill(); return; }
    try { const value = JSON.parse(line); if (value.jsonrpc !== '2.0') throw new Error(); const reply = pending.get(value.id); if (reply) { pending.delete(value.id); reply(value); } }
    catch { result.stdoutProtocolValid = false; }
  });
  const rpc = (method, params) => new Promise(resolveReply => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); resolveReply(null); }, timeoutMs);
    pending.set(id, value => { clearTimeout(timer); resolveReply(value); });
    if (!closed && !child.stdin.destroyed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const exited = new Promise(resolveExit => child.once('close', resolveExit));
  try {
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'collaboration-read-only-diagnostic', version: '1' } });
    result.initialize = !!initialized?.result?.serverInfo;
    if (result.initialize) {
      result.serverVersion = /^\d+\.\d+\.\d+$/.test(initialized.result.serverInfo.version || '') ? initialized.result.serverInfo.version : null;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const listed = await rpc('tools/list'); result.toolsList = Array.isArray(listed?.result?.tools); result.toolCount = result.toolsList ? listed.result.tools.length : null;
      await new Promise(done => setTimeout(done, 1400));
      result.exitedBeforeDelayedPing = closed;
      if (!closed) result.delayedPing = !!(await rpc('ping'))?.result;
    }
  } finally {
    lines.close(); child.stdin.end(); if (!closed) child.kill(); await exited;
  }
  return result;
}
export async function diagnoseCollaboration({ root, codexConfig, projectConfig } = {}) {
  const global = await diagnoseRegistration({ root, codexConfig });
  const result = { ...global, collaboration: await readCollaborationDiagnostics({ root }), configuration: { globalConfig: resolve(codexConfig), projectConfig: projectConfig ? resolve(projectConfig) : null, projectTrust: 'not-inspected', selectedSource: 'global', projectSameNameEntryPresent: null, codexHomeEnvironmentPresent: !!process.env.CODEX_HOME, existingSessionConfiguration: 'unknown' } };
  let parser; try { parser = createRequire(join(root, 'package.json'))('@iarna/toml'); } catch {}
  let entry;
  try { const source = await text(codexConfig); if (source.status === 'ok' && parser) entry = parser.parse(source.value)?.mcp_servers?.[serverName]; } catch {}
  if (projectConfig) {
    if (!isAbsolute(projectConfig) || /^(?:\\\\|\/\/)/.test(projectConfig)) throw new Error('Invalid project path');
    const source = await text(projectConfig); result.configuration.projectReadStatus = source.status;
    try {
      if (source.status === 'ok' && parser) {
        const projectEntry = parser.parse(source.value)?.mcp_servers?.[serverName]; result.configuration.projectSameNameEntryPresent = !!projectEntry;
        if (projectEntry) { entry = projectEntry; result.configuration.selectedSource = 'project-candidate-requires-trust'; }
      }
    } catch { result.configuration.projectReadStatus = 'invalid-toml'; }
  }
  let nativeLaunch; try { nativeLaunch = await readCollaborationLaunch(resolve(root)); } catch {}
  const expectedCommand = nativeLaunch?.command || join(resolve(root), 'runtime/node.exe'), expectedScript = join(resolve(root), 'scripts/collaboration-mcp.mjs');
  const expectedArgs = nativeLaunch?.args || [expectedScript], argsMatch = isDeepStrictEqual(entry?.args, expectedArgs);
  result.launch = { commandPath: safePath(entry?.command, '.exe'), scriptPath: nativeLaunch && argsMatch ? expectedScript : Array.isArray(entry?.args) ? safePath(entry.args[0], '.mjs') : null, sharedStateLauncher: !!nativeLaunch && pathEqual(entry?.command, expectedCommand) && argsMatch, argumentCount: Array.isArray(entry?.args) ? entry.args.length : null, optionKeyNames: entry ? Object.keys(entry).sort() : [], commandBelongsToInstallRoot: pathEqual(entry?.command, expectedCommand), scriptBelongsToInstallRoot: argsMatch, envOptionPresent: !!entry && Object.hasOwn(entry, 'env'), envVarsOptionPresent: !!entry && Object.hasOwn(entry, 'env_vars'), cwdOptionPresent: !!entry && Object.hasOwn(entry, 'cwd'), enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : null };
  const extraOptions = entry && Object.keys(entry).some(key => !(nativeLaunch ? ['command', 'args', 'enabled', 'tools', 'startup_timeout_sec', 'tool_timeout_sec', 'enabled_tools', 'disabled_tools'] : ['command', 'args', 'enabled', 'tools']).includes(key));
  const commandStatus = { status: await ordinaryFileStatus(expectedCommand) }, scriptStatus = { status: await ordinaryFileStatus(expectedScript) };
  // Never execute shell wrappers, Node flags, alternate scripts, env/cwd overrides,
  // or a candidate project registration whose ownership has not been established.
  const allowed = result.configuration.selectedSource === 'global' && global.registration?.ledgerValid && (global.registration.currentEntryExactlyOwned || global.registration.currentEntryCoreOwnedWithSupportedTools || global.registration.currentEntryCoreOwnedWithSupportedPreferences) && result.launch.commandBelongsToInstallRoot && result.launch.scriptBelongsToInstallRoot && !extraOptions && entry.enabled !== false && commandStatus.status === 'ok' && scriptStatus.status === 'ok';
  result.stdio = allowed ? await probeCollaborationStdio({ command: expectedCommand, args: expectedArgs, root: resolve(root) }) : { attempted: false, reason: 'UNVERIFIED_OR_NONSTANDARD_REGISTRATION', commandReadStatus: commandStatus.status, scriptReadStatus: scriptStatus.status, existingCodexTransport: 'unknown' };
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); if (![4, 6].includes(args.length) || args[0] !== '--install-root' || args[2] !== '--codex-config' || args.length === 6 && args[4] !== '--project-config') throw new Error('Invalid arguments');
    console.log(JSON.stringify(await diagnoseCollaboration({ root: args[1], codexConfig: args[3], projectConfig: args[5] }), null, 2));
  } catch { console.log(JSON.stringify({ readOnly: true, error: 'DIAGNOSTIC_INPUT_OR_READ_ERROR', instruction: 'Pass --install-root and --codex-config with confirmed absolute local paths; optionally --project-config for the failing task project. No underlying error text or private values are returned.' })); process.exitCode = 1; }
}
