import { readFile, mkdir, open, rename, rm, link, access } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, parse } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export class CollaborationError extends Error {
  constructor(code, status = 403, message = code) { super(message); this.code = code; this.status = status; }
}
export const fail = (code, status, message) => { throw new CollaborationError(code, status, message); };
export const definitiveRejection = code => /^(?:INVALID_|BODY_TOO_LARGE|NOT_FOUND|DEVICE_REVOKED|DEVICE_OFFLINE|DEVICE_BUSY|HUB_BUSY|ACCOUNT_BUSY|PROJECT_NOT_AUTHORIZED|THREAD_NOT_AUTHORIZED|COLLABORATION_NOT_AUTHORIZED|COLLABORATION_BINDING_CHANGED|COLLABORATION_CONTROL_DISABLED|COLLABORATION_UNAVAILABLE|OPERATION_CONFLICT|SEND_DISABLED|CREATE_DISABLED|DESKTOP_REJECTED|DESKTOP_UNAVAILABLE)$/.test(code || '') || (code || '').startsWith('INVALID_');
export const within = (root, target) => { const p = relative(root, target); return !p || p !== '..' && !p.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && !isAbsolute(p); };
export const validRoot = p => typeof p === 'string' && isAbsolute(p) && resolve(p) !== parse(resolve(p)).root && !/^(?:\\\\|\/\/)/.test(p) && !/[\x00-\x1f]/.test(p);
export async function readPrivate(path, fallback = null) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp'; let handle;
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; await rename(temporary, path); }
  finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}
export async function reservePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle; const temporary = path + '.' + randomUUID() + '.tmp';
  // Publish a complete, synced record atomically without replacing an existing ID.
  // Concurrent MCP processes cannot observe a half-written reservation or lose other IDs.
  try { handle = await open(temporary, 'wx', 0o600); await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); await handle.close(); handle = null; await link(temporary, path); return true; }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  finally { await handle?.close(); await rm(temporary, { force: true }).catch(() => {}); }
}
export async function withCollaborationLock(path, operation) {
  if (process.platform !== 'win32') {
    // The product UI is Windows-only; native cross-process mutexes are used on Windows.
    const lock = path + '.lock'; await mkdir(dirname(lock), { recursive: true });
    await mkdir(lock); try { return await operation(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
  const identity = createHash('sha256').update(resolve(path).toLowerCase()).digest('hex').slice(0, 32);
  const source = `$ErrorActionPreference='Stop'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $mutex=[Threading.Mutex]::new($false,('Local\\CodexMobileCollaboration-${identity}-'+$sid)); $held=$false; try { try { $held=$mutex.WaitOne(10000) } catch [Threading.AbandonedMutexException] { $held=$true }; if(-not $held){throw 'Collaboration settings busy'}; [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); [Console]::In.ReadLine()|Out-Null } finally { if($held){$mutex.ReleaseMutex()}; $mutex.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  const closed = new Promise(yes => child.once('close', yes));
  try {
    await new Promise((yes, no) => {
      const timer = setTimeout(() => no(new CollaborationError('COLLABORATION_SETTINGS_BUSY', 409, '电脑协作设置正在保存，请稍后重试。')), 12000);
      lines.once('line', line => { clearTimeout(timer); line === 'locked' ? yes() : no(new Error('Invalid lock')); });
      child.once('error', error => { clearTimeout(timer); no(error); });
      child.once('exit', () => { clearTimeout(timer); no(new CollaborationError('COLLABORATION_SETTINGS_BUSY', 409, '电脑协作设置正在保存，请稍后重试。')); });
    });
    return await operation();
  } finally { child.stdin.end('\n'); lines.close(); await closed; }
}
export const collaborationAuthorizationRequired = (value, config) => value?.requiresAuthorization === true || !!(value && config && (value.deviceId !== config.deviceId || value.hubOrigin !== config.hubOrigin));
export const collaborationAuthorizationMessage = '配对已改变，旧电脑协作授权已失效。请刷新电脑协作设置，重新选择电脑和项目并保存；目标电脑也需授权新的设备身份。';
export async function resetCollaborationForPairing({ configPath, config }) {
  const directory = dirname(configPath);
  return withCollaborationLock(resolve(directory, 'collaboration-settings'), async () => {
    const paths = ['computer-collaboration.json', 'collaboration-registration.json', 'collaboration-registration-state.json'].map(name => resolve(directory, name));
    let configured = false;
    for (const path of paths) {
      try { await access(path); configured = true; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!configured) return { requiresAuthorization: false };
    const current = await readPrivate(configPath);
    if (current?.deviceId !== config.deviceId || current?.hubOrigin !== config.hubOrigin || current?.deviceToken !== config.deviceToken) return { requiresAuthorization: true, superseded: true };
    // Preserve owned Codex configuration and receipts; never transfer old grants.
    await writePrivate(paths[0], { version: 1, hubOrigin: config.hubOrigin, deviceId: config.deviceId, controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [], requiresAuthorization: true });
    await writePrivate(paths[2], { status: 'authorization-required', message: collaborationAuthorizationMessage });
    return { requiresAuthorization: true };
  });
}
export function effectivePolicy(value, config) {
  const valid = value?.version === 1 && config && value.deviceId === config.deviceId && value.hubOrigin === config.hubOrigin && Array.isArray(value.allowedDeviceIds) && Array.isArray(value.allowedProjectRoots);
  const requiresAuthorization = collaborationAuthorizationRequired(value, config);
  return valid ? { ...value, requiresAuthorization, controlEnabled: !requiresAuthorization && !value.controlPending && value.controlEnabled === true, receiveEnabled: !requiresAuthorization && value.receiveEnabled === true } : { version: 1, requiresAuthorization, controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] };
}
export async function localBridge(config, path, body, { maxBytes = 2 * 1024 * 1024, timeoutMs = 20000, binary = false } = {}) {
  const origin = `http://127.0.0.1:${config.bridgePort}`;
  const bootstrap = await fetch(origin, { signal: AbortSignal.timeout(5000), redirect: 'error' });
  const cookie = bootstrap.headers.getSetCookie().find(v => /^bridge_session=[a-f0-9]+;/.test(v))?.split(';')[0];
  await bootstrap.body?.cancel();
  if (!bootstrap.ok || !cookie) fail('LOCAL_DESKTOP_UNAVAILABLE', 503);
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { cookie, origin, 'x-bridge-client': 'mobile-v1', ...(config.collaborationSourceDeviceId ? { 'x-collaboration-source': config.collaborationSourceDeviceId, 'x-collaboration-target': config.deviceId } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const pieces = []; let size = 0;
  for await (const piece of response.body) { size += piece.length; if (size > maxBytes) { await response.body.cancel().catch(() => {}); fail('RESULT_TOO_LARGE', 413); } pieces.push(piece); }
  const bytes = Buffer.concat(pieces);
  let value; if (!binary || !response.ok) { try { value = JSON.parse(bytes.toString()); } catch { fail('DESKTOP_PROTOCOL_ERROR', 502); } }
  if (!response.ok) fail(value.code || 'DESKTOP_UNAVAILABLE', response.status, value.error);
  return binary ? bytes : value;
}
