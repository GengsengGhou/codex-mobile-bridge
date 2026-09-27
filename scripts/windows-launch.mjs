import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { recoveryIdentity } from '../src/recovery.mjs';

const execute = promisify(execFile);
const psLiteral = value => `'${String(value).replaceAll("'", "''")}'`;

export function windowsLaunchScript({ root, nodePath, serverPath, supervisorPath, env, instanceName, logName = instanceName || 'bridge' }) {
  if (instanceName !== undefined && !/^[a-z0-9-]{1,40}$/.test(instanceName)) throw new Error('Invalid Windows instance name.');
  if (!/^[a-z0-9-]{1,40}$/.test(logName)) throw new Error('Invalid Windows log name.');
  const suffix = instanceName ? `-${instanceName}` : '';
  const launchData = Buffer.from(JSON.stringify({ root, nodePath, serverPath, supervisorPath, mutexName: supervisorPath ? `Local\\CodexMobileBridge-${recoveryIdentity(root)}${suffix}` : null, logName, env }), 'utf8').toString('base64');
  const wrapper = resolve(root, 'scripts/windows-service.ps1');
  const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const command = `"${powershell}" -NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${wrapper}" -LaunchData ${launchData}`;
  return `$ErrorActionPreference = 'Stop'
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psLiteral(command)}; CurrentDirectory = ${psLiteral(root)}; ProcessStartupInformation = $startup }
if ($result.ReturnValue -ne 0) { throw "Windows process broker rejected launch (code $($result.ReturnValue))." }
@{ pid = [int]$result.ProcessId; mode = 'windows-wmi' } | ConvertTo-Json -Compress`;
}

export async function launchWindowsBridge(options, executeProcess = execute) {
  const script = windowsLaunchScript(options);
  const powershell = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  try {
    const result = await executeProcess(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')
    ], { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 });
    const launched = JSON.parse(result.stdout.trim());
    if (!Number.isInteger(launched.pid) || launched.pid <= 0 || launched.mode !== 'windows-wmi') {
      throw new Error('Windows process broker returned an invalid process ID.');
    }
    return launched;
  } catch (error) {
    throw new Error(`Windows independent launch failed: ${error.stderr?.trim() || error.message}`, { cause: error });
  }
}
