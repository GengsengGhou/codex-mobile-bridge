import { readFile, mkdir, lstat, copyFile, readdir, rename, rm, rmdir } from 'node:fs/promises';
import { resolve, dirname, basename, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrivate, writePrivate, fail } from './collaboration-common.mjs';
import { privateFile } from './setup-connector.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => typeof a === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
export function collaborationLauncherDirectory(root, { profile = homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  root = resolve(root);
  // Outside AppData, the installation itself is already an ordinary view.
  const appData = localAppData && dirname(resolve(localAppData)).toLowerCase();
  return appData && (root.toLowerCase() === appData || root.toLowerCase().startsWith(appData + sep))
    ? resolve(profile, '.codex-mobile-bridge/launchers', hash(root.toLowerCase()).slice(0, 24))
    : resolve(root, '.local/collaboration-launchers');
}
async function noLinks(path) {
  for (let item = resolve(path);;) {
    try { if ((await lstat(item)).isSymbolicLink()) throw new Error('link'); } catch (error) { if (error.code !== 'ENOENT') fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动目录归属无法验证。已保留配对和授权，请运行修复安装。'); }
    const parent = dirname(item); if (parent === item) return; item = parent;
  }
}
async function privateDirectory(path) {
  if (process.platform !== 'win32') return;
  const literal = `'${path.replaceAll("'", "''")}'`;
  const source = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl(${literal},$acl)`;
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}
export async function readCollaborationLaunch(root) {
  const manifestPath = resolve(root, '.local/collaboration-launcher.json'); await noLinks(manifestPath);
  const manifest = await readPrivate(manifestPath);
  if (!manifest) return null;
  const directory = collaborationLauncherDirectory(root), command = resolve(directory, `CollaborationLauncher-${manifest.sha256}.exe`);
  if (manifest.version !== 1 || !equal(manifest.root, root) || !equal(manifest.command, command) || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '')) fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动配置无法验证。已保留配对和授权，请运行修复安装。');
  await noLinks(command);
  const ownerPath = resolve(directory, 'owner.json'); await noLinks(ownerPath); const owner = await readPrivate(ownerPath);
  if (owner?.application !== 'codex-mobile-bridge' || owner.version !== 1 || !equal(owner.root, root) || hash(await readFile(command)) !== manifest.sha256) fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动组件需要修复。配对和授权已保留，请运行修复安装。');
  return { command, args: ['--install-root', resolve(root)] };
}
export async function ownedCollaborationLaunch(root, entry, { allowMissing = false } = {}) {
  if (!entry || !equal(dirname(entry.command || ''), collaborationLauncherDirectory(root)) || !/^CollaborationLauncher-[a-f0-9]{64}\.exe$/.test(basename(entry.command || '')) || JSON.stringify(entry.args) !== JSON.stringify(['--install-root', resolve(root)])) return false;
  await noLinks(entry.command);
  const ownerPath = resolve(dirname(entry.command), 'owner.json'); await noLinks(ownerPath); const owner = await readPrivate(ownerPath);
  if (owner?.application !== 'codex-mobile-bridge' || owner.version !== 1 || !equal(owner.root, root)) return false;
  try { return hash(await readFile(entry.command)) === basename(entry.command).slice(22, -4); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return true; throw error; }
}
export async function installCollaborationLauncher({ root } = {}) {
  root = resolve(root);
  const source = resolve(root, 'runtime/CollaborationLauncher.exe'), directory = collaborationLauncherDirectory(root);
  await noLinks(source); await noLinks(directory); await noLinks(resolve(root, '.local/collaboration-launcher.json'));
  const ownerPath = resolve(directory, 'owner.json'); await noLinks(ownerPath); const owner = await readPrivate(ownerPath);
  if (owner && (owner.application !== 'codex-mobile-bridge' || owner.version !== 1 || !equal(owner.root, root)) || !owner && (await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error; })).length) fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动目录属于其他文件。已保留现有文件，请选择其他安装目录。');
  const bytes = await readFile(source), digest = hash(bytes), command = resolve(directory, `CollaborationLauncher-${digest}.exe`);
  await mkdir(directory, { recursive: true }); await noLinks(command); await noLinks(ownerPath);
  await privateDirectory(directory);
  // Record ownership before file creation, so interrupted extraction is retryable.
  await writePrivate(ownerPath, { version: 1, application: 'codex-mobile-bridge', root });
  await privateFile(ownerPath);
  // Immutable versions avoid replacing the executable held open by a live MCP.
  const existing = await readFile(command).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (existing && hash(existing) !== digest) fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动组件归属无法验证，请运行修复安装。');
  if (!existing) { const temporary = resolve(directory, '.launcher-' + randomUUID().slice(0, 12) + '.tmp'); try { await copyFile(source, temporary); await privateFile(temporary); await rename(temporary, command); } finally { await rm(temporary, { force: true }); } }
  await writePrivate(resolve(root, '.local/collaboration-launcher.json'), { version: 1, root, command, sha256: digest });
  await privateFile(resolve(root, '.local/collaboration-launcher.json'));
  return readCollaborationLaunch(root);
}
export async function removeCollaborationLauncher(root) {
  const launch = await readCollaborationLaunch(root); if (!launch) return { removed: false };
  const directory = dirname(launch.command); await noLinks(directory);
  for (const name of await readdir(directory)) {
    if (!/^CollaborationLauncher-[a-f0-9]{64}\.exe$/.test(name)) continue;
    const command = resolve(directory, name);
    if (!await ownedCollaborationLaunch(root, { command, args: launch.args })) fail('COLLABORATION_LAUNCHER_UNSAFE', 409, '协作启动组件归属无法验证。已保留现有文件，卸载未完成。');
    await rm(command);
  }
  // Keep unrelated files. Never recursively remove an external launch directory.
  const remaining = await readdir(directory);
  if (remaining.length === 1 && remaining[0] === 'owner.json') { await rm(resolve(directory, 'owner.json')); await rmdir(directory); }
  await rm(resolve(root, '.local/collaboration-launcher.json'));
  return { removed: true, unrelatedFilesPreserved: remaining.some(name => name !== 'owner.json') };
}
