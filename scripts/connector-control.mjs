import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { recoveryIdentity, writeRecoveryFile } from '../src/recovery.mjs';
import { privateFile } from './setup-connector.mjs';

const executeFile = promisify(execFile);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const localMutations = new Map();
async function powershell(script, execute = executeFile) {
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12000, maxBuffer: 65536 });
  return JSON.parse(result.stdout.trim());
}
let sessionPromise;
export function currentLogonSession() {
  if (process.platform !== 'win32') return Promise.resolve(`nonwindows-${process.pid}`);
  return sessionPromise ||= powershell(`$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class ConnectorToken {
 [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr h,int c,IntPtr b,int n,out int r);
 public static string Id(IntPtr token) { int n; GetTokenInformation(token,10,IntPtr.Zero,0,out n); IntPtr p=Marshal.AllocHGlobal(n); try { if(!GetTokenInformation(token,10,p,n,out n)) throw new Exception("Cannot read logon identity"); return Marshal.ReadInt64(p,8).ToString("X16"); } finally { Marshal.FreeHGlobal(p); } }
}
'@
[ConnectorToken]::Id([Security.Principal.WindowsIdentity]::GetCurrent().Token) | ConvertTo-Json -Compress`);
}
export async function readConnectorControl(root) {
  let value;
  try { value = JSON.parse(await readFile(resolve(root, '.local/connector-control.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { version: 2, paused: false, pauseScope: 'none', pausedSession: null, autoStart: false, autoStartSelected: false, startupPending: false, bootstrapPending: false, revision: 'absent', settingsRevision: 'absent', disconnectVerified: false }; throw new Error('连接意图文件无法读取；已禁止自动连接，请在窗口中明确重试连接。'); }
  if (value.version === 1 && typeof value.paused === 'boolean' && typeof value.autoStart === 'boolean' && typeof value.revision === 'string' && (!value.paused || typeof value.pausedSession === 'string')) {
    return { ...value, version: 2, pauseScope: value.paused ? 'session' : 'none', autoStartSelected: true, startupPending: false, bootstrapPending: false, settingsRevision: 'legacy' };
  }
  if (value.version !== 2 || typeof value.paused !== 'boolean' || !['none', 'session', 'persistent'].includes(value.pauseScope) || typeof value.pausedSession !== 'string' && value.pausedSession !== null || typeof value.autoStart !== 'boolean' || typeof value.autoStartSelected !== 'boolean' || typeof value.revision !== 'string' || typeof value.settingsRevision !== 'string' || typeof value.disconnectVerified !== 'boolean' || (value.startupPending !== undefined && typeof value.startupPending !== 'boolean') || (value.bootstrapPending !== undefined && typeof value.bootstrapPending !== 'boolean') || (value.paused ? value.pauseScope === 'none' : value.pauseScope !== 'none') || (value.pauseScope === 'session' && typeof value.pausedSession !== 'string')) throw new Error('连接意图文件损坏；已禁止自动连接，请在窗口中明确重试连接。');
  return { ...value, startupPending: value.startupPending === true, bootstrapPending: value.bootstrapPending === true };
}
export async function connectorMayRun(root, revision) {
  const value = await readConnectorControl(root);
  return !value.paused && (!revision || value.revision === revision);
}

// Only exact commands belonging to this installation may be migrated or removed.
export function createCompanionRegistration({ root, execute = executeFile, registryKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }) {
  root = resolve(root);
  const name = `CodexMobileCompanion-${recoveryIdentity(root)}`;
  const command = `"${resolve(root, 'CodexMobileConnector.exe')}" --tray`;
  const legacyName = `CodexMobileConnector-${recoveryIdentity(root)}`;
  const legacy = `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolve(root, 'scripts/connector-login.ps1')}"`;
  const taskArgs = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolve(root, 'scripts/connector-login.ps1')}"`;
  async function invoke(enable) {
    return powershell(`$ErrorActionPreference='Stop'
$key=${literal(registryKey)}; $name=${literal(name)}; $command=${literal(command)}
$legacyName=${literal(legacyName)}; $legacy=${literal(legacy)}; $oldGui=${literal(`"${resolve(root, 'CodexMobileConnector.exe')}"`)}
$properties=$null; if(Test-Path -LiteralPath $key){$properties=Get-ItemProperty -LiteralPath $key}
function Value($n){if($properties){return $properties.PSObject.Properties[$n].Value};return $null}
$current=Value $name
if($current -and $current -cne $command){throw '登录启动项已被其他程序占用。'}
$ownedLegacy=((Value $legacyName) -ceq $legacy); $ownedGui=((Value 'CodexMobileCompanion') -ceq $oldGui)
$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $folder=$service.GetFolder('\\'); $task=$null
try{$task=$folder.GetTask($legacyName)}catch{if($_.Exception.HResult -ne -2147024894){throw}}
function CurrentUserTask($principal) {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if($principal -ceq $sid){return $true}
  try{return (New-Object Security.Principal.NTAccount($principal)).Translate([Security.Principal.SecurityIdentifier]).Value -ceq $sid}catch{return $false}
}
$ownedTask=$false
if($task){$actions=$task.Definition.Actions; $ownedTask=($actions.Count -eq 1 -and $actions.Item(1).Path -ceq ${literal(resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'))} -and $actions.Item(1).Arguments -ceq ${literal(taskArgs)} -and (CurrentUserTask $task.Definition.Principal.UserId))}
$enabled=($current -ceq $command -or $ownedLegacy -or $ownedGui -or ($ownedTask -and $task.Enabled))
${enable === undefined ? '' : `if(-not(Test-Path -LiteralPath $key)){New-Item -Path $key|Out-Null}
if($ownedLegacy){Remove-ItemProperty -LiteralPath $key -Name $legacyName}
if($ownedGui){Remove-ItemProperty -LiteralPath $key -Name 'CodexMobileCompanion'}
if($ownedTask){$folder.DeleteTask($legacyName,0)}
${enable ? 'Set-ItemProperty -LiteralPath $key -Name $name -Value $command' : 'if($current -ceq $command){Remove-ItemProperty -LiteralPath $key -Name $name}'}
$properties=Get-ItemProperty -LiteralPath $key
$enabled=((Value $name) -ceq $command)
if($enabled -ne ${enable ? '$true' : '$false'}){throw '登录启动设置未生效。'}`}
@{enabled=[bool]$enabled}|ConvertTo-Json -Compress`, execute);
  }
  return { read: () => invoke(), set: enabled => invoke(enabled), name, command };
}
export async function stopOwnedConnectorProcesses({ root, nodePath = process.execPath, execute = executeFile }) {
  const scripts = ['connector-login.mjs', 'start-connector.mjs'].map(file => resolve(root, 'scripts', file));
  return powershell(`$ErrorActionPreference='Stop'
$node=${literal(resolve(nodePath))}; $watcher=${literal(scripts[0])}; $connector=${literal(scripts[1])}
function Owned($script){ @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ceq $node -and $_.CommandLine -and ($_.CommandLine -match ('(?i)(?:^|\\s)"'+[regex]::Escape($script)+'"(?:\\s|$)') -or $_.CommandLine -match ('(?i)(?:^|\\s)'+[regex]::Escape($script)+'(?:\\s|$)')) }) }
foreach($script in @($watcher,$connector)){foreach($p in (Owned $script)){Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop}}
for($i=0;$i -lt 10;$i++){if((Owned $watcher).Count -eq 0 -and (Owned $connector).Count -eq 0){@{stopped=$true}|ConvertTo-Json -Compress;exit};Start-Sleep -Milliseconds 100}
throw '无法确认连接器已停止；暂停意图已保存，请重试断开。'`, execute);
}
export function createConnectorControl({ root, registration, session = currentLogonSession, stop = stopOwnedConnectorProcesses } = {}) {
  const startup = registration || createCompanionRegistration({ root });
  const path = resolve(root, '.local/connector-control.json');
  const paired = async () => {
    try { await readFile(resolve(root, '.local/hub-connector.json')); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw new Error('配对配置无法读取；已禁止更改自动启动设置。'); }
  };
  async function mutate(operation) {
    if (process.platform !== 'win32') {
      const previous = localMutations.get(path) || Promise.resolve();
      const result = previous.catch(() => {}).then(operation); localMutations.set(path, result);
      return result;
    }
    // The kernel releases an abandoned mutex; closing stdin also releases it if Node crashes.
    const script = `$ErrorActionPreference='Stop'
$name='Global\\CodexMobileConnectorControl-${recoveryIdentity(root)}-'+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$mutex=New-Object Threading.Mutex($false,$name);$held=$false
try{try{$held=$mutex.WaitOne(5000)}catch [Threading.AbandonedMutexException]{$held=$true};if(-not $held){throw 'Connection intent is busy'};[Console]::Out.WriteLine('locked');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{if($held){$mutex.ReleaseMutex()};$mutex.Dispose()}`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    const exited = new Promise(resolveExit => child.once('close', resolveExit));
    let timeout;
    try {
      await new Promise((resolveLock, reject) => {
        timeout = setTimeout(() => reject(new Error('连接意图修改超时，请稍后重试。')), 10000);
        lines.once('line', line => line === 'locked' ? resolveLock() : reject(new Error('连接意图锁无效。')));
        child.once('error', reject);
        child.once('exit', () => reject(new Error('无法锁定连接意图，请稍后重试。')));
      });
      clearTimeout(timeout);
      return await operation();
    } finally { clearTimeout(timeout); lines.close(); child.stdin.end(); await exited; }
  }
  async function save(value) { await writeRecoveryFile(path, value); await privateFile(path); return value; }
  async function initialize() {
    return mutate(async () => {
      let value = await readConnectorControl(root);
      let changed = false;
      if (await paired()) {
        const registered = await startup.read();
        if (!value.autoStartSelected) {
          value = { ...value, autoStart: registered.enabled, autoStartSelected: true };
          changed = true;
        } else if (!value.startupPending && registered.enabled !== value.autoStart) {
          const applied = await startup.set(value.autoStart);
          if (applied.enabled !== value.autoStart) throw new Error('无法恢复 Windows 登录启动设置，请在设置中重试。');
        }
      }
      return !changed && value.revision !== 'absent' ? value : save({ ...value, version: 2, revision: value.revision === 'absent' ? randomUUID() : value.revision });
    });
  }
  return {
    read: () => readConnectorControl(root), initialize,
    mayRun: revision => connectorMayRun(root, revision),
    resume: reason => mutate(async () => {
      let value;
      try { value = await readConnectorControl(root); }
      catch (e) { if (reason === 'startup') throw e; value = { version: 2, paused: true, pauseScope: 'session', pausedSession: await session(), autoStart: false, autoStartSelected: false, revision: 'repair', settingsRevision: 'repair', disconnectVerified: false }; }
      const login = await session();
      if (reason === 'startup' && (!value.autoStart || value.pauseScope === 'persistent' || (value.pauseScope === 'session' && value.pausedSession === login))) return value;
      return save({ ...value, version: 2, paused: false, pauseScope: 'none', pausedSession: null, revision: randomUUID(), disconnectVerified: false, lastError: null });
    }),
    pause: async (scope = 'session') => {
      if (!['session', 'persistent'].includes(scope)) throw new Error('暂停范围无效。');
      const paused = await mutate(async () => {
        let value; try { value = await readConnectorControl(root); } catch { value = { version: 2, autoStart: false, autoStartSelected: false, settingsRevision: 'repair' }; }
        const effectiveScope = value.pauseScope === 'persistent' && scope === 'session' ? 'persistent' : scope;
        return save({ ...value, version: 2, autoStart: value.autoStart === true, autoStartSelected: value.autoStartSelected === true, paused: true, pauseScope: effectiveScope, pausedSession: effectiveScope === 'session' ? await session() : null, revision: randomUUID(), disconnectVerified: false, lastError: null });
      });
      let error;
      try { const result = await stop({ root }); if (!result.stopped) throw new Error('无法确认连接器已停止。'); } catch (e) { error = e; }
      const result = await mutate(async () => {
        const value = await readConnectorControl(root);
        if (value.revision !== paused.revision) return value;
        return save({ ...value, disconnectVerified: !error, lastError: error ? error.message : null });
      });
      if (error) throw error;
      return result;
    },
    configure: autoStart => mutate(async () => {
      if (typeof autoStart !== 'boolean') throw new Error('登录启动设置无效。');
      const value = await readConnectorControl(root);
      if (await paired()) {
        const applied = await startup.set(autoStart);
        if (applied.enabled !== autoStart) throw new Error('无法确认 Windows 登录启动设置，请重试。');
      }
      return save({ ...value, version: 2, autoStart, autoStartSelected: true, startupPending: false, settingsRevision: randomUUID() });
    }),
    completePairing: (expectedRevision, expectedSettingsRevision, { newPair = true } = {}) => mutate(async () => {
      const value = await readConnectorControl(root);
      if (value.revision !== expectedRevision) {
        let autoStart = value.autoStart;
        let autoStartSelected = value.autoStartSelected;
        if (value.settingsRevision === expectedSettingsRevision && !autoStartSelected) {
          autoStart = newPair ? true : (await startup.read()).enabled;
          autoStartSelected = true;
        }
        const intent = await save({ ...value, autoStart, autoStartSelected, startupPending: await paired(), bootstrapPending: newPair });
        return { superseded: true, intent };
      }
      let autoStart = value.autoStart;
      let autoStartSelected = value.autoStartSelected;
      if (value.settingsRevision === expectedSettingsRevision && !autoStartSelected) {
        autoStart = newPair ? true : (await startup.read()).enabled;
        autoStartSelected = true;
      }
      const isPaired = await paired();
      const intent = await save({ ...value, version: 2, autoStart, autoStartSelected, startupPending: isPaired, bootstrapPending: newPair, paused: false, pauseScope: 'none', pausedSession: null, revision: randomUUID(), disconnectVerified: false, lastError: null });
      if (isPaired) {
        const applied = await startup.set(autoStart);
        if (applied.enabled !== autoStart) throw new Error('无法确认 Windows 登录启动设置，请重试。');
      }
      const finalized = intent.startupPending ? await save({ ...intent, startupPending: false }) : intent;
      return { superseded: false, intent: finalized };
    }),
    finishStartupRegistration: expectedRevision => mutate(async () => {
      const value = await readConnectorControl(root);
      if (value.revision !== expectedRevision || value.paused || !value.startupPending) return value;
      if (await paired()) {
        const applied = await startup.set(value.autoStart);
        if (applied.enabled !== value.autoStart) throw new Error('无法确认 Windows 登录启动设置，请重试。');
      }
      const current = await readConnectorControl(root);
      return current.revision === value.revision && !current.paused ? save({ ...current, startupPending: false }) : current;
    }),
    finishBootstrapEnrollment: expectedRevision => mutate(async () => {
      const value = await readConnectorControl(root);
      if (value.revision !== expectedRevision || value.paused || !value.bootstrapPending) return value;
      return save({ ...value, bootstrapPending: false });
    })
  };
}
