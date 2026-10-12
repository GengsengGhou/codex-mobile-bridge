import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, cp, copyFile, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writePrivate } from '../scripts/collaboration-common.mjs';
import { registerCollaboration } from '../scripts/collaboration-registration.mjs';
import { diagnoseCollaboration, readCollaborationDiagnostics } from '../scripts/collaboration-diagnostics.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { createServer } from 'node:http';

const repository = fileURLToPath(new URL('..', import.meta.url));
const config = { version: 1, hubOrigin: 'https://fixture.invalid', deviceId: '11111111-1111-4111-8111-111111111111', deviceToken: 'x'.repeat(43) };
const enabled = { version: 1, hubOrigin: config.hubOrigin, deviceId: config.deviceId, controlEnabled: true, receiveEnabled: false, requiresAuthorization: false, allowedDeviceIds: [], allowedProjectRoots: [] };
const ownedChildren = new Map();
async function fixture(t, { payload = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'collaboration-live-'));
  ownedChildren.set(root, []);
  t.after(async () => { for (const { child, exited } of ownedChildren.get(root) || []) { child.kill(); await exited; } ownedChildren.delete(root); await rm(root, { recursive: true, force: true }); });
  await mkdir(join(root, '.local'));
  await writePrivate(join(root, '.local/hub-connector.json'), config);
  await writePrivate(join(root, '.local/computer-collaboration.json'), enabled);
  if (payload) {
    await cp(join(repository, 'scripts'), join(root, 'scripts'), { recursive: true });
    await cp(join(repository, 'src'), join(root, 'src'), { recursive: true });
    await copyFile(join(repository, 'package.json'), join(root, 'package.json'));
    await cp(join(repository, 'node_modules/@iarna/toml'), join(root, 'node_modules/@iarna/toml'), { recursive: true });
    await mkdir(join(root, 'runtime')); await copyFile(process.execPath, join(root, 'runtime/node.exe'));
  }
  return root;
}
async function stdio(t, root, { entry = false, args, cwd } = {}) {
  const module = new URL('../scripts/collaboration-mcp.mjs', import.meta.url).href;
  const child = spawn(process.execPath, args || (entry ? [join(root, 'scripts/collaboration-mcp.mjs')] : ['--input-type=module', '-e', `import {serveMcp} from ${JSON.stringify(module)};serveMcp({root:${JSON.stringify(root)}});`]), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false, id = 0; const pending = new Map();
  child.stdin.on('error', () => {}); child.stderr.resume();
  const exited = new Promise(done => child.once('close', code => { closed = true; for (const resolveReply of pending.values()) resolveReply(null); pending.clear(); done(code); }));
  ownedChildren.get(root)?.push({ child, exited });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const value = JSON.parse(line); const reply = pending.get(value.id); if (reply) { pending.delete(value.id); reply(value); } });
  t.after(async () => { child.kill(); lines.close(); await exited; });
  const rpc = (method, params) => new Promise(done => {
    if (closed) return done(null); const requestId = ++id; const timer = setTimeout(() => { pending.delete(requestId); done(null); }, 4000);
    pending.set(requestId, value => { clearTimeout(timer); done(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
  assert.ok((await rpc('initialize', { protocolVersion: '2025-06-18' }))?.result);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  assert.equal((await rpc('tools/list'))?.result?.tools.length, 12);
  return { rpc, child, exited, get closed() { return closed; } };
}
const delay = () => new Promise(done => setTimeout(done, 1400));
async function privateSnapshot(root) {
  const result = {};
  for (const folder of ['.local', 'codex-home']) {
    async function visit(path) { for (const entry of await readdir(path, { withFileTypes: true })) { const file = join(path, entry.name); if (entry.isDirectory()) await visit(file); else result[file.slice(root.length + 1)] = createHash('sha256').update(await readFile(file)).digest('hex'); } }
    await visit(join(root, folder));
  }
  return result;
}

for (const savedRequiresAuthorization of [false, true]) test(`fresh MCP explains mismatched binding after lifecycle tick (saved requiresAuthorization=${savedRequiresAuthorization})`, async t => {
  const root = await fixture(t); await writePrivate(join(root, '.local/computer-collaboration.json'), { ...enabled, hubOrigin: 'https://previous.invalid', requiresAuthorization: savedRequiresAuthorization });
  const client = await stdio(t, root);
  const first = await client.rpc('tools/call', { name: 'collaboration_devices', arguments: {} });
  assert.equal(JSON.parse(first.result.content[0].text).code, 'COLLABORATION_BINDING_CHANGED');
  await delay(); assert.ok((await client.rpc('ping'))?.result, 'binding mismatch must remain explainable instead of closing transport');
  const second = await client.rpc('tools/call', { name: 'collaboration_devices', arguments: {} });
  assert.equal(JSON.parse(second.result.content[0].text).code, 'COLLABORATION_BINDING_CHANGED');
});
test('existing MCP survives binding change and recovers after explicit fresh grants', async t => {
  const root = await fixture(t), client = await stdio(t, root);
  await writePrivate(join(root, '.local/hub-connector.json'), { ...config, deviceId: '22222222-2222-4222-8222-222222222222' });
  await delay(); assert.ok((await client.rpc('ping'))?.result);
  assert.equal(JSON.parse((await client.rpc('tools/call', { name: 'collaboration_devices', arguments: {} })).result.content[0].text).code, 'COLLABORATION_BINDING_CHANGED');
  await writePrivate(join(root, '.local/hub-connector.json'), config); await writePrivate(join(root, '.local/computer-collaboration.json'), enabled);
  await delay(); assert.ok((await client.rpc('ping'))?.result);
});
for (const boundary of ['explicit-disable', 'pause', 'upgrade']) test(`MCP still closes for ${boundary}`, async t => {
  const root = await fixture(t), client = await stdio(t, root);
  if (boundary === 'explicit-disable') await writePrivate(join(root, '.local/computer-collaboration.json'), { ...enabled, controlEnabled: false });
  if (boundary === 'pause') await writePrivate(join(root, '.local/connector-control.json'), { version: 1, paused: true, pausedSession: 'fixture', autoStart: false, revision: 'fixture' });
  if (boundary === 'upgrade') { await writeFile(root + '.upgrade-journal.json', '{}'); t.after(() => rm(root + '.upgrade-journal.json', { force: true })); }
  await delay(); assert.equal(client.closed, true);
});
test('safe diagnostic uses actual registered stdio with delayed ping and excludes private values', async t => {
  const root = await fixture(t, { payload: true }), codexHome = join(root, 'codex-home'); await mkdir(codexHome);
  const codexConfig = join(codexHome, 'config.toml'); await writeFile(codexConfig, 'model="PRIVATE_MODEL_SENTINEL"\n[model_providers.private]\napi_key="PRIVATE_PROVIDER_SENTINEL"\n');
  await writePrivate(join(root, '.local/connector-control.json'), { version: 1, paused: false, autoStart: false, revision: 'PRIVATE_REVISION_SENTINEL' });
  await writePrivate(join(root, '.local/collaboration-registration-state.json'), { status: 'registered', message: 'PRIVATE_REGISTRATION_MESSAGE_SENTINEL' });
  await registerCollaboration({ root, enabled: true, codexHome, nodePath: join(root, 'runtime/node.exe') });
  const before = await readFile(codexConfig);
  const beforeSnapshot = await privateSnapshot(root);
  const preload = join(root, 'private-preload.mjs'); await writeFile(preload, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(join(root, 'preload-write.txt'))},'unexpected');console.log('PRIVATE_PRELOAD_SENTINEL');`);
  const oldOptions = process.env.NODE_OPTIONS, oldNodePath = process.env.NODE_PATH; let diagnostic;
  try { process.env.NODE_OPTIONS = '--import=' + pathToFileURL(preload).href; process.env.NODE_PATH = 'PRIVATE_NODE_PATH_SENTINEL'; diagnostic = await diagnoseCollaboration({ root, codexConfig }); }
  finally { if (oldOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = oldOptions; if (oldNodePath === undefined) delete process.env.NODE_PATH; else process.env.NODE_PATH = oldNodePath; }
  assert.deepEqual(await privateSnapshot(root), beforeSnapshot);
  const evidenceRoot = join(repository, 'work/collaboration-live-recovery-20261012'); await mkdir(evidenceRoot, { recursive: true });
  await writeFile(join(evidenceRoot, 'diagnostic-readonly-snapshot.json'), JSON.stringify({ fixtureOnly: true, productionPrivateFilesRead: false, comparedDirectories: ['.local', 'codex-home'], before: beforeSnapshot, after: await privateSnapshot(root), allFileBytesUnchanged: true }, null, 2));
  await assert.rejects(readFile(join(root, 'preload-write.txt')), error => error.code === 'ENOENT');
  assert.deepEqual(diagnostic.stdio.nodeStartupOverridesRemoved, { nodeOptions: true, nodePath: true });
  assert.equal(diagnostic.stdio.initialize, true); assert.equal(diagnostic.stdio.toolsList, true); assert.equal(diagnostic.stdio.delayedPing, true);
  assert.equal(diagnostic.stdio.toolCalls, 0); assert.equal(diagnostic.stdio.networkRequests, 0); assert.equal(diagnostic.collaboration.effectivePolicy.controlEnabled, true);
  const serialized = JSON.stringify(diagnostic); for (const secret of [config.deviceToken, config.deviceId, config.hubOrigin, 'PRIVATE_MODEL_SENTINEL', 'PRIVATE_PROVIDER_SENTINEL', 'PRIVATE_PRELOAD_SENTINEL', 'PRIVATE_NODE_PATH_SENTINEL', 'PRIVATE_REVISION_SENTINEL', 'PRIVATE_REGISTRATION_MESSAGE_SENTINEL']) assert.equal(serialized.includes(secret), false);
  assert.deepEqual(await readFile(codexConfig), before);
  const frozenScript = join(evidenceRoot, 'diagnose-collaboration.mjs'); assert.deepEqual(await readFile(frozenScript), await readFile(join(repository, 'scripts/collaboration-diagnostics.mjs')));
  const cli = spawn(join(root, 'runtime/node.exe'), [frozenScript, '--install-root', root, '--codex-config', codexConfig], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let cliOutput = ''; cli.stdout.on('data', chunk => { cliOutput += chunk; }); cli.stderr.resume();
  assert.equal(await new Promise(done => cli.once('close', done)), 0); const cliResult = JSON.parse(cliOutput); assert.equal(cliResult.stdio.delayedPing, true); assert.equal(cliResult.stdio.toolCount, 12); assert.deepEqual(await privateSnapshot(root), beforeSnapshot);
  for (const secret of [config.deviceToken, config.deviceId, config.hubOrigin, 'PRIVATE_MODEL_SENTINEL', 'PRIVATE_PROVIDER_SENTINEL']) assert.equal(cliOutput.includes(secret), false);
  await writePrivate(join(root, '.local/computer-collaboration.json'), { ...enabled, deviceId: '33333333-3333-4333-8333-333333333333' });
  const mismatch = await diagnoseCollaboration({ root, codexConfig }); assert.equal(mismatch.collaboration.binding.deviceIdMatches, false); assert.equal(mismatch.collaboration.effectivePolicy.requiresAuthorization, true); assert.equal(mismatch.stdio.delayedPing, true);
  const project = join(root, 'project.toml'); await writeFile(project, `[mcp_servers.codex_mobile_computer_collaboration]\ncommand="PRIVATE_COMMAND_SENTINEL"\nargs=["PRIVATE_ARGUMENT_SENTINEL"]\n[ mcp_servers.codex_mobile_computer_collaboration.env ]\nSECRET="PRIVATE_ENV_SENTINEL"\n`);
  const override = await diagnoseCollaboration({ root, codexConfig, projectConfig: project }); assert.equal(override.configuration.projectSameNameEntryPresent, true); assert.equal(override.stdio.attempted, false);
  for (const secret of ['PRIVATE_COMMAND_SENTINEL', 'PRIVATE_ARGUMENT_SENTINEL', 'PRIVATE_ENV_SENTINEL']) assert.equal(JSON.stringify(override).includes(secret), false);
  await writePrivate(join(root, '.local/connector-control.json'), { version: 1, paused: true, pausedSession: 'PRIVATE_SESSION_SENTINEL', revision: 'PRIVATE_REVISION_SENTINEL', autoStart: false });
  const paused = await readCollaborationDiagnostics({ root }); assert.equal(paused.connectorControl.mayRun, false); assert.equal(paused.connectorControl.paused, true); for (const secret of ['PRIVATE_SESSION_SENTINEL', 'PRIVATE_REVISION_SENTINEL']) assert.equal(JSON.stringify(paused).includes(secret), false);
  await writeFile(root + '.upgrade-journal.json', 'PRIVATE_UPGRADE_SENTINEL'); t.after(() => rm(root + '.upgrade-journal.json', { force: true }));
  const upgrading = await readCollaborationDiagnostics({ root }); assert.equal(upgrading.upgradeJournalPresent, true); assert.equal(JSON.stringify(upgrading).includes('PRIVATE_UPGRADE_SENTINEL'), false);
});
test('settings refuses stale expected identity before network, registration, or policy writes', async t => {
  const root = await fixture(t); const path = join(root, '.local/computer-collaboration.json'), before = await readFile(path); let called = false;
  await assert.rejects(collaborationSettings({ action: 'save-collaboration', controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [], expectedHubOrigin: config.hubOrigin, expectedDeviceId: '22222222-2222-4222-8222-222222222222' }, { root, fetchImpl: () => { called = true; throw new Error(); }, bridge: () => { called = true; throw new Error(); }, register: () => { called = true; throw new Error(); } }), error => error.code === 'COLLABORATION_BINDING_CHANGED');
  assert.equal(called, false); assert.deepEqual(await readFile(path), before);
});
test('retained local policy plus actual re-pair, real registration and fresh MCP returns current Hub devices', async t => {
  const root = await fixture(t, { payload: true }), codexHome = join(root, 'codex-home'); await mkdir(codexHome); await writeFile(join(codexHome, 'config.toml'), 'model="retained-local-fixture"\n');
  const newId = '44444444-4444-4444-8444-444444444444'; let reads = 0;
  const hub = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/hub/connect') response.end(JSON.stringify({ deviceId: newId, deviceToken: 'y'.repeat(43) }));
    else if (request.url === '/api/hub/collaboration/devices') { reads++; response.end(JSON.stringify({ version: 1, sourceDeviceId: newId, devices: [] })); }
    else { response.statusCode = 404; response.end('{}'); }
  });
  await new Promise(done => hub.listen(0, '127.0.0.1', done)); t.after(() => new Promise(done => { hub.closeAllConnections(); hub.close(done); }));
  const origin = `http://127.0.0.1:${hub.address().port}`, pairingPath = join(root, '.local/hub-connector.json');
  const paired = await pairConnector({ origin, pairingCode: 'c'.repeat(43), configPath: pairingPath, replace: true, allowInsecureLocal: true });
  assert.equal(paired.collaborationReauthorizationRequired, true);
  const afterPair = await readCollaborationDiagnostics({ root }); assert.equal(afterPair.binding.deviceIdMatches, true); assert.equal(afterPair.binding.hubOriginMatches, true); assert.equal(afterPair.effectivePolicy.requiresAuthorization, true); assert.equal(afterPair.savedPolicy.controlEnabled, false);
  // Insecure loopback is confined to the isolated actual Hub fixture.
  const current = JSON.parse(await readFile(pairingPath, 'utf8')); await writePrivate(pairingPath, { ...current, allowInsecureLocal: true });
  const saved = await collaborationSettings({ action: 'save-collaboration', controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [], expectedHubOrigin: origin, expectedDeviceId: newId }, { root, codexHome, nodePath: join(root, 'runtime/node.exe'), bridge: async () => ({ projects: [] }) });
  assert.equal(saved.collaboration.requiresAuthorization, false); assert.equal(saved.collaboration.controlEnabled, true);
  const afterSave = await readCollaborationDiagnostics({ root }); assert.equal(afterSave.binding.deviceIdMatches, true); assert.equal(afterSave.binding.hubOriginMatches, true); assert.equal(afterSave.effectivePolicy.controlEnabled, true);
  const client = await stdio(t, root, { entry: true }); await delay(); assert.ok((await client.rpc('ping'))?.result);
  const devices = await client.rpc('tools/call', { name: 'collaboration_devices', arguments: {} }); assert.equal(devices.result.isError, undefined); assert.deepEqual(JSON.parse(devices.result.content[0].text).devices, []); assert.ok(reads >= 2);
});
test('actual absolute and relative Windows entry paths initialize from independent cwd', async t => {
  const root = await fixture(t, { payload: true });
  const absolute = await stdio(t, root, { args: [join(root, 'scripts/collaboration-mcp.mjs')], cwd: tmpdir() }); await delay(); assert.ok((await absolute.rpc('ping'))?.result);
  const relative = await stdio(t, root, { args: ['scripts/collaboration-mcp.mjs'], cwd: root }); await delay(); assert.ok((await relative.rpc('ping'))?.result);
  const urlChild = spawn(process.execPath, [pathToFileURL(join(root, 'scripts/collaboration-mcp.mjs')).href], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; urlChild.stdout.on('data', chunk => { output += chunk; }); urlChild.stderr.resume();
  assert.notEqual(await new Promise(done => urlChild.once('close', done)), 0); assert.equal(output, '', 'Node CLI does not accept a file URL in the path argument; registration must retain ordinary absolute paths');
});
