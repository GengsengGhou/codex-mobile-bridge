import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import TOML from '@iarna/toml';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { installCollaborationLauncher, readCollaborationLaunch, collaborationLauncherDirectory, removeCollaborationLauncher } from '../scripts/collaboration-launcher.mjs';
import { diagnoseRegistration } from '../scripts/collaboration-diagnostics.mjs';
import { prepareCollaborationCompatibility } from '../scripts/collaboration-compatibility.mjs';
import { disableCollaborationForUninstall } from '../scripts/collaboration-lifecycle.mjs';

let binary;
async function fixture(t) {
  const parent = resolve('work/msix-compatibility/implementation'); await mkdir(parent, { recursive: true });
  if (!binary) { binary = resolve(parent, 'test-CollaborationLauncher.exe'); execFileSync(resolve(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/out:' + binary, resolve('deploy/windows/DesktopContext.cs'), resolve('deploy/windows/CollaborationLauncher.cs')]); }
  const root = await mkdtemp(resolve(parent, 'fixture-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'runtime')); await copyFile(binary, resolve(root, 'runtime/CollaborationLauncher.exe')); await copyFile(process.execPath, resolve(root, 'runtime/node.exe'));
  const codexHome = resolve(root, 'codex-home'); await mkdir(codexHome); const config = resolve(codexHome, 'config.toml'); await writeFile(config, '# provider untouched\r\nmodel="fixture"\r\n');
  return { root, codexHome, config };
}
const windows = { skip: process.platform !== 'win32' };
test('launcher lives outside redirected AppData and is isolated by install root', windows, () => {
  const options = { profile: 'C:/Users/fixture', localAppData: 'C:/Users/fixture/AppData/Local' };
  const one = collaborationLauncherDirectory('C:/Users/fixture/AppData/Local/CodexMobileConnector', options), two = collaborationLauncherDirectory('C:/Users/fixture/AppData/Local/other', options);
  assert.match(one, /\.codex-mobile-bridge\\launchers\\[a-f0-9]{24}$/); assert.notEqual(one, two); assert.doesNotMatch(one, /AppData/);
});
test('fresh preparation creates no pairing, grants or Codex registration; foreign files are preserved', windows, async t => {
  const f = await fixture(t), original = await readFile(f.config);
  const result = await prepareCollaborationCompatibility(f); assert.equal(result.registrationUpdated, false); assert.deepEqual(await readFile(f.config), original);
  assert.deepEqual((await readdir(resolve(f.root, '.local'))).sort(), ['collaboration-launcher.json', 'collaboration-launchers']);
  const launch = await readCollaborationLaunch(f.root); assert.equal(launch.command.startsWith(f.root), true); assert.deepEqual(launch.args, ['--install-root', f.root]);
  await writeFile(resolve(f.root, '.local/collaboration-launchers/owner.json'), JSON.stringify({ version: 1, application: 'foreign', root: f.root }));
  const before = await readFile(launch.command); await assert.rejects(installCollaborationLauncher(f), error => error.code === 'COLLABORATION_LAUNCHER_UNSAFE'); assert.deepEqual(await readFile(launch.command), before);
});
test('owned old registration upgrades and repeated repair preserves tools, options, grants and unrelated TOML bytes', windows, async t => {
  const f = await fixture(t); await registerCollaboration({ ...f, enabled: true });
  const toolBytes = '[mcp_servers.codex_mobile_computer_collaboration.tools.collaboration_devices]\r\napproval_mode = "approve" # keep my preference\r\noutput_token_limit = 512\r\n';
  const old = (await readFile(f.config, 'utf8')).replace('command = ', 'enabled = false\r\nstartup_timeout_sec = 27\r\ntool_timeout_sec = 80\r\nenabled_tools = ["collaboration_devices"]\r\ncommand = ') + toolBytes;
  await writeFile(f.config, old);
  for (const [name, value] of [['hub-connector.json', { deviceId: 'new-real', deviceToken: 'f'.repeat(43) }], ['computer-collaboration.json', { controlEnabled: true, receiveEnabled: true, allowedDeviceIds: ['fixture-peer'], allowedProjectRoots: [f.root] }], ['connector-control.json', { paused: true }]]) await writeFile(resolve(f.root, '.local', name), JSON.stringify(value));
  const grants = await Promise.all(['hub-connector.json', 'computer-collaboration.json', 'connector-control.json'].map(name => readFile(resolve(f.root, '.local', name))));
  await prepareCollaborationCompatibility(f); const changed = await readFile(f.config, 'utf8'), current = TOML.parse(changed).mcp_servers[collaborationServerName];
  assert.equal(changed.startsWith('# provider untouched\r\nmodel="fixture"\r\n'), true); assert.equal(changed.endsWith(toolBytes), true); assert.equal(current.enabled, false); assert.equal(current.startup_timeout_sec, 27); assert.equal(current.tool_timeout_sec, 80); assert.deepEqual(current.enabled_tools, ['collaboration_devices']); assert.match(current.command, /CollaborationLauncher-[a-f0-9]{64}\.exe$/); assert.deepEqual(current.args, ['--install-root', f.root]);
  await prepareCollaborationCompatibility(f); assert.equal(await readFile(f.config, 'utf8'), changed);
  const preferencesChanged = changed.replace('enabled = false', 'enabled = true').replace('startup_timeout_sec = 27', 'startup_timeout_sec = 30'); await writeFile(f.config, preferencesChanged);
  await prepareCollaborationCompatibility(f); assert.equal(await readFile(f.config, 'utf8'), preferencesChanged);
  assert.deepEqual(await Promise.all(['hub-connector.json', 'computer-collaboration.json', 'connector-control.json'].map(name => readFile(resolve(f.root, '.local', name)))), grants);
});
test('interrupted launch migration restores old ownership before safely retrying', windows, async t => {
  const f = await fixture(t); await registerCollaboration({ ...f, enabled: true }); const oldLedger = await readFile(resolve(f.root, '.local/collaboration-registration.json'));
  await installCollaborationLauncher(f);
  await assert.rejects(registerCollaboration({ ...f, enabled: true, upgradeLaunch: true, beforeReplace: () => { throw new Error('fixture interrupted'); } }), /fixture interrupted/);
  const pending = JSON.parse(await readFile(resolve(f.root, '.local/collaboration-registration.json'))); assert.equal(pending.pending, true); assert.deepEqual(pending.previousLedger, JSON.parse(oldLedger));
  await registerCollaboration({ ...f, enabled: true, upgradeLaunch: true }); assert.match(TOML.parse(await readFile(f.config, 'utf8')).mcp_servers[collaborationServerName].command, /CollaborationLauncher-[a-f0-9]{64}\.exe$/);
});
test('native launcher keeps stdio bytes separate, survives delayed input, closes on EOF and carries child exit code', windows, async t => {
  const f = await fixture(t); await mkdir(resolve(f.root, 'scripts'));
  await writeFile(resolve(f.root, 'scripts/collaboration-mcp.mjs'), 'process.stderr.write("fixture stderr\\n");process.stdin.pipe(process.stdout);process.stdin.on("end",()=>{process.exitCode=23});');
  const launch = await installCollaborationLauncher(f), child = spawn(launch.command, launch.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const ended = new Promise((yes, no) => { child.on('error', no); child.on('close', yes); });
  child.stdin.write('first\r\n'); await new Promise(done => setTimeout(done, 1400)); child.stdin.end('delayed\n');
  assert.equal(await ended, 23); assert.equal(stdout, 'first\r\ndelayed\n'); assert.equal(stderr, 'fixture stderr\n');
});
test('live launcher repair uses immutable new executable and migrates registration while old transport continues', windows, async t => {
  const f = await fixture(t); await mkdir(resolve(f.root, 'scripts')); await writeFile(resolve(f.root, 'scripts/collaboration-mcp.mjs'), 'process.stdin.pipe(process.stdout);');
  await registerCollaboration({ ...f, enabled: true }); await prepareCollaborationCompatibility(f); const old = await readCollaborationLaunch(f.root);
  const child = spawn(old.command, old.args, { windowsHide: true }); t.after(() => child.kill());
  const output = []; child.stdout.on('data', bytes => output.push(bytes.toString())); const ended = new Promise(done => child.once('close', done));
  child.stdin.write('before\n'); await new Promise(done => setTimeout(done, 200));
  const source = resolve(f.root, 'runtime/CollaborationLauncher.exe'); await writeFile(source, Buffer.concat([await readFile(source), Buffer.from('fixture-build-two')]));
  await prepareCollaborationCompatibility(f); const next = await readCollaborationLaunch(f.root); assert.notEqual(next.command, old.command); await readFile(old.command);
  assert.equal(TOML.parse(await readFile(f.config, 'utf8')).mcp_servers[collaborationServerName].command, next.command);
  const diagnostic = await diagnoseRegistration({ root: f.root, codexConfig: f.config }); assert.equal(diagnostic.registration.sharedStateLauncher, true); assert.equal(diagnostic.registration.status, 'owned-current-installation');
  child.stdin.end('after\n'); assert.equal(await ended, 0); assert.equal(output.join(''), 'before\nafter\n');
  await writeFile(resolve(f.root, '.local/collaboration-launchers/unrelated.txt'), 'keep'); await removeCollaborationLauncher(f.root);
  assert.equal(await readFile(resolve(f.root, '.local/collaboration-launchers/unrelated.txt'), 'utf8'), 'keep'); await assert.rejects(readFile(next.command), error => error.code === 'ENOENT');
});
test('repair does not recreate a registration removed by the user or follow a forged ledger home', windows, async t => {
  const f = await fixture(t); await registerCollaboration({ ...f, enabled: true }); await writeFile(f.config, '# deliberately removed\n');
  assert.equal((await prepareCollaborationCompatibility(f)).registrationRemoved, true); assert.equal(await readFile(f.config, 'utf8'), '# deliberately removed\n');
  const ledger = JSON.parse(await readFile(resolve(f.root, '.local/collaboration-registration.json'))); await writeFile(resolve(f.root, '.local/collaboration-registration.json'), JSON.stringify({ ...ledger, configPath: resolve(f.root, 'foreign/config.toml') }));
  await assert.rejects(prepareCollaborationCompatibility(f), error => error.code === 'MCP_REGISTRATION_RECOVERY_REQUIRED'); assert.equal(await readFile(f.config, 'utf8'), '# deliberately removed\n');
});
test('killing native launcher closes its owned job and reaps the Node child', windows, async t => {
  const f = await fixture(t); await mkdir(resolve(f.root, 'scripts')); await writeFile(resolve(f.root, 'scripts/collaboration-mcp.mjs'), 'console.log(process.pid);setInterval(()=>{},1000);');
  const launch = await installCollaborationLauncher(f), child = spawn(launch.command, launch.args, { windowsHide: true }); t.after(() => child.kill());
  const pid = Number(await new Promise((yes, no) => { child.stdout.once('data', bytes => yes(bytes.toString().trim())); child.once('error', no); }));
  assert.equal(Number.isInteger(pid), true); const closed = new Promise(done => child.once('close', done)); child.kill(); await closed;
  await new Promise(done => setTimeout(done, 300)); assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
});
test('uninstall with retained tools then different-build reinstall repairs a missing old launcher without accepting corruption', windows, async t => {
  const f = await fixture(t); await registerCollaboration({ ...f, enabled: true }); await prepareCollaborationCompatibility(f);
  const old = await readCollaborationLaunch(f.root), preference = '[mcp_servers.codex_mobile_computer_collaboration.tools.collaboration_devices]\napproval_mode="approve"\n'; await writeFile(f.config, (await readFile(f.config, 'utf8')) + preference);
  assert.equal((await disableCollaborationForUninstall({ root: f.root })).configurationPreserved, true); await removeCollaborationLauncher(f.root);
  const source = resolve(f.root, 'runtime/CollaborationLauncher.exe'); await writeFile(source, Buffer.concat([await readFile(source), Buffer.from('fixture-reinstall-different-build')]));
  await prepareCollaborationCompatibility(f); const current = await readCollaborationLaunch(f.root); assert.notEqual(current.command, old.command); assert.equal((await readFile(f.config, 'utf8')).endsWith(preference), true);
  await writeFile(current.command, 'corrupted-existing-launcher');
  await assert.rejects(prepareCollaborationCompatibility(f), error => error.code === 'COLLABORATION_LAUNCHER_UNSAFE'); assert.equal((await readFile(f.config, 'utf8')).endsWith(preference), true);
});
