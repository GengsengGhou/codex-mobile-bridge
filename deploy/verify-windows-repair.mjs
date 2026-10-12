import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, access, readdir, symlink, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Repair verification requires Windows.');
const project = fileURLToPath(new URL('..', import.meta.url));
const releaseVersion = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version;
const setup = resolve(process.argv[2]);
const legacy = resolve(process.argv[3] || 'dist/CodexMobileConnector-Setup.exe');
const lower = resolve(process.argv[4] || 'work/publication/v2.0.0/baselines/CodexMobileConnector-Setup-1.0.5.exe');
const evidence = resolve(process.env.CODEX_REPAIR_EVIDENCE_DIRECTORY || 'work/installer-repair'); await mkdir(evidence, { recursive: true });
const base = join(evidence, 'fixtures-' + Date.now()); await mkdir(base);
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const run = (exe, args) => spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 });
const absent = path => assert.rejects(access(path), e => e.code === 'ENOENT');
const cases = [];
const config = join(base, 'codex-config.toml'), configBytes = '# isolated fixture\nmodel_provider="private-provider"\n[model_providers.private-provider]\napi_key="fixture-only-key"\n[mcp_servers.codex_mobile_computer_collaboration]\ncommand="user-edited-tool"\n';
await writeFile(config, configBytes);
async function localSnapshot(root) {
  const files = {};
  async function visit(path, prefix = '') { for (const file of await readdir(path, { withFileTypes: true })) { if (file.isDirectory()) await visit(join(path, file.name), prefix + file.name + '/'); else files[prefix + file.name] = await digest(join(path, file.name)); } }
  await visit(join(root, '.local')); return files;
}
async function fixture(name, packagePath = setup) {
  const root = join(base, name); const result = run(packagePath, ['--install-root', root, '--install', '--language', 'en']);
  assert.equal(result.status, 0, result.stderr || await readFile(root + '.install-error.txt', 'utf8').catch(() => result.error?.message));
  const data = { 'hub-connector.json': { version: 1, hubOrigin: 'https://fixture.invalid', deviceId: '11111111-1111-4111-8111-111111111111', deviceToken: 'f'.repeat(43), bridgePort: 49173 }, 'connector-control.json': { version: 2, paused: true, pauseScope: 'persistent', autoStart: false, autoStartSelected: true, startupPending: false, bootstrapPending: false, disconnectVerified: true, revision: 'fixture', settingsRevision: 'fixture' }, 'computer-collaboration.json': { controlEnabled: false, receiveEnabled: false, requiresAuthorization: false }, 'collaboration-outbox/receipt.json': { operationId: 'fixture', state: 'accepted' }, 'runtime.json': { callerThreadId: 'fixture-preserved', enableSend: false }, 'desktop-language.json': { language: 'en' } };
  for (const [name, value] of Object.entries(data)) { await mkdir(join(root, '.local', name, '..'), { recursive: true }); await writeFile(join(root, '.local', name), JSON.stringify(value)); }
  return { root, local: await localSnapshot(root) };
}
async function preserved(f) { assert.deepEqual(await localSnapshot(f.root), f.local); assert.equal(await readFile(config, 'utf8'), configBytes); }
async function repair(f, flags = [], expected = 0) {
  const result = run(setup, ['--install-root', f.root, '--install', ...flags]);
  const error = await readFile(f.root + '.install-error.txt', 'utf8').catch(() => result.stderr || result.error?.message);
  assert.equal(result.status, expected, error); return error;
}
async function healthy(f) {
  assert.equal(await digest(join(f.root, 'CodexMobileConnector.exe')), await digest(setup));
  assert.equal(run(join(f.root, 'runtime/node.exe'), ['--version']).status, 0);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, 'installed.json'), 'utf8')), { root: f.root, version: 1, application: 'codex-mobile-bridge', appVersion: releaseVersion });
  await absent(f.root + '.upgrade-journal.json'); await absent(f.root + '.upgrade-backup'); await absent(f.root + '.install-error.txt'); await preserved(f);
}
try {
  const legacyInstall = await fixture('actual-legacy-upgrade', legacy);
  const legacyVersion = JSON.parse(await readFile(join(legacyInstall.root, 'package.json'), 'utf8')).version;
  await repair(legacyInstall); await healthy(legacyInstall); cases.push(`actual legacy ${legacyVersion} -> ${releaseVersion} upgrade; private bytes preserved`);
  const clean = await fixture('same-version');
  const ui = join(base, 'repair-ui.json'); const window = spawn(setup, ['--install-root', clean.root, '--qa-upgrade-evidence', ui], { windowsHide: true, stdio: 'ignore' });
  try { for (let attempt = 0; attempt < 50; attempt++) { try { await access(ui); break; } catch {} await new Promise(r => setTimeout(r, 100)); } assert.equal(JSON.parse(await readFile(ui, 'utf8')).button, 'Repair'); }
  finally { window.kill(); await new Promise(r => window.exitCode === null ? window.once('exit', r) : r()); }
  await repair(clean); await healthy(clean); cases.push(`actual ${releaseVersion} -> ${releaseVersion} repair; English Repair UI; private bytes preserved`);

  const historical = await fixture('actual-0.1.5', resolve('work/webview-0.1.5/CodexMobileConnector-Setup.exe'));
  await repair(historical); await healthy(historical); cases.push(`actual cached 0.1.5 with empty ProductName -> ${releaseVersion} upgrade preserves legacy compatibility`);

  for (const damage of ['missing', 'corrupt']) {
    const f = await fixture('damaged-' + damage, legacy);
    await rm(join(f.root, 'runtime'), { recursive: true }); await rm(join(f.root, 'scripts/connector-gui.mjs'));
    if (damage === 'missing') await rm(join(f.root, 'CodexMobileConnector.exe')); else await writeFile(join(f.root, 'CodexMobileConnector.exe'), 'damaged owned executable');
    await writeFile(join(f.root, 'Microsoft.Web.WebView2.Core.dll'), 'damaged SDK');
    await repair(f); await healthy(f); await access(join(f.root, 'scripts/connector-gui.mjs')); cases.push(damage + ' legacy EXE/runtime/gui and damaged SDK restored from incoming payload');
  }

  const rollback = await fixture('rollback'); const previous = await digest(join(rollback.root, 'CodexMobileConnector.exe')); const previousMarker = await readFile(join(rollback.root, 'installed.json'));
  assert.match(await repair(rollback, ['--qa-upgrade-fail'], 1), /previous files were restored/);
  assert.equal(await digest(join(rollback.root, 'CodexMobileConnector.exe')), previous); assert.deepEqual(await readFile(join(rollback.root, 'installed.json')), previousMarker); await preserved(rollback);
  await repair(rollback); await healthy(rollback); cases.push('same-version partial-copy rollback restores EXE/marker/private bytes; retry clears stale error');

  for (const phase of ['move', 'language', 'committed']) {
    const f = await fixture('interrupted-' + phase);
    const flag = phase === 'move' ? '--qa-upgrade-abort' : phase === 'language' ? '--qa-upgrade-language-abort' : '--qa-upgrade-abort-committed';
    await repair(f, [flag], 1); await access(f.root + '.upgrade-journal.json');
    if (phase !== 'move') await writeFile(join(f.root, 'public/index.html'), 'damaged after same-version transaction interruption');
    await repair(f); await healthy(f); assert.notEqual(await readFile(join(f.root, 'public/index.html'), 'utf8'), 'damaged after same-version transaction interruption'); cases.push('interrupted ' + phase + ' transaction recovered then same-version replacement completed');
  }

  const guard = await fixture('guards'), guardExe = join(guard.root, 'CodexMobileConnector.exe'), guardMarker = join(guard.root, 'installed.json'), originalMarker = await readFile(guardMarker);
  for (const malformed of [{ root: guard.root }, { root: guard.root, version: '1' }, { root: 'C:\\unknown', version: 1 }, { root: guard.root, version: 1, application: 'foreign-app' }]) { await writeFile(guardMarker, JSON.stringify(malformed)); await repair(guard, [], 1); await preserved(guard); }
  await writeFile(guardMarker, originalMarker);
  const originalExe = await readFile(guardExe); await writeFile(guardExe, 'damaged owned executable');
  assert.equal(run(lower, ['--install-root', guard.root, '--install']).status, 1); assert.equal(await readFile(guardExe, 'utf8'), 'damaged owned executable'); await preserved(guard);
  await writeFile(guardExe, originalExe);
  const control = join(guard.root, '.local/connector-control.json'), validControl = await readFile(control); await writeFile(control, '{damaged'); const beforeMalformed = await localSnapshot(guard.root);
  assert.match(await repair(guard, [], 1), /Saved connection intent is damaged/); assert.deepEqual(await localSnapshot(guard.root), beforeMalformed); await writeFile(control, validControl);
  await repair(guard); await healthy(guard); cases.push('malformed/missing-schema/foreign-root markers and damaged control refuse; lower setup refuses damaged owned version fallback');

  const foreign = await fixture('foreign-exe'), foreignSource = join(base, 'foreign.cs');
  await writeFile(foreignSource, `using System.Reflection; [assembly: AssemblyVersion("${releaseVersion}.0")][assembly: AssemblyInformationalVersion("${releaseVersion}")][assembly: AssemblyProduct("Foreign product")] class Program{static void Main(){}}`);
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  assert.equal(run(compiler, ['/nologo', '/target:winexe', '/out:' + join(foreign.root, 'CodexMobileConnector.exe'), foreignSource]).status, 0);
  const foreignHash = await digest(join(foreign.root, 'CodexMobileConnector.exe'));
  await repair(foreign, [], 1); assert.equal(await digest(join(foreign.root, 'CodexMobileConnector.exe')), foreignHash); await preserved(foreign); cases.push('foreign product with expected managed assembly filename/name refused');

  const committedGuard = await fixture('committed-guard'); await repair(committedGuard, ['--qa-upgrade-abort-committed'], 1);
  const unexpected = join(committedGuard.root + '.upgrade-backup', 'unexpected-user-file.txt'); await writeFile(unexpected, 'never-delete');
  assert.match(await repair(committedGuard, [], 1), /unexpected item/); assert.equal(await readFile(unexpected, 'utf8'), 'never-delete'); await preserved(committedGuard);
  await rm(unexpected);
  // Simulate a previous cleanup that removed its EXE/marker before interruption.
  await rm(join(committedGuard.root + '.upgrade-backup', 'CodexMobileConnector.exe'));
  await rm(join(committedGuard.root + '.upgrade-backup', 'installed.json'));
  await repair(committedGuard); await healthy(committedGuard); cases.push('committed unexpected backup file refused; partial committed cleanup retry completes');

  const linkedBackup = await fixture('linked-backup'); await repair(linkedBackup, ['--qa-upgrade-language-abort'], 1);
  const outside = join(base, 'outside-backup'); await mkdir(outside); const sentinel = join(outside, 'sentinel.txt'); await writeFile(sentinel, 'keep-outside');
  const junction = join(linkedBackup.root + '.upgrade-backup', 'scripts', 'nested-link'); await symlink(outside, junction, 'junction');
  assert.match(await repair(linkedBackup, [], 1), /backup is linked/); assert.equal(await readFile(sentinel, 'utf8'), 'keep-outside'); await preserved(linkedBackup);
  await rm(junction, { recursive: true }); await repair(linkedBackup); await healthy(linkedBackup); cases.push('nested inProgress backup junction refused before restoration; external bytes preserved');

  const changedBackup = await fixture('changed-backup'); await repair(changedBackup, ['--qa-upgrade-language-abort'], 1);
  const originalBackupExe = join(changedBackup.root + '.upgrade-backup', 'CodexMobileConnector.exe'); const savedBackup = await readFile(originalBackupExe);
  await writeFile(originalBackupExe, Buffer.concat([savedBackup, Buffer.from('changed-but-same-managed-metadata')]));
  assert.match(await repair(changedBackup, [], 1), /original executable changed/); await preserved(changedBackup);
  await writeFile(originalBackupExe, savedBackup); await repair(changedBackup); await healthy(changedBackup); cases.push('same-metadata original backup EXE hash drift refused before inProgress restore/restart');

  const active = await fixture('active-damaged');
  const stage = join(base, 'active-stage');
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  const extract = `Add-Type -AssemblyName System.IO.Compression;Add-Type -AssemblyName System.IO.Compression.FileSystem;$a=[Reflection.Assembly]::LoadFile(${literal(setup)});$s=$a.GetManifestResourceStream('payload.zip');$z=[IO.Compression.ZipArchive]::new($s);[IO.Directory]::CreateDirectory(${literal(stage)})|Out-Null;foreach($e in $z.Entries){$p=Join-Path ${literal(stage)} $e.FullName;[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p))|Out-Null;[IO.Compression.ZipFileExtensions]::ExtractToFile($e,$p,$true)};$z.Dispose();Copy-Item -LiteralPath ${literal(setup)} -Destination ${literal(join(stage, 'CodexMobileConnector.exe'))}`;
  assert.equal(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(extract, 'utf16le').toString('base64')]).status, 0);
  const loweredExe = join(stage, 'CodexMobileConnector.exe'); const newExe = await readFile(loweredExe);
  await copyFile(lower, loweredExe); await writeFile(guardExe, 'damaged owned executable');
  const lowerArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(stage, 'deploy/upgrade-connector.ps1'), '-Root', guard.root, '-Stage', stage, '-Version', '1.0.5', '-Repair'];
  const lowerResult = run('powershell.exe', lowerArgs); assert.equal(lowerResult.status, 1); assert.match(lowerResult.stderr, /newer than/); assert.equal(await readFile(guardExe, 'utf8'), 'damaged owned executable');
  await writeFile(guardExe, originalExe); await writeFile(loweredExe, newExe); cases.push('new helper refuses lower incoming version when owned EXE unreadable using marker version');
  const controlPath = join(active.root, '.local/connector-control.json'); const intent = JSON.parse(await readFile(controlPath, 'utf8')); Object.assign(intent, { paused: false, pauseScope: 'none', disconnectVerified: false }); await writeFile(controlPath, JSON.stringify(intent));
  for (const script of ['connector-login.mjs', 'start-connector.mjs']) await writeFile(join(active.root, 'scripts', script), "console.log('fixture-held');setInterval(()=>{},1000);\n");
  await writeFile(join(active.root, 'scripts/connector-gui.mjs'), 'broken old gui syntax (');
  const node = join(active.root, 'runtime/node.exe');
  let children = ['connector-login.mjs', 'start-connector.mjs'].map(script => spawn(node, [join(active.root, 'scripts', script)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  const ready = child => new Promise((yes, no) => { child.stdout.once('data', yes); child.once('error', no); });
  await Promise.all(children.map(ready));
  const helper = join(stage, 'deploy/upgrade-connector.ps1'); const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Root', active.root, '-Stage', stage, '-Version', releaseVersion, '-Repair'];
  try {
    assert.equal(run('powershell.exe', [...args, '-QaAbortAfterQuit']).status, 94);
    for (let attempt = 0; attempt < 50 && children.some(c => c.exitCode === null); attempt++) await new Promise(r => setTimeout(r, 100));
    assert.ok(children.every(c => c.exitCode !== null), 'staged quit did not stop the actual old-runtime watcher/daemon before PS fallback');
    assert.equal(await readFile(join(active.root, 'scripts/connector-gui.mjs'), 'utf8'), 'broken old gui syntax (');
    assert.deepEqual(JSON.parse(await readFile(controlPath, 'utf8')), intent);
    // Use a fixture-only reconnect receipt to avoid creating a live desktop bridge.
    const reconnect = join(base, 'reconnect-receipt.json');
    await writeFile(join(stage, 'scripts/connector-gui.mjs'), `import{writeFile}from'node:fs/promises';export async function guiCommand(q,d){if(q.action==='quit')return d.control.pause('session');return{recoveryCompleted:true}};if(process.argv[1]&&process.argv[1].endsWith('connector-gui.mjs')){let text='';for await(const c of process.stdin)text+=c;await writeFile(${JSON.stringify(reconnect)},JSON.stringify({root:${JSON.stringify(active.root)},request:JSON.parse(text)}));console.log(JSON.stringify({ok:true,recoveryCompleted:true}));}`);
    const recovered = run('powershell.exe', [...args, '-Recover']);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout || 'damaged old GUI trapped forward recovery');
    assert.deepEqual(JSON.parse(await readFile(reconnect, 'utf8')).request, { action: 'connect', reason: 'manual' });
    assert.deepEqual(JSON.parse(await readFile(controlPath, 'utf8')), intent);
    await absent(active.root + '.upgrade-journal.json'); assert.equal(await digest(join(active.root, 'CodexMobileConnector.exe')), await digest(setup));
    cases.push('actual old-runtime watcher/daemon stop verified before fallback/move; broken old GUI forward recovery restores active intent (reconnect receipt fixture)');
  } finally { for (const child of children) if (child.exitCode === null) child.kill(); }

  const stranger = join(base, 'stranger'); await mkdir(stranger); await writeFile(join(stranger, 'installed.json'), JSON.stringify({ root: stranger, version: 1 })); await writeFile(join(stranger, 'sentinel.txt'), 'foreign'); await repair({ root: stranger }, [], 1); assert.equal(await readFile(join(stranger, 'sentinel.txt'), 'utf8'), 'foreign'); cases.push('marker-only unknown root refused');
  const result = { passed: true, version: releaseVersion, cases, setupSha256: await digest(setup), legacySetupSha256: await digest(legacy), historicalSetupSha256: await digest(resolve('work/webview-0.1.5/CodexMobileConnector-Setup.exe')), fixtureBase: base, realInstallationChanged: false, osRegistrationsChanged: false };
  await writeFile(join(evidence, 'repair-evidence.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally { await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
