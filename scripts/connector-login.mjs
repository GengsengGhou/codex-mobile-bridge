import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { recoveryIdentity, writeRecoveryFile, readRecoveryFile } from '../src/recovery.mjs';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { probeLocalBridge, chooseFreePort, ensureLocalBridge, selectOrdinaryLocalThread } from './bootstrap-bridge.mjs';
import { startBridge, verifyBridge } from './start.mjs';
import { launchWindowsBridge } from './windows-launch.mjs';
import { hubOrigin, privateFile } from './setup-connector.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const executeFile = promisify(execFile);
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
const validPort = value => Number.isInteger(value) && value >= 1024 && value <= 65535;
async function savedConnector(root) {
  const config = JSON.parse(await readFile(resolve(root, '.local/hub-connector.json'), 'utf8'));
  if (config.version !== 1 || !validPort(config.bridgePort) || !/^[a-f0-9-]{36}$/i.test(config.deviceId || '') || !/^[A-Za-z0-9_-]{43}$/.test(config.deviceToken || '')) throw new Error('连接器保存配置无效，请重新运行安装步骤。');
  hubOrigin(config.hubOrigin);
  return config;
}

export function connectorLoginCommand(root) {
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolve(root, 'scripts/connector-login.ps1')}"`;
}

export async function registerConnectorLogonTask({ root = defaultRoot, execute = executeFile } = {}) {
  const name = `CodexMobileConnector-${recoveryIdentity(root)}`;
  const executable = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolve(root, 'scripts/connector-login.ps1')}"`;
  const script = `$ErrorActionPreference='Stop'
$service=New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder=$service.GetFolder('\\')
$name=${psLiteral(name)}
$executable=${psLiteral(executable)}
$arguments=${psLiteral(args)}
$existing=$null
try { $existing=$folder.GetTask($name) } catch { if ($_.Exception.HResult -ne -2147024894) { throw } }
if ($existing) {
  $actions=$existing.Definition.Actions
  if ($actions.Count -ne 1 -or $actions.Item(1).Path -cne $executable -or $actions.Item(1).Arguments -cne $arguments) { throw '登录任务已被其他命令占用，无法替换。' }
}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$task=$service.NewTask(0)
$task.RegistrationInfo.Description='Restore the saved Codex mobile bridge and connector after user logon.'
$task.Principal.UserId=$sid
$task.Principal.LogonType=3
$task.Principal.RunLevel=0
$task.Settings.Enabled=$true
$task.Settings.StartWhenAvailable=$true
$task.Settings.DisallowStartIfOnBatteries=$false
$task.Settings.StopIfGoingOnBatteries=$false
$task.Settings.ExecutionTimeLimit='PT0S'
$task.Settings.MultipleInstances=2
$trigger=$task.Triggers.Create(9)
$trigger.UserId=$sid
$trigger.Delay='PT10S'
$action=$task.Actions.Create(0)
$action.Path=$executable
$action.Arguments=$arguments
$action.WorkingDirectory=${psLiteral(resolve(root))}
$registered=$folder.RegisterTaskDefinition($name,$task,6,$sid,$null,3,$null)
@{ enabled=[bool]$registered.Enabled; name=$name } | ConvertTo-Json -Compress`;
  const result = await execute(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
  const applied = JSON.parse(result.stdout.trim());
  if (!applied.enabled) throw new Error('Windows 登录恢复任务未生效。');
  return applied;
}

export function createConnectorLoginRegistration({ root = defaultRoot, execute = executeFile, registryKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' } = {}) {
  const name = `CodexMobileConnector-${recoveryIdentity(root)}`, command = connectorLoginCommand(root);
  async function invoke(enable) {
    if (enable && command.length > 260) throw new Error('登录启动命令过长，请将安装目录放到更短的路径后重试。');
    const script = `$ErrorActionPreference='Stop'
$key=${psLiteral(registryKey)}
$name=${psLiteral(name)}
$expected=${psLiteral(command)}
function Read-Registration {
  if (-not (Test-Path -LiteralPath $key -ErrorAction Stop)) { return $null }
  $properties=Get-ItemProperty -LiteralPath $key -ErrorAction Stop
  return $properties.PSObject.Properties[$name].Value
}
$current=Read-Registration
${enable ? `if ($current -and $current -cne $expected) { throw '登录启动项已被其他命令占用，无法替换。' }
if (-not (Test-Path -LiteralPath $key -ErrorAction Stop)) { New-Item -Path $key -ErrorAction Stop | Out-Null }
Set-ItemProperty -LiteralPath $key -Name $name -Value $expected
$current=Read-Registration` : ''}
@{ enabled=($current -ceq $expected); conflict=([bool]$current -and $current -cne $expected) } | ConvertTo-Json -Compress`;
    const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    return JSON.parse(result.stdout.trim());
  }
  return { name, command, read: () => invoke(false), enable: () => invoke(true), ensureLogonTask: () => registerConnectorLogonTask({ root, execute }) };
}

export async function registerConnectorLogin({ root = defaultRoot, nodePath = process.execPath, platform = process.platform, registration, probe = probeLocalBridge } = {}) {
  if (platform !== 'win32') throw new Error('连接器登录启动仅支持 Windows。');
  root = resolve(root); nodePath = resolve(nodePath);
  const config = await savedConnector(root);
  await access(nodePath); await access(resolve(root, 'scripts/connector-login.ps1'));
  const startup = registration || createConnectorLoginRegistration({ root });
  const current = await startup.read();
  if (current.conflict) throw new Error('登录启动项已被其他命令占用，无法替换。');
  const runtimePath = resolve(root, '.local/runtime.json');
  try { await readFile(runtimePath); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const status = await probe(config.bridgePort);
    if (!status || !['single', 'all-local', 'disabled'].includes(status.sendScope)) throw new Error('未找到可保存的已验证桥接配置，尚未启用登录启动。');
    await loadRuntimeConfig({ configPath: runtimePath, env: { CODEX_THREAD_ID: status.callerThreadId, BRIDGE_SEND_THREAD_ID: status.allowedSendThreadId || status.callerThreadId, BRIDGE_ENABLE_SEND: status.sendScope === 'disabled' ? '0' : '1', BRIDGE_SEND_SCOPE: status.sendScope === 'disabled' ? 'single' : status.sendScope, BRIDGE_PORT: String(config.bridgePort) } });
  }
  const runtime = await loadRuntimeConfig({ configPath: runtimePath, env: {} });
  if (runtime.port !== config.bridgePort) throw new Error('保存的桥接端口和连接器端口不同，尚未启用登录启动。');
  await writeRecoveryFile(resolve(root, '.local/connector-login.json'), { version: 1, nodePath });
  await privateFile(resolve(root, '.local/connector-login.json'));
  const applied = await startup.enable();
  if (!applied.enabled || applied.conflict) throw new Error('Windows 登录启动未生效，请检查当前用户权限。');
  if (startup.ensureLogonTask) await startup.ensureLogonTask();
  return { enabled: true, name: startup.name, script: resolve(root, 'scripts/connector-login.ps1') };
}

export async function registerDeferredConnectorLogin({ root = defaultRoot, nodePath = process.execPath, platform = process.platform, registration, allowBootstrap = false } = {}) {
  if (platform !== 'win32') throw new Error('连接器登录启动仅支持 Windows。');
  root = resolve(root); nodePath = resolve(nodePath);
  const config = await savedConnector(root); await access(nodePath); await access(resolve(root, 'scripts/connector-login.ps1'));
  let pendingBootstrap = false;
  try {
    await readFile(resolve(root, '.local/runtime.json'));
    const runtime = await loadRuntimeConfig({ configPath: resolve(root, '.local/runtime.json'), env: {} });
    if (runtime.port !== config.bridgePort) throw new Error('保存的桥接端口和连接器端口不同。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const saved = await readRecoveryFile(resolve(root, '.local/connector-login.json'), {});
    const authorized = saved.version === 1 && saved.bootstrap === true && typeof saved.nodePath === 'string' && resolve(saved.nodePath) === nodePath;
    if (!allowBootstrap && !authorized) throw new Error('未保存首次桥接身份，请重新运行安装。');
    pendingBootstrap = true;
  }
  const startup = registration || createConnectorLoginRegistration({ root });
  const current = await startup.read();
  if (current.conflict) throw new Error('登录启动项已被其他命令占用，无法替换。');
  // This marker permits first bootstrap at a later logon without selecting a task in the GUI.
  await writeRecoveryFile(resolve(root, '.local/connector-login.json'), { version: 1, nodePath, ...(pendingBootstrap ? { bootstrap: true } : {}) });
  await privateFile(resolve(root, '.local/connector-login.json'));
  const applied = await startup.enable();
  if (!applied.enabled || applied.conflict) throw new Error('Windows 登录启动未生效，请检查当前用户权限。');
  if (startup.ensureLogonTask) await startup.ensureLogonTask();
  return { enabled: true, name: startup.name, pendingBootstrap };
}

export async function launchConnectorLoginWatcher({ root = defaultRoot, launch = launchWindowsBridge } = {}) {
  root = resolve(root);
  return launch({ root, nodePath: process.execPath, supervisorPath: resolve(root, 'scripts/connector-login.mjs'), env: {}, instanceName: 'connector-login', logName: 'connector-login' });
}

export async function restoreConnectorLogin({ root = defaultRoot, ensureBridge, bootstrap = ensureLocalBridge, finishBootstrap = registerConnectorLogin, probe = probeLocalBridge, verify = verifyBridge, start = startBridge, choosePort = chooseFreePort, launch = launchWindowsBridge, sleep = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms)), signal, output = console, monitor = false, now = Date.now, readState = readRecoveryFile } = {}) {
  root = resolve(root);
  const config = await savedConnector(root);
  const runtimePath = resolve(root, '.local/runtime.json');
  const loginSettings = await readRecoveryFile(resolve(root, '.local/connector-login.json'), {});
  let pendingBootstrap = loginSettings.version === 1 && loginSettings.bootstrap === true && typeof loginSettings.nodePath === 'string' && resolve(loginSettings.nodePath) === resolve(process.execPath);
  let runtime;
  try { await readFile(runtimePath); runtime = await loadRuntimeConfig({ configPath: runtimePath, env: {} }); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!pendingBootstrap) throw new Error('未保存首次桥接身份，请重新运行安装。');
  }
  if (runtime && runtime.port !== config.bridgePort) throw new Error('保存的桥接端口和连接器端口不同，请重新运行安装。');
  let announced = false, bridgeStarted = false;
  while (!signal?.aborted) {
    let bridge;
    try {
      if (!runtime) {
        // Failed first attempts may already have written a verified identity; reuse it.
        try { await readFile(runtimePath); runtime = await loadRuntimeConfig({ configPath: runtimePath, env: {} }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!runtime) {
          const existing = await probe(config.bridgePort);
          if (!existing && await choosePort(config.bridgePort) !== config.bridgePort) throw new Error('桥接端口已被其他程序占用。');
          const ready = existing ? { connected: true, port: config.bridgePort } : await bootstrap({ root, port: config.bridgePort, selectThread: selectOrdinaryLocalThread });
          if (!ready?.connected || ready.port !== config.bridgePort) throw new Error('正在等待首次 Codex 连接。');
          await finishBootstrap({ root, probe });
          pendingBootstrap = false;
          runtime = await loadRuntimeConfig({ configPath: runtimePath, env: {} });
        }
        if (runtime.port !== config.bridgePort) throw new Error('保存的桥接端口和连接器端口不同。');
      }
      if (pendingBootstrap) { await finishBootstrap({ root, probe }); pendingBootstrap = false; }
      if (ensureBridge) bridge = await ensureBridge({ root, port: config.bridgePort, selectThread: async () => { throw new Error('登录启动不进行首次会话选择。'); } });
      else {
        let status = await probe(config.bridgePort);
        if (!status) {
          // A saved bridge may start before Codex; an unknown listener is never replaced.
          if (!await verify(`http://127.0.0.1:${config.bridgePort}`) && await choosePort(config.bridgePort) !== config.bridgePort) throw new Error('保存的桥接端口被其他程序占用，等待其恢复。');
          const result = await start({ root, loadConfig: async () => runtime, output: { log() {}, error() {} } });
          bridgeStarted ||= result.started;
          status = await probe(config.bridgePort);
        }
        bridge = { port: config.bridgePort, connected: !!status, started: bridgeStarted };
      }
      if (!bridge?.connected || bridge.port !== config.bridgePort) throw new Error('本机桥接尚未连接 Codex。');
    } catch {
      if (!announced) { output.log('正在等待 Codex 和已保存的本机桥接，连接器尚未启动。'); announced = true; }
      await sleep(10000); continue;
    }
    if (signal?.aborted) return { submitted: false, cancelled: true };
    try {
      const state = monitor ? await readState(resolve(root, '.local/hub-connector-state.json'), {}) : {};
      const age = now() - Date.parse(state.updatedAt);
      if (monitor && Number.isFinite(age) && age >= 0 && age < 6000 && state.state !== 'stopped') {
        await sleep(10000); continue;
      }
      const launched = await launch({ root, nodePath: process.execPath, supervisorPath: resolve(root, 'scripts/start-connector.mjs'), env: {}, instanceName: 'hub-connector', logName: 'hub-connector' });
      if (!monitor) return { submitted: true, bridgePort: bridge.port, bridgeStarted: bridge.started, pid: launched.pid };
      output.log(`已提交连接器启动（PID ${launched.pid}）；继续监测自动恢复。`);
    } catch {
      if (!monitor) throw new Error('连接器后台启动失败，请检查启动日志。');
      output.log('连接器启动暂时失败，稍后自动重试。');
    }
    await sleep(10000);
  }
  return { submitted: false, cancelled: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.includes('--register')) { const result = await registerConnectorLogin(); console.log(`已启用当前用户登录启动：${result.name}`); }
    else if (process.argv.includes('--background')) {
      const result = await launchConnectorLoginWatcher();
      console.log(`已提交登录恢复监测（PID ${result.pid}）。`);
    }
    else { await restoreConnectorLogin({ monitor: true }); }
  } catch { console.error('连接器登录恢复失败，请检查已保存的配置和本机 Node.js。'); process.exitCode = 1; }
}
