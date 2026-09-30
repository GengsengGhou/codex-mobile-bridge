import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';

if (process.platform !== 'win32') throw new Error('Windows upgrade verification requires Windows.');
const project = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1'));
const setup = resolve(process.argv[2] || join(project, 'dist/CodexMobileConnector-Setup.exe'));
const releaseVersion = JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version;
const oldSetups = process.argv.slice(3).map(path => resolve(path));
if (oldSetups.length === 0) throw new Error('Pass at least one authentic older Setup.exe as an argument.');
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const defaultRoot = join(process.env.LOCALAPPDATA, 'CodexMobileConnector');
const defaultFiles = [join(defaultRoot, 'CodexMobileConnector.exe'), join(defaultRoot, 'installed.json')];
const defaultBefore = await Promise.all(defaultFiles.map(file => digest(file).catch(() => null)));
const run = (file, args, timeout = 120000, env = process.env) => spawnSync(file, args, { windowsHide: true, encoding: 'utf8', timeout, env });
const wait = async (check, message, attempts = 100) => { for (let i = 0; i < attempts; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error(message); };
const psLiteral = value => "'" + value.replaceAll("'", "''") + "'";
const owned = (root, script) => {
  const path = join(root, script);
  const command = `$node=${psLiteral(join(root, 'runtime/node.exe'))};$script=${psLiteral(path)};@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq $node -and $_.CommandLine -like ('*'+$script+'*') }).Count`;
  const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], 15000);
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
};
const cases = [];

for (const oldSetup of oldSetups) {
  const oldHash = await digest(oldSetup);
  const fixture = await mkdtemp(join(tmpdir(), 'codex-upgrade-acceptance-'));
  const target = join(fixture, 'app');
  const exe = join(target, 'CodexMobileConnector.exe');
  const local = join(target, '.local');
  try {
    assert.equal(run(oldSetup, ['--install-root', target, '--install']).status, 0, 'Older package cold install failed');
    const uiEvidence = join(fixture, 'upgrade-ui.json');
    const window = spawn(setup, ['--install-root', target, '--qa-upgrade-evidence', uiEvidence], { windowsHide: true, stdio: 'ignore' });
    try { await wait(async () => { try { await access(uiEvidence); return true; } catch { return false; } }, 'Upgrade UI did not render');
      assert.equal(JSON.parse(await readFile(uiEvidence, 'utf8')).button, '升级');
    } finally { window.kill(); await new Promise(r => window.exitCode === null ? window.once('exit', r) : r()); }
    await mkdir(local, { recursive: true });
    const marker = join(local, 'preserved-fixture.txt');
    const control = join(local, 'connector-control.json');
    const originalData = 'pairing-and-data-preserved';
    await writeFile(marker, originalData);
    const paused = { version: 2, paused: true, pauseScope: 'persistent', pausedSession: null, autoStart: true, autoStartSelected: true, startupPending: false, bootstrapPending: false, revision: 'fixture', settingsRevision: 'fixture', disconnectVerified: true };
    await writeFile(control, JSON.stringify(paused));
    const setupResult = run(setup, ['--install-root', target, '--install']);
    assert.equal(setupResult.status, 0, setupResult.error?.message || await readFile(target + '.install-error.txt', 'utf8').catch(() => 'upgrade failed'));
    assert.equal(await digest(exe), await digest(setup));
    assert.equal(await readFile(marker, 'utf8'), originalData);
    assert.deepEqual(JSON.parse(await readFile(control, 'utf8')), paused);
    assert.deepEqual(JSON.parse(await readFile(join(target, 'installed.json'), 'utf8')), { root: target, version: 1 });
    await assert.rejects(access(target + '.upgrade-journal.json'));
    await assert.rejects(access(target + '.upgrade-backup'));
    cases.push({ fromSetupSha256: oldHash, upgradeUi: 'passed', pausedUpgrade: 'passed', preservedLocal: 'passed', installedVersion: releaseVersion });
  } finally {
    const uninstall = join(target, 'deploy/uninstall-connector.ps1');
    try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', target], 30000); } catch {}
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }

  const rollbackFixture = await mkdtemp(join(tmpdir(), 'codex-upgrade-rollback-'));
  const rollbackRoot = join(rollbackFixture, 'app');
  try {
    assert.equal(run(oldSetup, ['--install-root', rollbackRoot, '--install']).status, 0);
    const previousExe = join(rollbackRoot, 'CodexMobileConnector.exe');
    const previousHash = await digest(previousExe);
    const data = join(rollbackRoot, '.local/preserved-fixture.txt');
    await mkdir(join(rollbackRoot, '.local'), { recursive: true });
    await writeFile(data, 'never-delete-local-data');
    const failed = run(setup, ['--install-root', rollbackRoot, '--install', '--qa-upgrade-fail']);
    assert.equal(failed.status, 1, 'Injected partial copy unexpectedly succeeded');
    assert.equal(await digest(previousExe), previousHash, 'Old EXE was not restored');
    assert.equal(await readFile(data, 'utf8'), 'never-delete-local-data');
    cases.at(-1).partialCopyRollback = 'passed';
  } finally {
    const uninstall = join(rollbackRoot, 'deploy/uninstall-connector.ps1');
    try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', rollbackRoot], 30000); } catch {}
    await rm(rollbackFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

const interrupted = await mkdtemp(join(tmpdir(), 'codex-upgrade-interrupted-'));
const interruptedRoot = join(interrupted, 'app');
try {
  assert.equal(run(oldSetups[0], ['--install-root', interruptedRoot, '--install']).status, 0);
  await mkdir(join(interruptedRoot, '.local'), { recursive: true });
  await writeFile(join(interruptedRoot, '.local/sentinel.txt'), 'survives-interruption');
  const aborted = run(setup, ['--install-root', interruptedRoot, '--install', '--qa-upgrade-abort']);
  assert.equal(aborted.status, 1, 'QA interruption unexpectedly completed');
  await access(interruptedRoot + '.upgrade-journal.json');
  await access(interruptedRoot + '.upgrade-backup');
  const resumed = run(setup, ['--install-root', interruptedRoot, '--install']);
  assert.equal(resumed.status, 0, await readFile(interruptedRoot + '.install-error.txt', 'utf8').catch(() => resumed.stderr));
  assert.equal(await digest(join(interruptedRoot, 'CodexMobileConnector.exe')), await digest(setup));
  assert.equal(await readFile(join(interruptedRoot, '.local/sentinel.txt'), 'utf8'), 'survives-interruption');
  await assert.rejects(access(interruptedRoot + '.upgrade-journal.json'));
  await assert.rejects(access(interruptedRoot + '.upgrade-backup'));
  cases[0].interruptedTransactionRecovered = 'passed';
} finally {
  const uninstall = join(interruptedRoot, 'deploy/uninstall-connector.ps1');
  try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', interruptedRoot], 30000); } catch {}
  await rm(interrupted, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const committed = await mkdtemp(join(tmpdir(), 'codex-upgrade-committed-'));
const committedRoot = join(committed, 'app');
try {
  assert.equal(run(oldSetups[0], ['--install-root', committedRoot, '--install']).status, 0);
  const aborted = run(setup, ['--install-root', committedRoot, '--install', '--qa-upgrade-abort-committed']);
  assert.equal(aborted.status, 1);
  assert.equal(await digest(join(committedRoot, 'CodexMobileConnector.exe')), await digest(setup));
  const journal = JSON.parse(await readFile(committedRoot + '.upgrade-journal.json', 'utf8'));
  assert.equal(journal.phase, 'committed');
  assert.equal(run(setup, ['--install-root', committedRoot, '--install']).status, 0, 'Committed recovery should finish without a second upgrade');
  await assert.rejects(access(committedRoot + '.upgrade-journal.json'));
  await assert.rejects(access(committedRoot + '.upgrade-backup'));
  cases[0].committedInterruptionRecovered = 'passed';
} finally {
  const uninstall = join(committedRoot, 'deploy/uninstall-connector.ps1');
  try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', committedRoot], 30000); } catch {}
  await rm(committed, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const linked = await mkdtemp(join(tmpdir(), 'codex-upgrade-linked-'));
const linkedRoot = join(linked, 'app');
const linkedExternal = join(linked, 'external');
try {
  assert.equal(run(oldSetups[0], ['--install-root', linkedRoot, '--install']).status, 0);
  await mkdir(linkedExternal);
  await writeFile(join(linkedExternal, 'sentinel.txt'), 'outside-installation');
  const junction = join(linkedRoot, '.local');
  const create = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `New-Item -ItemType Junction -Path ${psLiteral(junction)} -Target ${psLiteral(linkedExternal)} | Out-Null`], 10000);
  assert.equal(create.status, 0, create.stderr);
  assert.equal(run(setup, ['--install-root', linkedRoot, '--install']).status, 1);
  assert.equal(await readFile(join(linkedExternal, 'sentinel.txt'), 'utf8'), 'outside-installation');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Remove-Item -LiteralPath ${psLiteral(junction)} -Force`], 10000);
  cases[0].linkedLocalRejected = 'passed';
} finally {
  const uninstall = join(linkedRoot, 'deploy/uninstall-connector.ps1');
  try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', linkedRoot], 30000); } catch {}
  await rm(linked, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

// A real v0.1.6 process owns the pre-upgrade WSS connection. The manual
// connection setting stays off, and the new watcher must still be relaunched.
const activeFixture = await mkdtemp(join(tmpdir(), 'codex-upgrade-active-'));
const activeRoot = join(activeFixture, 'app');
let bridge, hub, sockets, connector, watcher;
let wssConnections = 0;
let activePassed = false;
try {
  assert.equal(run(oldSetups[0], ['--install-root', activeRoot, '--install']).status, 0);
  const node = join(activeRoot, 'runtime/node.exe');
  const local = join(activeRoot, '.local');
  await mkdir(local, { recursive: true });
  const key = join(local, 'fixture.key'), cert = join(local, 'fixture.pem');
  await writeFile(join(local, 'openssl.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  const certificate = run('openssl', ['req', '-config', join(local, 'openssl.cnf'), '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], 20000);
  assert.equal(certificate.status, 0, certificate.stderr);
  bridge = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Set-Cookie': `bridge_session=${'a'.repeat(64)}; HttpOnly` }); res.end('<title>Codex 手机桥接</title>'); }
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ connected: true, mode: 'desktop-pipe', canSend: false, callerThreadId: '11111111-1111-4111-8111-111111111111', allowedSendThreadId: '11111111-1111-4111-8111-111111111111', sendScope: 'disabled' })); }
  });
  hub = https.createServer({ key: await readFile(key), cert: await readFile(cert) });
  sockets = new WebSocketServer({ server: hub });
  sockets.on('connection', () => { wssConnections++; });
  await new Promise(r => bridge.listen(0, '127.0.0.1', r));
  await new Promise(r => hub.listen(0, '127.0.0.1', r));
  const id = '11111111-1111-4111-8111-111111111111';
  const pair = { version: 1, hubOrigin: `https://127.0.0.1:${hub.address().port}`, deviceId: id, deviceToken: 'f'.repeat(43), bridgePort: bridge.address().port };
  await writeFile(join(local, 'hub-connector.json'), JSON.stringify(pair));
  await writeFile(join(local, 'runtime.json'), JSON.stringify({ callerThreadId: id, allowedSendThreadId: id, enableSend: false, sendScope: 'single', port: pair.bridgePort }));
  await writeFile(join(local, 'connector-login.json'), JSON.stringify({ version: 1, nodePath: node }));
  const intent = { version: 2, paused: false, pauseScope: 'none', pausedSession: null, autoStart: false, autoStartSelected: true, startupPending: false, bootstrapPending: false, revision: 'active-fixture', settingsRevision: 'active-fixture', disconnectVerified: false };
  await writeFile(join(local, 'connector-control.json'), JSON.stringify(intent));
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: cert };
  watcher = spawn(node, [join(activeRoot, 'scripts/connector-login.mjs')], { windowsHide: true, env, stdio: 'ignore' });
  connector = spawn(node, [join(activeRoot, 'scripts/start-connector.mjs')], { windowsHide: true, env, stdio: 'ignore' });
  await wait(() => sockets.clients.size > 0, 'Old connector did not come online over fixture WSS');
  assert.ok(owned(activeRoot, 'scripts/connector-login.mjs') > 0, 'Old watcher is missing');
  const oldHash = await digest(join(activeRoot, 'CodexMobileConnector.exe'));
  const failed = run(setup, ['--install-root', activeRoot, '--install', '--qa-upgrade-fail'], 120000, env);
  assert.equal(failed.status, 1, 'Active upgrade failure injection unexpectedly succeeded');
  assert.equal(await digest(join(activeRoot, 'CodexMobileConnector.exe')), oldHash);
  await wait(() => owned(activeRoot, 'scripts/connector-login.mjs') > 0, 'Rollback did not restore old watcher');
  await wait(() => owned(activeRoot, 'scripts/start-connector.mjs') > 0, 'Rollback watcher did not relaunch old connector', 300);
  connector = spawn(node, [join(activeRoot, 'scripts/start-connector.mjs')], { windowsHide: true, env, stdio: 'ignore' });
  await wait(() => wssConnections >= 2, 'Restored old connector could not reconnect using fixture CA');
  assert.equal(JSON.parse(await readFile(join(local, 'connector-control.json'), 'utf8')).autoStart, false);
  assert.equal(JSON.parse(await readFile(join(local, 'connector-control.json'), 'utf8')).paused, false);
  const upgraded = run(setup, ['--install-root', activeRoot, '--install'], 120000, env);
  assert.equal(upgraded.status, 0, await readFile(activeRoot + '.install-error.txt', 'utf8').catch(() => upgraded.stderr));
  assert.equal(await digest(join(activeRoot, 'CodexMobileConnector.exe')), await digest(setup));
  await wait(() => owned(activeRoot, 'scripts/connector-login.mjs') > 0, 'Upgrade did not restore manually connected watcher');
  await wait(() => owned(activeRoot, 'scripts/start-connector.mjs') > 0, 'Upgrade watcher did not relaunch connector', 300);
  connector = spawn(node, [join(activeRoot, 'scripts/start-connector.mjs')], { windowsHide: true, env, stdio: 'ignore' });
  await wait(() => wssConnections >= 3, 'Upgraded connector could not connect using fixture CA');
  const finalIntent = JSON.parse(await readFile(join(local, 'connector-control.json'), 'utf8'));
  assert.equal(finalIntent.autoStart, false);
  assert.equal(finalIntent.paused, false);
  assert.equal(bridge.listening, true, 'Independent bridge was stopped');
  cases[0].activeWssBeforeUpgrade = 'passed';
  cases[0].activeFailureRollback = 'passed';
  cases[0].watcherRelaunchedConnectorAfterRollbackAndUpgrade = 'passed';
  cases[0].fixtureCaWssAfterRollbackAndUpgrade = 'passed (direct connector with isolated CA; WMI environment has no fixture CA)';
  cases[0].manualConnectionAutoStartFalseRestored = 'passed';
  cases[0].independentBridgePreserved = 'passed';
  activePassed = true;
} finally {
  if (!activePassed) {
    for (const log of ['connector-login.stdout.log', 'connector-login.stderr.log', 'hub-connector.stderr.log']) {
      const detail = await readFile(join(activeRoot, '.local', log), 'utf8').catch(() => 'unavailable');
      console.error(`${log}: ${detail.slice(-1500)}`);
    }
    console.error(`WSS connections observed: ${wssConnections}`);
  }
  connector?.kill(); watcher?.kill();
  const uninstall = join(activeRoot, 'deploy/uninstall-connector.ps1');
  try { await access(uninstall); run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', uninstall, '-Root', activeRoot], 30000); } catch {}
  if (sockets) { for (const socket of sockets.clients) socket.terminate(); await new Promise(r => sockets.close(r)); }
  if (hub) await new Promise(r => hub.close(r));
  if (bridge) await new Promise(r => bridge.close(r));
  await rm(activeFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

const stranger = await mkdtemp(join(tmpdir(), 'codex-upgrade-stranger-'));
try {
  const sentinel = join(stranger, 'unrelated.txt');
  await writeFile(sentinel, 'do-not-overwrite');
  assert.equal(run(setup, ['--install-root', stranger, '--install']).status, 1);
  assert.equal(await readFile(sentinel, 'utf8'), 'do-not-overwrite');
  await writeFile(join(stranger, 'installed.json'), JSON.stringify({ root: stranger, version: 1 }));
  assert.equal(run(setup, ['--install-root', stranger, '--install']).status, 1);
  assert.equal(await readFile(sentinel, 'utf8'), 'do-not-overwrite');
} finally { await rm(stranger, { recursive: true, force: true }); }

const damaged = await mkdtemp(join(tmpdir(), 'codex-upgrade-damaged-'));
const damagedRoot = join(damaged, 'app');
try {
  assert.equal(run(oldSetups[0], ['--install-root', damagedRoot, '--install']).status, 0);
  const installedExe = join(damagedRoot, 'CodexMobileConnector.exe');
  const before = await digest(installedExe);
  await writeFile(join(damagedRoot, 'installed.json'), JSON.stringify({ root: join(damaged, 'somewhere-else'), version: 1 }));
  assert.equal(run(setup, ['--install-root', damagedRoot, '--install']).status, 1);
  assert.equal(await digest(installedExe), before);
} finally { await rm(damaged, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); }

const defaultAfter = await Promise.all(defaultFiles.map(file => digest(file).catch(() => null)));
assert.deepEqual(defaultAfter, defaultBefore, 'Default installation program or marker changed during isolated verification');
const evidence = { cases, strangerRejected: true, damagedOwnershipRejected: true, defaultInstallationProgramAndMarkerUnchanged: true, newSetupSha256: await digest(setup) };
await mkdir(join(project, 'work/verification'), { recursive: true });
await writeFile(join(project, 'work/verification/windows-upgrade-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence, null, 2));
