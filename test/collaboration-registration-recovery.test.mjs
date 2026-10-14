import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, copyFile, access, link } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import TOML from '@iarna/toml';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { disableCollaborationForUninstall } from '../scripts/collaboration-lifecycle.mjs';
import { readPrivate, writePrivate } from '../scripts/collaboration-common.mjs';

const evidenceRoot = resolve('work/registration-recovery');
const execute = promisify(execFile);
const original = '# provider fixture\r\nmodel_provider="fixture"\r\n[model_providers.fixture]\r\nbase_url="https://fixture.invalid/v1"\r\napi_key="fixture-key-only"\r\n[mcp_servers.external]\r\ncommand="other-tool"\r\n';
async function fixture(name) {
  await mkdir(evidenceRoot, { recursive: true });
  const root = await mkdtemp(resolve(evidenceRoot, name + '-'));
  const codexHome = resolve(root, 'codex-home'); await mkdir(codexHome);
  const config = resolve(codexHome, 'config.toml'); await writeFile(config, original);
  await registerCollaboration({ root, codexHome, enabled: true });
  return { root, codexHome, config, ledger: await readPrivate(resolve(root, '.local/collaboration-registration.json')) };
}

test('owned TOML survives comments, quoted header, reordered keys and CRLF without adopting edits', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture('formatted');
  const reformatted = original + `# Codex editor rewrote this section\r\n[mcp_servers."${collaborationServerName}"]\r\nargs = ${JSON.stringify(f.ledger.entry.args)} # keep argument order\r\ncommand = ${JSON.stringify(f.ledger.entry.command)}\r\n`;
  await writeFile(f.config, reformatted);
  assert.equal((await registerCollaboration({ ...f, enabled: true })).status, 'registered');
  assert.equal(await readFile(f.config, 'utf8'), reformatted);
  await registerCollaboration({ ...f, enabled: false });
  const after = await readFile(f.config, 'utf8'); assert.ok(after.startsWith(original));
  assert.equal(TOML.parse(after).mcp_servers[collaborationServerName], undefined);
  assert.equal(TOML.parse(after).model_providers.fixture.api_key, 'fixture-key-only');
});

test('dotted and inline owned assignments are removed without interpreting multiline text as headers', { skip: process.platform !== 'win32' }, async () => {
  for (const style of ['dotted', 'inline']) {
    const f = await fixture(style);
    const entry = f.ledger.entry;
    const block = style === 'dotted' ? `mcp_servers."${collaborationServerName}".args = ${JSON.stringify(entry.args)}\n mcp_servers."${collaborationServerName}".command = ${JSON.stringify(entry.command)}\n` : `[mcp_servers]\n"${collaborationServerName}" = { args = ${JSON.stringify(entry.args)}, command = ${JSON.stringify(entry.command)} }\n`;
    // Put root assignments before any existing provider table.
    const prefix = `description = '''\n[mcp_servers.${collaborationServerName}]\ncommand = "looks like a table, but is text"\n'''\n`;
    const suffix = original + '[another_tool]\ncommand="untouched"\n';
    const before = prefix + block + suffix; await writeFile(f.config, before);
    await registerCollaboration({ ...f, enabled: false });
    const after = await readFile(f.config, 'utf8');
    assert.ok(after.startsWith(prefix)); assert.ok(after.endsWith(suffix));
    assert.equal(TOML.parse(after).mcp_servers[collaborationServerName], undefined);
  }
});

test('foreign or meaningfully edited command, args, env and options are never adopted or removed', { skip: process.platform !== 'win32' }, async () => {
  for (const field of ['command', 'args', 'env', 'enabled', 'missing-ledger']) {
    const f = await fixture('edited-' + field), entry = { ...f.ledger.entry };
    if (field === 'command') entry.command = 'foreign-program';
    if (field === 'args') entry.args = ['foreign-script'];
    if (field === 'env') entry.env = { USER_SETTING: 'keep-me' };
    if (field === 'enabled') entry.enabled = false;
    const before = original + TOML.stringify({ mcp_servers: { [collaborationServerName]: entry } });
    await writeFile(f.config, before);
    if (field === 'missing-ledger') await rm(resolve(f.root, '.local/collaboration-registration.json'));
    for (const enabled of [true, false]) await assert.rejects(registerCollaboration({ ...f, enabled }), e => e.code === 'MCP_REGISTRATION_CONFLICT');
    assert.equal(await readFile(f.config, 'utf8'), before);
  }
});

test('damaged ownership evidence and pending recovery stay guarded', { skip: process.platform !== 'win32' }, async () => {
  for (const damage of ['hash', 'entry', 'path', 'pending']) {
    const f = await fixture('damaged-' + damage), before = await readFile(f.config, 'utf8');
    const ledger = { ...f.ledger };
    if (damage === 'hash') ledger.blockHash = 'damaged';
    if (damage === 'entry') ledger.entry = { ...ledger.entry, command: 'foreign' };
    if (damage === 'path') ledger.configPath = resolve(f.root, 'foreign-config.toml');
    if (damage === 'pending') Object.assign(ledger, { pending: true, beforeHash: 'invalid', afterHash: 'invalid', pendingAction: 'disable' });
    await writePrivate(resolve(f.root, '.local/collaboration-registration.json'), ledger);
    await assert.rejects(registerCollaboration({ ...f, enabled: false }), e => e.code === 'MCP_REGISTRATION_RECOVERY_REQUIRED');
    assert.equal(await readFile(f.config, 'utf8'), before);
  }
});

test('format recovery keeps locked compare/write and junction refusal', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture('guarded');
  const formatted = original + TOML.stringify({ mcp_servers: { [collaborationServerName]: f.ledger.entry } });
  await writeFile(f.config, formatted);
  const edit = formatted + '# concurrent-editor\n';
  await assert.rejects(registerCollaboration({ ...f, enabled: false, beforeReplace: () => writeFile(f.config, edit) }), e => e.code === 'MCP_CONFIG_CHANGED');
  assert.equal(await readFile(f.config, 'utf8'), edit);
  await assert.rejects(registerCollaboration({ ...f, enabled: false }), e => e.code === 'MCP_REGISTRATION_RECOVERY_REQUIRED');
  const linked = await fixture('junction'), link = resolve(linked.root, 'linked-home'); await symlink(linked.codexHome, link, 'junction');
  await assert.rejects(registerCollaboration({ root: linked.root, codexHome: link, enabled: false }), e => e.code === 'MCP_CONFIG_UNSAFE');
  const locked = await fixture('file-lock');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  let child, closed;
  try {
    await assert.rejects(registerCollaboration({ ...locked, enabled: false, beforeReplace: async () => {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$file=[IO.File]::Open(${literal(locked.config)},'Open','ReadWrite','None');try{[Console]::Out.WriteLine('held');[Console]::Out.Flush();[Console]::In.ReadLine()|Out-Null}finally{$file.Dispose()}`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      closed = new Promise(yes => child.once('close', yes));
      await new Promise((yes, no) => { child.stdout.once('data', yes); child.once('error', no); });
    } }), e => e.code === 'MCP_CONFIG_CHANGED');
  } finally { child?.stdin.end('\n'); if (closed) await closed; }
  assert.equal(TOML.parse(await readFile(locked.config, 'utf8')).mcp_servers[collaborationServerName].command, locked.ledger.entry.command);
});

test('uninstall clears pending authorization, preserves changed settings, and blocks integrity errors', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture('lifecycle');
  await writePrivate(resolve(f.root, '.local/computer-collaboration.json'), { controlEnabled: true, receiveEnabled: true, controlPending: true, requiresAuthorization: true, allowedDeviceIds: ['fixture-device'] });
  const edited = original + TOML.stringify({ mcp_servers: { [collaborationServerName]: { ...f.ledger.entry, env: { USER_SETTING: 'keep-me' } } } });
  await writeFile(f.config, edited);
  const result = await disableCollaborationForUninstall({ root: f.root });
  assert.equal(result.disabled, true); assert.equal(result.configurationPreserved, true); assert.equal(result.ownedRegistrationRemoved, false); assert.match(result.warning, /手动移除/);
  assert.equal(await readFile(f.config, 'utf8'), edited);
  assert.deepEqual(await readPrivate(resolve(f.root, '.local/computer-collaboration.json')), { controlEnabled: false, receiveEnabled: false, controlPending: false, requiresAuthorization: false, allowedDeviceIds: ['fixture-device'] });
  await writePrivate(resolve(f.root, '.local/collaboration-registration.json'), { ...f.ledger, blockHash: 'damaged' });
  await assert.rejects(disableCollaborationForUninstall({ root: f.root }), e => e.code === 'MCP_REGISTRATION_RECOVERY_REQUIRED');
  assert.equal(await readFile(f.config, 'utf8'), edited);
});

test('real uninstall entry helper completes only after verified stop; preserved config warning is returned', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const f = await fixture('uninstall-helper');
  const codexHome = f.codexHome;
  // Keep the Codex fixture outside the installation directory that gets removed.
  const retainedHome = f.root + '-codex-home'; await mkdir(retainedHome);
  const retainedConfig = resolve(retainedHome, 'config.toml');
  await copyFile(f.config, retainedConfig); await rm(codexHome, { recursive: true });
  await writePrivate(resolve(f.root, '.local/collaboration-registration.json'), { ...f.ledger, configPath: retainedConfig });
  const edited = original + TOML.stringify({ mcp_servers: { [collaborationServerName]: { ...f.ledger.entry, env: { USER_SETTING: 'keep-me' } } } });
  await writeFile(retainedConfig, edited);
  await writePrivate(resolve(f.root, '.local/computer-collaboration.json'), { controlEnabled: true, receiveEnabled: true, requiresAuthorization: true });
  await writePrivate(resolve(f.root, '.local/hub-connector.json'), { fixture: 'saved-pairing' });
  await writeFile(resolve(f.root, 'installed.json'), JSON.stringify({ version: 1, root: f.root }));
  await mkdir(resolve(f.root, 'runtime'));
  try { await link(process.execPath, resolve(f.root, 'runtime/node.exe')); }
  catch (error) { if (error.code !== 'EXDEV') throw error; await copyFile(process.execPath, resolve(f.root, 'runtime/node.exe')); }
  await mkdir(resolve(f.root, 'scripts'));
  for (const name of ['collaboration-lifecycle.mjs', 'collaboration-common.mjs', 'collaboration-registration.mjs', 'collaboration-launcher.mjs', 'setup-connector.mjs', 'read-secret.mjs', 'network-error.mjs', 'hub-clock.mjs']) await copyFile(new URL('../scripts/' + name, import.meta.url), resolve(f.root, 'scripts', name));
  await mkdir(resolve(f.root, 'src'));
  await copyFile(new URL('../src/clock-protocol.mjs', import.meta.url), resolve(f.root, 'src/clock-protocol.mjs'));
  const gui = resolve(f.root, 'scripts/connector-gui.mjs');
  await writeFile(gui, 'console.log(JSON.stringify({ok:true,disconnectVerified:false}));\n');
  const helper = fileURLToPath(new URL('../deploy/uninstall-connector.ps1', import.meta.url));
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const harness = resolve(evidenceRoot, 'uninstall-helper-harness.ps1');
  const harnessSource = `param([string]$FixtureRoot,[string]$Mode)\n$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\n$global:fixtureScans=0\n$global:fixtureMode=$Mode\n$global:fixtureStops=0\nfunction Get-ItemProperty { param($LiteralPath,$ErrorAction) if($LiteralPath -notlike 'HKCU:*'){throw 'Unexpected registry read'}; [pscustomobject]@{} }\nfunction Remove-ItemProperty { throw 'No fixture registry registrations may be removed' }\nfunction Get-CimInstance { param($ClassName) if($ClassName -ne 'Win32_Process'){throw 'Unexpected process query'};$global:fixtureScans++;if($global:fixtureMode -eq 'stuck'){[pscustomobject]@{ProcessId=2147483646;ExecutablePath=(Join-Path $FixtureRoot 'runtime/node.exe');CommandLine=('"'+(Join-Path $FixtureRoot 'scripts/start.mjs')+'"')}} }\nfunction Stop-Process { param($Id,[switch]$Force,$ErrorAction) $global:fixtureStops++ }\nfunction Start-Sleep {}\nfunction New-Object { param($ComObject) if($ComObject -ne 'Schedule.Service'){throw 'Unexpected COM object'};$folder=[pscustomobject]@{};$folder|Add-Member ScriptMethod GetTasks {param($flags) @()};$scheduler=[pscustomobject]@{folder=$folder};$scheduler|Add-Member ScriptMethod Connect {};$scheduler|Add-Member ScriptMethod GetFolder {param($path) $this.folder};$scheduler }\nfunction Remove-Item { param($LiteralPath,[switch]$Recurse,[switch]$Force) $absolute=[IO.Path]::GetFullPath($LiteralPath);if(-not $absolute.StartsWith($FixtureRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Delete escaped fixture root'};Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $absolute -Recurse:$Recurse -Force:$Force }\n& ${literal(helper)} -Root $FixtureRoot\nif($LASTEXITCODE -ne 0){exit $LASTEXITCODE}\n[Console]::Out.WriteLine(('fixture-process-scans='+$global:fixtureScans))\n`;
  await writeFile(harness, harnessSource);
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harness, '-FixtureRoot', f.root];
  await assert.rejects(execute('powershell.exe', args, { windowsHide: true, timeout: 20000, encoding: 'utf8' }), e => {
    const status = JSON.parse(e.stdout.trim()); assert.equal(status.ok, false); assert.equal(status.uninstalled, false); assert.match(status.error, /pause\/stop/); return e.code === 1;
  });
  await access(resolve(f.root, 'installed.json')); assert.equal(await readFile(retainedConfig, 'utf8'), edited);
  await writeFile(gui, 'console.log(JSON.stringify({ok:true,disconnectVerified:true}));\n');
  await assert.rejects(execute('powershell.exe', [...args, '-Mode', 'stuck'], { windowsHide: true, timeout: 20000, encoding: 'utf8' }), e => {
    const status = JSON.parse(e.stdout.trim()); assert.equal(status.ok, false); assert.equal(status.uninstalled, false); assert.match(status.error, /Owned installation processes could not be stopped/); return e.code === 1;
  });
  await access(resolve(f.root, 'installed.json')); assert.equal(await readFile(retainedConfig, 'utf8'), edited);
  const { stdout } = await execute('powershell.exe', args, { windowsHide: true, timeout: 20000, encoding: 'utf8' });
  const lines = stdout.trim().split(/\r?\n/), result = JSON.parse(lines[0]);
  assert.equal(result.ok, true); assert.equal(result.uninstalled, true); assert.equal(result.configurationPreserved, true); assert.match(result.warning, /手动移除/); assert.equal(lines[1], 'fixture-process-scans=3');
  await assert.rejects(access(resolve(f.root, 'installed.json')), e => e.code === 'ENOENT');
  assert.deepEqual(await readPrivate(resolve(f.root, '.local/hub-connector.json')), { fixture: 'saved-pairing' });
  assert.equal((await readPrivate(resolve(f.root, '.local/computer-collaboration.json'))).requiresAuthorization, false);
  assert.equal(await readFile(retainedConfig, 'utf8'), edited);
  await writeFile(resolve(evidenceRoot, 'uninstall-helper-result.json'), JSON.stringify({ fixtureRoot: f.root, failedDisconnect: 'blocked before deleting files', failedOwnedProcessStop: 'ten fixture-only stop attempts, then abort before deleting files', successfulStop: result, actualOwnedProcessScansOnSuccess: 3, untouchedRealRegistryAndTasks: true, realProcessesKilled: 0 }, null, 2));
});
