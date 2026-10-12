import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import TOML from '@iarna/toml';
import { resetCollaborationPairing } from '../scripts/collaboration-reset.mjs';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { createConnectorControl, connectorMayRun, stopOwnedConnectorProcesses } from '../scripts/connector-control.mjs';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { guiCommand } from '../scripts/connector-gui.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { writePrivate, readPrivate, withCollaborationLock, collaborationResetGeneration, collaborationResetPath } from '../scripts/collaboration-common.mjs';
import { ensureLocalBridge, probeLocalBridge } from '../scripts/bootstrap-bridge.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const evidence = resolve(repository, 'work/collaboration-reset-20261012');
const config = { version: 1, hubOrigin: 'https://fixture.invalid', deviceId: '11111111-1111-4111-8111-111111111111', deviceToken: 'x'.repeat(43), bridgePort: 4317 };
const policy = { version: 1, ...config, controlEnabled: true, receiveEnabled: true, requiresAuthorization: false, allowedDeviceIds: ['22222222-2222-4222-8222-222222222222'], allowedProjectRoots: ['C:/fixture-project'] };
const request = { action: 'reset-collaboration-pairing', confirm: true, expectedHubOrigin: config.hubOrigin, expectedDeviceId: config.deviceId };
const startup = { read: async () => ({ enabled: false }), set: async () => ({ enabled: false, conflict: false }) };
async function fixture(t, { payload = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'collaboration-reset-')); const children = [];
  t.after(async () => { for (const item of children) { item.child.kill(); await item.closed; } await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, '.local')); await mkdir(join(root, 'codex-home')); await mkdir(join(root, 'runtime')); await mkdir(join(root, 'scripts'));
  await writePrivate(join(root, 'installed.json'), { version: 1, root });
  await copyFile(process.execPath, join(root, 'runtime/node.exe'));
  await writePrivate(join(root, '.local/hub-connector.json'), config); await writePrivate(join(root, '.local/computer-collaboration.json'), policy);
  const codexHome = join(root, 'codex-home'), codexConfig = join(codexHome, 'config.toml');
  const unrelated = 'model="PRIVATE_PROVIDER_MODEL"\r\n[model_providers.keep]\r\napi_key="PRIVATE_PROVIDER_KEY"\r\n[mcp_servers.other]\r\ncommand="other-mcp"\r\nargs=["keep"]\r\n'; await writeFile(codexConfig, unrelated);
  for (const file of ['collaboration-outbox/receipt.json', 'collaboration-downloads/file.txt', 'uploads/file.txt', 'user-extra.json']) { await mkdir(join(root, '.local', file, '..'), { recursive: true }); await writeFile(join(root, '.local', file), 'PRESERVED_FIXTURE_BYTES'); }
  if (payload) {
    await cp(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true }); await cp(join(repository, 'src'), join(root, 'src'), { recursive: true }); await copyFile(join(repository, 'package.json'), join(root, 'package.json'));
    await cp(join(repository, 'node_modules/@iarna/toml'), join(root, 'node_modules/@iarna/toml'), { recursive: true });
  }
  const control = createConnectorControl({ root, registration: startup, bridgeRegistration: startup, session: async () => 'fixture-session', stop: async () => ({ stopped: true }) });
  return { root, codexHome, codexConfig, unrelated, control, children };
}
async function preserved(f) {
  for (const file of ['collaboration-outbox/receipt.json', 'collaboration-downloads/file.txt', 'uploads/file.txt', 'user-extra.json']) assert.equal(await readFile(join(f.root, '.local', file), 'utf8'), 'PRESERVED_FIXTURE_BYTES');
  assert.ok((await readFile(f.codexConfig, 'utf8')).includes(f.unrelated));
}
const absent = path => assert.rejects(readFile(path), error => error.code === 'ENOENT');
for (const corruption of ['invalid-json', 'null-fields', 'unpaired']) test(`explicit offline reset recovers ${corruption} and removes canonical tools despite damaged ledger`, async t => {
  const f = await fixture(t);
  await registerCollaboration({ root: f.root, codexHome: f.codexHome, enabled: true, nodePath: join(f.root, 'runtime/node.exe') });
  const previousBackup = join(f.root, '.local/collaboration-reset-config-backup.toml'); await writeFile(previousBackup, 'PRESERVED_USER_BACKUP_BYTES');
  await writeFile(f.codexConfig, (await readFile(f.codexConfig, 'utf8')) + `\n[mcp_servers.${collaborationServerName}.tools.collaboration_devices]\napproval_mode="approve"\noutput_token_limit=100\n`);
  for (const name of ['hub-connector-state.json', 'collaboration-registration.json', 'collaboration-registration-state.json', 'connector-control.json', 'connector-login.json', 'runtime.json', 'recovery.json', 'recovery-state.json', 'computer-collaboration.json']) await writeFile(join(f.root, '.local', name), corruption === 'invalid-json' ? '{broken' : 'null');
  if (corruption === 'unpaired') await rm(join(f.root, '.local/hub-connector.json'));
  else await writeFile(join(f.root, '.local/hub-connector.json'), corruption === 'invalid-json' ? '{broken' : '{"hubOrigin":null,"deviceId":null,"deviceToken":null}');
  const result = (await resetCollaborationPairing(request, { ...f })).reset;
  assert.equal(result.completed, true); assert.equal(result.partialFailure, false); assert.equal(result.registrationRemoved, true); assert.equal(result.pairingCleared, true); assert.equal(result.serverDeviceRecordRemoved, false);
  assert.equal(TOML.parse(await readFile(f.codexConfig, 'utf8')).mcp_servers[collaborationServerName], undefined);
  assert.equal(await readFile(previousBackup, 'utf8'), 'PRESERVED_USER_BACKUP_BYTES');
  for (const name of ['hub-connector.json', 'computer-collaboration.json', 'collaboration-registration.json', 'runtime.json', 'connector-login.json', 'recovery-state.json']) await absent(join(f.root, '.local', name));
  assert.equal((await f.control.read()).paused, true); assert.equal((await f.control.read()).autoStart, false); await absent(collaborationResetPath(f.root)); await preserved(f);
});
test('confirmation, expected identity and verified installation fail before changing files', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, '.local/hub-connector.json'));
  await assert.rejects(resetCollaborationPairing({ ...request, confirm: false }, f), error => error.code === 'COLLABORATION_RESET_CONFIRMATION_REQUIRED');
  await assert.rejects(resetCollaborationPairing({ ...request, expectedDeviceId: '22222222-2222-4222-8222-222222222222' }, f), error => error.code === 'COLLABORATION_BINDING_CHANGED');
  await rm(join(f.root, 'installed.json'));
  await assert.rejects(resetCollaborationPairing(request, f), error => error.code === 'COLLABORATION_RESET_INSTALLATION_UNVERIFIED');
  assert.deepEqual(await readFile(join(f.root, '.local/hub-connector.json')), before); await absent(collaborationResetPath(f.root));
});
test('external same-name registration stays byte-identical; partial reset blocks requests and can retry', async t => {
  const f = await fixture(t); const text = f.unrelated + `[mcp_servers.${collaborationServerName}]\ncommand="external-runtime"\nargs=["other-install/script.mjs"]\n`;
  await writeFile(f.codexConfig, text); await writeFile(join(f.root, '.local/collaboration-registration.json'), '{"configPath":"C:/never-follow-this/config.toml"}');
  const partial = (await resetCollaborationPairing(request, f)).reset; assert.equal(partial.completed, false); assert.equal(partial.partialFailure, true); assert.equal(partial.registrationPreserved, true); assert.equal(partial.pairingCleared, true); assert.equal(partial.code, 'MCP_RESET_REGISTRATION_UNVERIFIED'); assert.equal(await readFile(f.codexConfig, 'utf8'), text);
  assert.equal(await connectorMayRun(f.root), false);
  await assert.rejects(f.control.resume('manual'), error => error.code === 'COLLABORATION_RESET_PENDING');
  let network = 0; await assert.rejects(pairConnector({ configPath: join(f.root, '.local/hub-connector.json'), origin: config.hubOrigin, pairingCode: 'c'.repeat(43), fetchImpl: async () => { network++; throw new Error(); } }), error => error.code === 'COLLABORATION_RESET_PENDING'); assert.equal(network, 0);
  await assert.rejects(collaborationSettings({ action: 'save-collaboration' }, { root: f.root }), error => error.code === 'COLLABORATION_RESET_PENDING');
  await writeFile(f.codexConfig, f.unrelated); const retry = (await resetCollaborationPairing({ action: request.action, confirm: true }, f)).reset; assert.equal(retry.completed, true); await absent(collaborationResetPath(f.root)); await preserved(f);
});
test('stop failure leaves credentials intact and a persistent retry barrier', async t => {
  const f = await fixture(t), before = await readFile(join(f.root, '.local/hub-connector.json'));
  const control = createConnectorControl({ root: f.root, registration: startup, bridgeRegistration: startup, stop: async () => { throw new Error('isolated stop failure'); } });
  const result = (await resetCollaborationPairing(request, { ...f, control })).reset; assert.equal(result.completed, false); assert.equal(result.pairingCleared, false); assert.equal(result.partialFailure, true); assert.deepEqual(await readFile(join(f.root, '.local/hub-connector.json')), before); assert.equal(await connectorMayRun(f.root), false);
  assert.equal((await resetCollaborationPairing(request, f)).reset.completed, true);
});
test('pairing HTTP already in flight finishes before reset snapshots and cannot write after completed reset', async t => {
  const f = await fixture(t); let release, entered; const gate = new Promise(done => { release = done; }), inFlight = new Promise(done => { entered = done; });
  const pairing = pairConnector({ origin: config.hubOrigin, pairingCode: 'c'.repeat(43), configPath: join(f.root, '.local/hub-connector.json'), replace: true, fetchImpl: async () => { entered(); await gate; return { ok: true, json: async () => ({ deviceId: config.deviceId, deviceToken: 'y'.repeat(43) }) }; } });
  await inFlight; const resetting = resetCollaborationPairing(request, f); release(); await pairing; const result = await resetting; assert.equal(result.reset.completed, true); await absent(join(f.root, '.local/hub-connector.json')); await preserved(f);
});
test('queued old pair and save are rejected after reset generation changes', async t => {
  const f = await fixture(t); let queuedPair, queuedSave, calls = 0;
  await withCollaborationLock(join(f.root, '.local/collaboration-settings'), async () => {
    const generation = await collaborationResetGeneration(f.root);
    queuedPair = pairConnector({ origin: config.hubOrigin, pairingCode: 'c'.repeat(43), configPath: join(f.root, '.local/hub-connector.json'), replace: true, fetchImpl: async () => { calls++; throw new Error(); } });
    queuedSave = collaborationSettings({ action: 'save-collaboration', controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] }, { root: f.root });
    // Handle both rejections immediately: either mutex waiter can reject first.
    // Assertions below still inspect the original promises and error codes.
    queuedPair.catch(() => {}); queuedSave.catch(() => {});
    // Both API entry points capture the old epoch before waiting on the real mutex.
    await new Promise(done => setTimeout(done, 100)); await writePrivate(join(f.root, '.local/collaboration-reset-generation.json'), { version: 1, generation: '33333333-3333-4333-8333-333333333333' }); assert.notEqual(await collaborationResetGeneration(f.root), generation);
  });
  await assert.rejects(queuedPair, error => error.code === 'COLLABORATION_RESET_CHANGED'); await assert.rejects(queuedSave, error => error.code === 'COLLABORATION_RESET_CHANGED'); assert.equal(calls, 0);
});
test('actual native stop kills only owned MCP/bridge, frees its port, and fresh GUI pair/bootstrap succeeds', async t => {
  const f = await fixture(t, { payload: true });
  const serverScript = join(f.root, 'src/server.mjs'); await writeFile(serverScript, `import http from 'node:http';const s=http.createServer((q,r)=>{r.setHeader('Set-Cookie','bridge_session='+ 'a'.repeat(64)+'; Path=/');if(q.url==='/api/status'){r.setHeader('Content-Type','application/json');r.end(JSON.stringify({connected:true,mode:'desktop-pipe',canSend:true,callerThreadId:process.env.CODEX_THREAD_ID,sendScope:'all-local',allowedSendThreadId:process.env.CODEX_THREAD_ID}));}else r.end('<title>Codex Mobile Bridge</title>');});s.listen(Number(process.env.BRIDGE_PORT||4317),'127.0.0.1',()=>console.log(JSON.stringify({port:s.address().port})));`);
  async function launch(script, env = {}) { const child = spawn(join(f.root, 'runtime/node.exe'), [script], { env: { ...process.env, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); const closed = new Promise(done => child.once('close', done)); child.stderr.resume(); f.children.push({ child, closed }); return { child, closed }; }
  const oldBridge = await launch(serverScript, { CODEX_THREAD_ID: config.deviceId, BRIDGE_PORT: '4317' });
  await new Promise((done, reject) => { oldBridge.child.stdout.once('data', done); oldBridge.child.once('exit', () => reject(new Error('Isolated port 4317 fixture could not start; no foreign listener was stopped.'))); });
  await writePrivate(join(f.root, '.local/runtime.json'), { callerThreadId: config.deviceId, allowedSendThreadId: config.deviceId, enableSend: true, sendScope: 'single', port: 4317 });
  await registerCollaboration({ root: f.root, enabled: true, codexHome: f.codexHome, nodePath: join(f.root, 'runtime/node.exe') });
  const mcp = await launch(join(f.root, 'scripts/collaboration-mcp.mjs')); mcp.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n'); await new Promise(done => mcp.child.stdout.once('data', done));
  const foreignRoot = await mkdtemp(join(tmpdir(), 'collaboration-foreign-')); t.after(() => rm(foreignRoot, { recursive: true, force: true })); const foreignScript = join(foreignRoot, 'server.mjs'); await writeFile(foreignScript, 'setInterval(()=>{},1000);console.log("ready");'); const foreign = await launch(foreignScript); await new Promise(done => foreign.child.stdout.once('data', done));
  const control = createConnectorControl({ root: f.root, registration: startup, bridgeRegistration: startup, stop: options => stopOwnedConnectorProcesses({ ...options, nodePath: join(f.root, 'runtime/node.exe') }) });
  const reset = (await resetCollaborationPairing(request, { ...f, control })).reset; assert.equal(reset.completed, true); await oldBridge.closed; await mcp.closed; assert.equal(foreign.child.exitCode, null); await absent(join(f.root, '.local/runtime.json'));
  const configPath = join(f.root, '.local/hub-connector.json'), newId = '44444444-4444-4444-8444-444444444444';
  const paired = await guiCommand({ action: 'pair', origin: config.hubOrigin, code: 'c'.repeat(43), name: 'Fresh fixture' }, { root: f.root, configPath, control, pair: options => pairConnector({ ...options, fetchImpl: async () => ({ ok: true, json: async () => ({ deviceId: newId, deviceToken: 'z'.repeat(43) }) }) }), watch: async () => ({ pid: 0 }) });
  assert.equal(paired.recoveryCompleted, true); assert.equal((await readPrivate(configPath)).bridgePort, 4317); assert.equal((await readPrivate(join(f.root, '.local/connector-login.json'))).bootstrap, true);
  let freshBridge; const thread = '55555555-5555-4555-8555-555555555555';
  const ready = await ensureLocalBridge({ root: f.root, port: 4317, callerThreadId: thread, probe: probeLocalBridge, bridgeFactory: () => ({ capabilities: async () => ['list_threads', 'read_thread'], call: async () => ({ thread: { id: thread, kind: 'codex', hostId: 'local' } }) }), start: async ({ loadConfig }) => { const runtime = await loadConfig(); freshBridge = await launch(serverScript, { CODEX_THREAD_ID: runtime.callerThreadId, BRIDGE_PORT: String(runtime.port) }); await new Promise(done => freshBridge.child.stdout.once('data', done)); return { started: true }; } });
  assert.equal(ready.connected, true); const runtime = await readPrivate(join(f.root, '.local/runtime.json')); assert.equal(runtime.callerThreadId, thread); assert.equal(runtime.allowedSendThreadId, thread); assert.notEqual(runtime.callerThreadId, config.deviceId); await preserved(f);
  await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, 'native-stop-fresh-bootstrap.json'), JSON.stringify({ isolated: true, realNativeProcessUtility: true, ownedMcpExited: mcp.child.exitCode !== null, ownedBridgeExited: oldBridge.child.exitCode !== null, otherRootProcessPreserved: foreign.child.exitCode === null, oldPort: 4317, freshPairPort: 4317, actualPairPersistence: true, actualDeferredEnrollment: true, actualBootstrapRuntime: true, oldSendingIdentityNotReused: true, unrelatedFilesPreserved: true, realInstallationTouched: false }, null, 2));
});
