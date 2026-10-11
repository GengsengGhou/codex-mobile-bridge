import TOML from '@iarna/toml';
import { readFile, mkdir, open, lstat, rm, access } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readPrivate, writePrivate, fail, withCollaborationLock } from './collaboration-common.mjs';
import { privateFile } from './setup-connector.mjs';

export const collaborationServerName = 'codex_mobile_computer_collaboration';
const hash = data => createHash('sha256').update(data).digest('hex');
const execute = promisify(execFile);
const conflict = () => fail('MCP_REGISTRATION_CONFLICT', 409, '电脑协作配置与现有 Codex 配置冲突。请保留现有配置，在 Codex 设置中检查同名连接后重试。');
async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('MCP_CONFIG_UNSAFE', 403, 'Codex 配置目录包含链接。请使用普通本地目录后重试。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
async function replaceLocked(path, before, after) {
  if (process.platform !== 'win32') fail('MCP_REGISTRATION_UNAVAILABLE', 503, '电脑协作配置注册目前支持 Windows。');
  // FileShare.Read excludes writers and renames while compare+write holds this handle.
  // Never interpolate user/provider TOML into PowerShell source or command arguments.
  const source = `$ErrorActionPreference='Stop'; $value=[Console]::In.ReadToEnd() | ConvertFrom-Json; $file=[IO.File]::Open($value.path,[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::Read); try { $memory=[IO.MemoryStream]::new(); $file.CopyTo($memory); $original=$memory.ToArray(); $actual=[Convert]::ToBase64String($original); if($actual -cne $value.before){ throw 'Configuration changed concurrently' }; $bytes=[Convert]::FromBase64String($value.after); try { $file.Position=0; $file.Write($bytes,0,$bytes.Length); $file.SetLength($bytes.Length); $file.Flush($true) } catch { try { $file.Position=0; $file.Write($original,0,$original.Length); $file.SetLength($original.Length); $file.Flush($true) } catch {}; throw } } finally { $file.Dispose() }`;
  try {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const result = new Promise((yes, no) => { child.once('error', no); child.once('exit', code => code === 0 ? yes() : no(new Error('Config locked or changed'))); });
    child.stdin.end(JSON.stringify({ path, before: Buffer.from(before).toString('base64'), after: Buffer.from(after).toString('base64') }));
    await result;
  } catch { fail('MCP_CONFIG_CHANGED', 409, 'Codex 配置正在使用或已改变。关闭设置编辑窗口后重试。'); }
}
export async function registerCollaboration(options = {}) {
  return withCollaborationLock(resolve(options.root, '.local/collaboration-registration'), () => editRegistration(options));
}
async function editRegistration({ root, enabled, codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex'), nodePath, beforeReplace } = {}) {
  const configPath = resolve(codexHome, 'config.toml'); const ledgerPath = resolve(root, '.local/collaboration-registration.json');
  await noLinks(configPath); await noLinks(ledgerPath);
  let before = ''; try { before = await readFile(configPath, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (Buffer.byteLength(before) > 2 * 1024 * 1024) conflict();
  let ledger = await readPrivate(ledgerPath);
  const backup = resolve(root, '.local/collaboration-config-backup.toml'); await noLinks(backup);
  if (ledger?.pending) {
    let backupBytes; try { backupBytes = await readFile(backup); } catch { fail('MCP_REGISTRATION_RECOVERY_REQUIRED', 409, '电脑协作配置保存曾中断且备份不可用。请先核对 Codex 配置，切勿重复覆盖。'); }
    if (hash(backupBytes) !== ledger.beforeHash) fail('MCP_REGISTRATION_RECOVERY_REQUIRED', 409, '电脑协作配置备份已改变，请先核对本机 Codex 配置。');
    if (hash(before) === ledger.beforeHash && ledger.pendingAction === 'enable') { await rm(ledgerPath, { force: true }); ledger = null; }
    else if (hash(before) === ledger.afterHash && ledger.pendingAction === 'disable') { await rm(ledgerPath, { force: true }); ledger = null; }
    else if (hash(before) === ledger.afterHash && ledger.pendingAction === 'enable' || hash(before) === ledger.beforeHash && ledger.pendingAction === 'disable') { ledger = { ...ledger, pending: false }; await writePrivate(ledgerPath, ledger); }
    else fail('MCP_REGISTRATION_RECOVERY_REQUIRED', 409, '电脑协作配置保存曾中断。已保留本机私有备份，请先核对恢复后重试；当前配置不会被自动覆盖。');
  }
  let parsed; try { parsed = TOML.parse(before); } catch { fail('MCP_CONFIG_INVALID', 409, '现有 Codex 配置无法读取。请先在 Codex 中修复配置后重试。'); }
  const current = parsed.mcp_servers?.[collaborationServerName];
  const owned = ledger?.version === 1 && ledger.configPath === configPath && typeof ledger.block === 'string' && ledger.blockHash === hash(ledger.block) && before.split(ledger.block).length === 2;
  if (current && !owned || owned && JSON.stringify(current) !== JSON.stringify(ledger.entry) || ledger && !owned) conflict();
  if (enabled && owned) return { status: 'registered', message: '电脑协作已就绪。请在 Codex 中重新加载连接。' };
  if (!enabled && !current && !ledger) return { status: 'disabled' };
  let after, block, entry;
  if (enabled) {
    nodePath ||= resolve(root, 'runtime/node.exe'); try { await access(nodePath); } catch { nodePath = process.execPath; }
    entry = { command: nodePath, args: [resolve(root, 'scripts/collaboration-mcp.mjs')] };
    block = `# BEGIN codex-mobile-bridge computer collaboration v1\n[mcp_servers.${collaborationServerName}]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n# END codex-mobile-bridge computer collaboration v1\n`;
    after = before + (before && !before.endsWith('\n') ? '\n' : '') + block;
  } else after = before.replace(ledger.inserted || ledger.block, '');
  let updated; try { updated = TOML.parse(after); } catch { conflict(); }
  const previousSemantic = structuredClone(parsed), nextSemantic = structuredClone(updated);
  if (previousSemantic.mcp_servers) { delete previousSemantic.mcp_servers[collaborationServerName]; if (!Object.keys(previousSemantic.mcp_servers).length) delete previousSemantic.mcp_servers; }
  if (nextSemantic.mcp_servers) { delete nextSemantic.mcp_servers[collaborationServerName]; if (!Object.keys(nextSemantic.mcp_servers).length) delete nextSemantic.mcp_servers; }
  if (JSON.stringify(previousSemantic) !== JSON.stringify(nextSemantic) || enabled && JSON.stringify(updated.mcp_servers?.[collaborationServerName]) !== JSON.stringify(entry) || !enabled && updated.mcp_servers?.[collaborationServerName]) conflict();
  await mkdir(dirname(configPath), { recursive: true }); await noLinks(configPath);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 }); await noLinks(backup);
  const backupFile = await open(backup, 'w', 0o600); try { await backupFile.writeFile(before); await backupFile.sync(); } finally { await backupFile.close(); } await privateFile(backup);
  // Save intent before editing, so a crash cannot leave an unowned entry.
  const nextLedger = enabled ? { version: 1, configPath, entry, block, inserted: after.slice(before.length), blockHash: hash(block) } : ledger;
  await writePrivate(ledgerPath, { ...nextLedger, pending: true, pendingAction: enabled ? 'enable' : 'disable', beforeHash: hash(before), afterHash: hash(after) });
  await beforeReplace?.();
  try { await replaceLocked(configPath, before, after); }
  catch (e) { const actual = await readFile(configPath, 'utf8').catch(() => ''); if (hash(actual) === hash(before)) { if (enabled) await rm(ledgerPath, { force: true }); else await writePrivate(ledgerPath, ledger); } throw e; }
  if (!enabled) await rm(ledgerPath, { force: true }); else await writePrivate(ledgerPath, nextLedger);
  return { status: enabled ? 'registered' : 'disabled', ...(enabled ? { message: '电脑协作已就绪。请在 Codex 中重新加载连接。' } : {}) };
}
