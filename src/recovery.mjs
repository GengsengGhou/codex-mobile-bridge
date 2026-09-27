import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BridgeError } from './desktop.mjs';

export const RECOVERY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const recoveryIdentity = root => createHash('sha256').update(resolve(root).toLowerCase()).digest('hex').slice(0, 24);
export async function readRecoveryFile(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeRecoveryFile(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
export function startupCommand(root, nodePath = process.execPath) {
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${resolve(root, 'scripts/windows-startup.ps1')}" -NodePath "${nodePath}"`;
}
export function createWindowsRegistration({ root, nodePath = process.execPath, execute = promisify(execFile), registryKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }) {
  const name = `CodexMobileBridge-${recoveryIdentity(root)}`;
  const command = startupCommand(root, nodePath);
  async function invoke(action) {
    if (action === 'enable' && command.length > 260) throw new BridgeError('登录启动命令超过 Windows 长度限制，请将桥接放到更短的路径。', 'RECOVERY_FAILED', 503);
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
${action === 'read' ? '' : `if ($current -and $current -cne $expected) { throw '登录启动项被其他命令占用，无法替换。' }
${action === 'enable' ? "if (-not (Test-Path -LiteralPath $key -ErrorAction Stop)) { New-Item -Path $key -ErrorAction Stop | Out-Null }; Set-ItemProperty -LiteralPath $key -Name $name -Value $expected" : "if ($current) { Remove-ItemProperty -LiteralPath $key -Name $name }"}`}
$current=Read-Registration
@{ enabled=($current -ceq $expected); conflict=([bool]$current -and $current -cne $expected) } | ConvertTo-Json -Compress`;
    const result = await execute('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000, maxBuffer: 65536 });
    return JSON.parse(result.stdout.trim());
  }
  return { read: () => invoke('read'), set: enabled => invoke(enabled ? 'enable' : 'disable') };
}

export function createRecoveryManager({ root = RECOVERY_ROOT, platform = process.platform, registration, now = Date.now, staleMs = 6000 } = {}) {
  const supported = platform === 'win32';
  const preferencePath = resolve(root, '.local/recovery.json');
  const statePath = resolve(root, '.local/recovery-state.json');
  const startup = registration || (supported ? createWindowsRegistration({ root }) : null);
  let mutation = Promise.resolve();
  async function status() {
    const preferences = await readRecoveryFile(preferencePath, { autoRestart: supported });
    const state = await readRecoveryFile(statePath, {});
    let registered = { enabled: false, conflict: false };
    if (supported) {
      try { registered = await startup.read(); }
      catch { throw new BridgeError('无法读取 Windows 登录启动设置，请稍后刷新。', 'RECOVERY_UNAVAILABLE', 503); }
    }
    const heartbeatAge = now() - Date.parse(state.updatedAt);
    const supervisorRunning = supported && Number.isFinite(Date.parse(state.updatedAt))
      && heartbeatAge >= 0 && heartbeatAge < staleMs && state.state !== 'stopped';
    return {
      supported, autoStart: registered.enabled === true, autoRestart: preferences.autoRestart === true,
      supervisorRunning, state: supervisorRunning ? state.state : supported ? 'unmanaged' : 'unsupported',
      restartRequired: supported && preferences.autoRestart === true && !supervisorRunning,
      restartCount: Number.isInteger(state.restartCount) ? state.restartCount : 0,
      lastRestartAt: state.lastRestartAt || null, lastError: registered.conflict ? '登录启动项被其他命令占用，无法替换。' : state.lastError || null,
      startupConflict: registered.conflict === true,
      supervisorPid: supervisorRunning ? state.supervisorPid : null,
      childPid: supervisorRunning ? state.childPid || null : null
    };
  }
  function configure(settings) {
    if (!settings || Array.isArray(settings) || typeof settings !== 'object'
      || !Object.keys(settings).length || Object.entries(settings).some(([key, value]) => !['autoStart', 'autoRestart'].includes(key) || typeof value !== 'boolean')) {
      return Promise.reject(new BridgeError('恢复设置仅支持布尔值 autoStart 和 autoRestart。', 'INVALID_REQUEST', 400));
    }
    const operation = mutation.then(async () => {
      if (!supported) throw new BridgeError('此平台不支持 Windows 自动恢复。', 'RECOVERY_UNAVAILABLE', 503);
      if ('autoStart' in settings) {
        try { await startup.set(settings.autoStart); }
        catch (error) {
          // A lost command response can occur after a successful registry mutation.
          let actual;
          try { actual = await startup.read(); }
          catch { throw new BridgeError('无法确认 Windows 登录启动设置，请刷新核对。', 'RECOVERY_FAILED', 503); }
          if (actual.conflict || actual.enabled !== settings.autoStart) throw new BridgeError(error instanceof BridgeError ? error.message : actual.conflict ? '登录启动项被其他命令占用，无法替换。' : 'Windows 登录启动设置失败。', 'RECOVERY_FAILED', 503);
        }
        let actual;
        try { actual = await startup.read(); }
        catch { throw new BridgeError('无法确认 Windows 登录启动设置，请刷新核对。', 'RECOVERY_FAILED', 503); }
        if (actual.conflict || actual.enabled !== settings.autoStart) throw new BridgeError('Windows 登录启动设置未能生效，请刷新核对。', 'RECOVERY_FAILED', 503);
      }
      if ('autoRestart' in settings) await writeRecoveryFile(preferencePath, { autoRestart: settings.autoRestart });
      return status();
    });
    mutation = operation.catch(() => {});
    return operation;
  }
  return { status, configure };
}
