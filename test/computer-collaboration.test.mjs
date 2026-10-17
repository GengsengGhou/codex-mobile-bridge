import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import TOML from '@iarna/toml';
import { HubStore } from '../hub/store.mjs';
import { createHubServer } from '../hub/server.mjs';
import { startConnector } from '../hub/connector.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { createCollaborationGuard } from '../src/collaboration-guard.mjs';
import { CreationStore } from '../src/creation-store.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { createCollaborationExecutor } from '../scripts/collaboration-executor.mjs';
import { createCollaborationClient, hubCollaboration } from '../scripts/collaboration-client.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { registerCollaboration, collaborationServerName } from '../scripts/collaboration-registration.mjs';
import { localBridge, readPrivate, writePrivate, withCollaborationLock } from '../scripts/collaboration-common.mjs';
import { disableCollaborationForUninstall } from '../scripts/collaboration-lifecycle.mjs';
const base = fileURLToPath(new URL('../work/computer-collaboration/', import.meta.url));
const checks = [];
const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
const evidence = async () => { await mkdir(base, { recursive: true }); await writePrivate(resolve(base, 'evidence.json'), { version: packageVersion, executedAt: new Date().toISOString(), mode: 'isolated local dual connectors with native desktop fixtures', checks, realPhysicalComputersTested: false, productionConfigTouched: false, published: false }); };
async function fixtureRoot(name) { await mkdir(base, { recursive: true }); return mkdtemp(resolve(base, name + '-')); }
async function listen(server) { await new Promise(yes => server.listen(0, '127.0.0.1', yes)); return server.address().port; }
async function close(server) { server.closeAllConnections?.(); await new Promise(yes => server.close(yes)); }
function desktop(root, label) {
  const projectId = randomUUID(), first = randomUUID(); const threads = new Map(); const counts = { creates: 0, sends: 0, stops: 0 };
  const project = { projectId, label, path: resolve(root, 'project'), hostId: 'local', isGitRepository: false };
  threads.set(first, { id: first, title: label, kind: 'codex', hostId: 'local', cwd: project.path, projectId, status: 'idle', archived: false });
  const bridge = {
    callerThreadId: first,
    capabilities: async () => ['list_threads', 'read_thread', 'create_thread', 'list_projects', 'send_message_to_thread'],
    projects: async () => [project], list: async () => ({ threads: [...threads.values()] }),
    read: async id => { if (!threads.has(id)) throw Object.assign(new Error('Missing task'), { code: 'NOT_FOUND', status: 404 }); return { thread: { ...threads.get(id) }, turns: [{ role: 'assistant', text: 'Result from ' + label }] }; },
    readMetadata: async id => ({ thread: { ...threads.get(id) } }),
    create: async (args, { beforeDispatch }) => { await beforeDispatch(); counts.creates++; const id = randomUUID(); threads.set(id, { ...threads.get(first), id, title: args.title || args.prompt }); return { threadId: id, hostId: 'local' }; },
    send: async (id, prompt) => { counts.sends++; threads.get(id).lastPrompt = prompt; },
  };
  const control = {
    snapshot: async id => ({ threadId: id, currentTurnId: threads.get(id).turnId || null, pendingRequests: threads.get(id).pending ? [{ type: 'approval', requestId: 'approval-1', attemptId: randomUUID(), fingerprint: 'a'.repeat(64), title: 'Approve?' }] : [] }),
    stop: async (id, turnId) => { assert.equal(threads.get(id).turnId, turnId); counts.stops++; delete threads.get(id).turnId; return { stopped: true }; },
  };
  return { bridge, control, counts, project, threads, first };
}
async function dual(t) {
  const root = await fixtureRoot('dual'); const store = new HubStore();
  const owner = store.createUser({ name: 'owner', salt: 'fake', hash: 'fake', role: 'admin', initialAdmin: true });
  const stranger = store.createUser({ name: 'stranger', salt: 'fake', hash: 'fake', invite: store.invite(owner.id).invite });
  const hub = createHubServer({ store, allowInsecureLocal: true }); const origin = `http://127.0.0.1:${await listen(hub)}`;
  const endpoints = [];
  for (const name of ['A', 'B']) {
    const localRoot = resolve(root, name); await mkdir(resolve(localRoot, '.local'), { recursive: true }); await mkdir(resolve(localRoot, 'project'));
    const d = desktop(localRoot, name); const server = createBridgeServer({ bridge: d.bridge, control: d.control, enableSend: true, sendScope: 'all-local', creationStore: new CreationStore({ path: resolve(localRoot, '.local/creations.json') }), deliveryStore: new DeliveryStore({ path: resolve(localRoot, '.local/deliveries.json') }), collaborationGuard: createCollaborationGuard({ root: localRoot }) });
    const config = { version: 1, ...store.consumePairing(store.pairing(owner.id, name).pairingCode), hubOrigin: origin, bridgePort: await listen(server), allowInsecureLocal: true };
    await writePrivate(resolve(localRoot, '.local/hub-connector.json'), config);
    const connector = startConnector({ ...config, collaborationExecutor: createCollaborationExecutor({ root: localRoot, config }) });
    endpoints.push({ root: localRoot, config, server, connector, ...d });
  }
  const [A, B] = endpoints;
  for (const [local, other] of [[A, B], [B, A]]) await writePrivate(resolve(local.root, '.local/computer-collaboration.json'), { version: 1, hubOrigin: origin, deviceId: local.config.deviceId, controlEnabled: true, receiveEnabled: true, allowedDeviceIds: [other.config.deviceId], allowedProjectRoots: [local.project.path] });
  const deadline = Date.now() + 5000;
  while (!endpoints.every(e => e.connector.status().connected)) { if (Date.now() > deadline) throw new Error('Connectors did not connect'); await new Promise(yes => setTimeout(yes, 25)); }
  t.after(async () => { endpoints.forEach(e => e.connector.stop()); hub.relay.close(); await Promise.all(endpoints.map(e => close(e.server))); await close(hub); store.close(); });
  return { A, B, origin, store, owner, stranger, root, hub };
}
test('real Hub + dual connectors + MCP stdio: authorized native tasks, durable receipts, revocation and files', async t => {
  const f = await dual(t), { A, B } = f; const clientA = createCollaborationClient({ root: A.root }), clientB = createCollaborationClient({ root: B.root });
  assert.deepEqual((await clientA.devices()).devices.map(d => d.id), [B.config.deviceId]);
  assert.deepEqual((await clientB.devices()).devices.map(d => d.id), [A.config.deviceId]);
  const projects = await clientA.call(B.config.deviceId, { operation: 'projects' }); assert.equal(projects.projects[0].projectId, B.project.projectId);
  const operationId = randomUUID(), request = { operation: 'create', operationId, projectId: B.project.projectId, prompt: 'Fixture task B', title: 'Fixture native task' };
  const created = await clientA.call(B.config.deviceId, request); assert.equal(created.state, 'created'); assert.equal(B.counts.creates, 1);
  const id = created.receipt.threadId;
  assert.equal((await clientA.call(B.config.deviceId, request)).receipt.threadId, id); assert.equal(B.counts.creates, 1);
  await assert.rejects(clientA.call(B.config.deviceId, { ...request, prompt: 'changed' }), e => e.code === 'OPERATION_CONFLICT');
  const send = { operation: 'send', operationId: randomUUID(), threadId: id, prompt: 'Continue fixture' };
  assert.equal((await clientA.call(B.config.deviceId, send)).state, 'accepted');
  await clientA.call(B.config.deviceId, send); assert.equal(B.counts.sends, 1);
  const chinese = await clientA.call(B.config.deviceId, { operation: 'create', operationId: randomUUID(), projectId: B.project.projectId, prompt: '中'.repeat(12000), title: 'Long Chinese prompt fixture' }); assert.equal(chinese.state, 'created');
  B.threads.get(id).turnId = 'turn-1'; B.threads.get(id).status = 'running';
  const timed = await clientA.wait(B.config.deviceId, id, { timeoutMs: 0 }); assert.equal(timed.timedOut, true);
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'stop', threadId: id, turnId: 'stale-run' }), e => e.code === 'RUN_CHANGED'); assert.equal(B.counts.stops, 0);
  assert.equal((await clientA.call(B.config.deviceId, { operation: 'stop', threadId: id, turnId: 'turn-1' })).stopped, true);
  assert.equal((await clientA.wait(B.config.deviceId, id, { timeoutMs: 0 })).timedOut, false);
  B.threads.get(id).pending = true;
  assert.equal((await clientA.call(B.config.deviceId, { operation: 'status', threadId: id })).needsAttention, true);
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'respond', threadId: id }), e => e.code === 'INVALID_COLLABORATION_REQUEST');
  await writeFile(resolve(B.project.path, 'result.txt'), 'fixture artifact');
  const download = await clientA.download(B.config.deviceId, id, 'result.txt'); assert.equal(await readFile(download.localPath, 'utf8'), 'fixture artifact'); assert.ok(download.localPath.startsWith(resolve(A.root, '.local/collaboration-downloads')));
  for (const path of ['../outside.txt', '/absolute.txt', 'C:/outside.txt', '.env', '..\\outside.txt']) await assert.rejects(clientA.call(B.config.deviceId, { operation: 'file', threadId: id, path }), e => e.code === 'FILE_NOT_AUTHORIZED');
  const elsewhere = resolve(f.root, 'elsewhere'); await mkdir(elsewhere); await writeFile(resolve(elsewhere, 'private.txt'), 'private'); await symlink(elsewhere, resolve(B.project.path, 'link'), 'junction');
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'file', threadId: id, path: 'link/private.txt' }), e => e.code === 'FILE_FORBIDDEN');
  const cross = f.store.consumePairing(f.store.pairing(f.stranger.id).pairingCode);
  await assert.rejects(hubCollaboration({ ...A.config, ...cross }, B.config.deviceId, { operation: 'projects' }), e => e.code === 'NOT_FOUND');
  const foreignList = await hubCollaboration({ ...A.config, ...cross }); assert.deepEqual(foreignList.devices, []);
  const session = f.store.issueSession(f.owner.id).token;
  const forged = await fetch(f.origin + '/devices/' + B.config.deviceId + '/api/collaboration', { method: 'POST', headers: { cookie: 'hub_session=' + session, origin: f.origin, 'x-bridge-client': 'mobile-v1', 'content-type': 'application/json' }, body: JSON.stringify({ sourceDeviceId: A.config.deviceId, operation: 'projects' }) }); assert.equal(forged.status, 404);
  const spoof = await fetch(f.origin + '/api/hub/collaboration/devices/' + B.config.deviceId, { method: 'POST', headers: { authorization: 'Bearer ' + A.config.deviceToken, 'x-bridge-client': 'computer-v1', 'content-type': 'application/json' }, body: JSON.stringify({ sourceDeviceId: cross.deviceId, operation: 'projects' }) }); assert.equal(spoof.status, 400);
  const mcpModule = new URL('../scripts/collaboration-mcp.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {serveMcp} from ${JSON.stringify(mcpModule)};serveMcp({root:${JSON.stringify(A.root)}});`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
  let buffer = ''; const answers = new Map(), waiters = new Map();
  child.stdout.on('data', bytes => { buffer += bytes.toString(); while (buffer.includes('\n')) { const index = buffer.indexOf('\n'), item = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); answers.set(item.id, item); waiters.get(item.id)?.(item); } });
  let nextId = 0;
  const rpc = (method, params) => { const rpcId = ++nextId; return new Promise((yes, no) => { const timer = setTimeout(() => no(new Error('MCP timeout')), 30000); waiters.set(rpcId, item => { clearTimeout(timer); waiters.delete(rpcId); yes(item); }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }) + '\n'); }); };
  assert.equal((await rpc('initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.version, packageVersion);
  const tools = (await rpc('tools/list', {})).result.tools; assert.equal(tools.length, 12); assert.ok(!tools.some(t => /approve|http|proxy/.test(t.name)));
  const transcript = await rpc('tools/call', { name: 'collaboration_read', arguments: { deviceId: B.config.deviceId, threadId: id } }); assert.equal(JSON.parse(transcript.result.content[0].text).thread.id, id);
  child.stdin.end(); await new Promise(yes => child.on('exit', yes));
  } finally { if (child.exitCode === null) child.kill(); }
  const policyPath = resolve(B.root, '.local/computer-collaboration.json'), policy = await readPrivate(policyPath);
  await writePrivate(policyPath, { ...policy, allowedDeviceIds: [] });
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'read', threadId: id }), e => e.code === 'COLLABORATION_NOT_AUTHORIZED');
  await writePrivate(policyPath, { ...policy, allowedProjectRoots: [] });
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'read', threadId: id }), e => ['THREAD_NOT_AUTHORIZED', 'COLLABORATION_NOT_AUTHORIZED'].includes(e.code));
  await writePrivate(policyPath, policy);
  const prior = B.threads.get(id).cwd; B.threads.get(id).cwd = elsewhere;
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'read', threadId: id }), e => ['THREAD_NOT_AUTHORIZED', 'COLLABORATION_NOT_AUTHORIZED'].includes(e.code)); B.threads.get(id).cwd = prior;
  const rePair = f.store.consumePairing(f.store.pairing(f.owner.id, 'B replacement').pairingCode);
  await writePrivate(resolve(B.root, '.local/hub-connector.json'), { ...B.config, ...rePair });
  await assert.rejects(clientA.call(B.config.deviceId, { operation: 'projects' }), e => e.code === 'COLLABORATION_BINDING_CHANGED');
  const beforeSends = B.counts.sends;
  const sourcePolicy = resolve(A.root, '.local/computer-collaboration.json'); await writePrivate(sourcePolicy, { ...(await readPrivate(sourcePolicy)), controlEnabled: false });
  await assert.rejects(clientA.call(B.config.deviceId, send), e => e.code === 'COLLABORATION_CONTROL_DISABLED'); assert.equal(B.counts.sends, beforeSends);
  checks.push({ name: 'dual Hub+connector+native fixture+MCP stdio', passed: true, artifactRoot: f.root, createsOnB: B.counts.creates, sendsOnB: B.counts.sends, stopsOnB: B.counts.stops, verified: ['bidirectional authorization', 'durable deduplication', 'run identity', 'bounded wait', 'needs-attention', 'no approval route', 'source spoof denial', 'cross-account denial', 'path/junction denial', 'fixed private downloads', 'immediate allowlist revoke', 'cwd ownership', 're-pair binding invalidation', 'off switch'] }); await evidence();
});
test('many chats use bounded metadata without hydrating huge histories; stale entries are skipped', async t => {
  const { A, B } = await dual(t), client = createCollaborationClient({ root: A.root });
  for (let i = 0; i < 100; i++) { const id = randomUUID(); B.threads.set(id, { ...B.threads.get(B.first), id }); }
  B.threads.set(randomUUID(), { id: 'stale-id', cwd: B.project.path });
  let hydrated = 0; const read = B.bridge.read; B.bridge.read = async (...args) => { hydrated++; return { ...(await read(...args)), turns: [{ text: 'H'.repeat(3 * 1024 * 1024) }] }; };
  const started = Date.now(), listed = await client.call(B.config.deviceId, { operation: 'threads' });
  assert.equal(listed.threads.length, 100); assert.equal(hydrated, 0); assert.ok(Date.now() - started < 5000);
  await client.call(B.config.deviceId, { operation: 'status', threadId: B.first }); assert.equal(hydrated, 0);
  await assert.rejects(client.call(B.config.deviceId, { operation: 'read', threadId: B.first, turnLimit: 1 }), e => e.code === 'RESULT_TOO_LARGE');
  checks.push({ name: 'many-chat metadata scalability', passed: true, eligibleChats: listed.threads.length, hydratedForListAndStatus: 0, oversizedRead: 'RESULT_TOO_LARGE' }); await evidence();
});
test('post-dispatch revocation or source re-pair returns unknown, never a definitive rejection', async t => {
  const { A, B } = await dual(t), client = createCollaborationClient({ root: A.root });
  const send = B.bridge.send;
  B.bridge.send = async (...args) => { await send(...args); const path = resolve(B.root, '.local/computer-collaboration.json'); const p = await readPrivate(path); await writePrivate(path, { ...p, allowedDeviceIds: [] }); };
  const operationId = randomUUID(); const result = await client.call(B.config.deviceId, { operation: 'send', operationId, threadId: B.first, prompt: 'accepted before revoke' });
  assert.equal(result.state, 'unknown'); assert.equal(result.operationId, operationId); assert.equal(result.code, 'DELIVERY_UNKNOWN'); assert.equal(B.counts.sends, 1);
  const root = await fixtureRoot('source-repair'), config = { deviceId: randomUUID(), deviceToken: 'a'.repeat(43), hubOrigin: 'https://fixture.invalid' };
  await writePrivate(resolve(root, '.local/hub-connector.json'), config); await writePrivate(resolve(root, '.local/computer-collaboration.json'), { version: 1, deviceId: config.deviceId, hubOrigin: config.hubOrigin, controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] });
  const source = createCollaborationClient({ root, fetchImpl: async () => { await writePrivate(resolve(root, '.local/hub-connector.json'), { ...config, deviceId: randomUUID() }); return new Response(JSON.stringify({ state: 'accepted' }), { headers: { 'content-type': 'application/json' } }); } });
  const sourceResult = await source.call(randomUUID(), { operation: 'send', operationId: randomUUID(), threadId: randomUUID(), prompt: 'fixture' }); assert.equal(sourceResult.state, 'unknown'); assert.equal(sourceResult.code, 'DELIVERY_UNKNOWN');
  checks.push({ name: 'post-dispatch authorization races', passed: true, targetActedExactlyOnce: B.counts.sends, targetRevokeState: result.state, sourceRepairState: sourceResult.state }); await evidence();
});
test('unknown create/send never resend and use receipt query after transport loss', async () => {
  const root = await fixtureRoot('unknown'); const config = { deviceId: randomUUID(), deviceToken: 'a'.repeat(43), hubOrigin: 'https://fixture.invalid' };
  await writePrivate(resolve(root, '.local/hub-connector.json'), config); await writePrivate(resolve(root, '.local/computer-collaboration.json'), { version: 1, deviceId: config.deviceId, hubOrigin: config.hubOrigin, controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] });
  let mutations = 0, queries = 0;
  const client = createCollaborationClient({ root, fetchImpl: async (url, options) => { const body = JSON.parse(options.body); if (body.operation === 'receipt') { queries++; return new Response(JSON.stringify({ state: 'accepted', operationId: body.operationId }), { headers: { 'content-type': 'application/json' } }); } mutations++; throw new Error('Connection lost after target dispatch'); } });
  const deviceId = randomUUID(), request = { operation: 'send', threadId: randomUUID(), prompt: 'fixture', operationId: randomUUID() };
  const result = await client.call(deviceId, request); assert.equal(result.state, 'unknown'); assert.equal(result.operationId, request.operationId);
  assert.equal((await client.call(deviceId, request)).state, 'accepted'); assert.equal(mutations, 1); assert.equal(queries, 1);
  checks.push({ name: 'transport unknown no replay', passed: true, mutations, receiptQueries: queries }); await evidence();
});
test('TOML registration preserves providers and foreign servers; refuses quoted/inline/edited conflicts and junctions', async () => {
  const root = await fixtureRoot('registration'), codexHome = resolve(root, 'codex-home'); await mkdir(codexHome);
  const config = resolve(codexHome, 'config.toml');
  const original = '# user fixture\nmodel_provider="fixture"\n[model_providers.fixture]\nname="fixture provider"\nbase_url="https://fixture.invalid/v1"\nexperimental_bearer_token="isolated-secret-fixture"\n[mcp_servers.external]\ncommand="fixture-command"\n';
  await writeFile(config, original);
  await registerCollaboration({ root, codexHome, enabled: true });
  const registered = await readFile(config, 'utf8'); assert.ok(registered.startsWith(original)); assert.equal(TOML.parse(registered).mcp_servers.external.command, 'fixture-command');
  await registerCollaboration({ root, codexHome, enabled: false }); assert.equal(await readFile(config, 'utf8'), original);
  const noNewline = 'model="fixture"'; await writeFile(config, noNewline);
  await Promise.all([registerCollaboration({ root, codexHome, enabled: true }), registerCollaboration({ root, codexHome, enabled: true })]);
  const concurrent = await readFile(config, 'utf8'); assert.equal(concurrent.split('[mcp_servers.' + collaborationServerName + ']').length, 2);
  await registerCollaboration({ root, codexHome, enabled: false }); assert.equal(await readFile(config, 'utf8'), noNewline);
  const raceRoot = await fixtureRoot('registration-race'), raceHome = resolve(raceRoot, 'codex-home'); await mkdir(raceHome); const raceConfig = resolve(raceHome, 'config.toml'); await writeFile(raceConfig, 'model="before"\n');
  await assert.rejects(registerCollaboration({ root: raceRoot, codexHome: raceHome, enabled: true, beforeReplace: () => writeFile(raceConfig, 'model="concurrent-editor"\n') }), e => e.code === 'MCP_CONFIG_CHANGED');
  assert.equal(await readFile(raceConfig, 'utf8'), 'model="concurrent-editor"\n');
  await assert.rejects(registerCollaboration({ root: raceRoot, codexHome: raceHome, enabled: true }), e => e.code === 'MCP_REGISTRATION_RECOVERY_REQUIRED');
  assert.equal(await readFile(resolve(raceRoot, '.local/collaboration-config-backup.toml'), 'utf8'), 'model="before"\n');
  for (const text of [`[mcp_servers."${collaborationServerName}"]\ncommand="foreign"\n`, `[mcp_servers.'${collaborationServerName}']\ncommand='foreign'\n`, `mcp_servers = { ${collaborationServerName} = { command = "foreign" } }\n`]) {
    await writeFile(config, text); await assert.rejects(registerCollaboration({ root, codexHome, enabled: true }), e => e.code === 'MCP_REGISTRATION_CONFLICT'); assert.equal(await readFile(config, 'utf8'), text);
  }
  await writeFile(config, original); await registerCollaboration({ root, codexHome, enabled: true });
  const edit = (await readFile(config, 'utf8')).replace('command = ', 'command = "user-edit" # '); await writeFile(config, edit);
  await assert.rejects(registerCollaboration({ root, codexHome, enabled: false }), e => e.code === 'MCP_REGISTRATION_CONFLICT'); assert.equal(await readFile(config, 'utf8'), edit);
  const linkRoot = await fixtureRoot('config-link'), link = resolve(linkRoot, 'linked-home'); await symlink(codexHome, link, 'junction');
  await assert.rejects(registerCollaboration({ root: linkRoot, codexHome: link, enabled: true }), e => e.code === 'MCP_CONFIG_UNSAFE');
  const backupRoot = await fixtureRoot('backup-link'); await mkdir(resolve(backupRoot, '.local')); await mkdir(resolve(backupRoot, '.local/collaboration-config-backup.toml'));
  await rm(resolve(backupRoot, '.local/collaboration-config-backup.toml'), { recursive: true });
  await symlink(codexHome, resolve(backupRoot, '.local/collaboration-config-backup.toml'), 'junction');
  await assert.rejects(registerCollaboration({ root: backupRoot, codexHome, enabled: true }), e => e.code === 'MCP_CONFIG_UNSAFE');
  checks.push({ name: 'isolated TOML registration', passed: true, artifactRoot: root, verified: ['preserved provider/key fixture', 'owned remove only', 'quoted equivalents', 'inline conflict', 'edited block preserved', 'junction refused'] }); await evidence();
});
test('settings default off, old Hub unavailable, disabled changes preserve connection and avoid real registration', async () => {
  const root = await fixtureRoot('settings');
  const first = await collaborationSettings({ action: 'get-collaboration-state' }, { root }); assert.equal(first.collaboration.controlEnabled, false); assert.equal(first.collaboration.receiveEnabled, false);
  const config = { deviceId: randomUUID(), deviceToken: 'a'.repeat(43), hubOrigin: 'https://old.invalid', bridgePort: 4317 };
  await writePrivate(resolve(root, '.local/hub-connector.json'), config);
  const before = await readFile(resolve(root, '.local/hub-connector.json'), 'utf8');
  const deps = { root, fetchImpl: async () => new Response(JSON.stringify({ code: 'FORBIDDEN' }), { status: 403, headers: { 'content-type': 'application/json' } }), bridge: async () => ({ projects: [] }), register: async () => ({ status: 'disabled' }) };
  const state = await collaborationSettings({ action: 'get-collaboration-state' }, deps); assert.equal(state.collaboration.featureAvailable, false); assert.match(state.collaboration.error, /服务器尚未支持/);
  await assert.rejects(hubCollaboration(config, null, null, { fetchImpl: deps.fetchImpl }), e => e.code === 'FEATURE_UNAVAILABLE');
  await assert.rejects(collaborationSettings({ action: 'save-collaboration', controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] }, deps), e => e.code === 'FEATURE_UNAVAILABLE');
  assert.equal(await readFile(resolve(root, '.local/hub-connector.json'), 'utf8'), before);
  await writePrivate(resolve(root, '.local/computer-collaboration.json'), { version: 1, deviceId: config.deviceId, hubOrigin: config.hubOrigin, controlEnabled: true, receiveEnabled: true, allowedDeviceIds: [randomUUID()], allowedProjectRoots: [resolve(root, 'missing-old-project')] });
  const p = await readPrivate(resolve(root, '.local/computer-collaboration.json'));
  const revoked = await collaborationSettings({ action: 'save-collaboration', controlEnabled: false, receiveEnabled: true, allowedDeviceIds: p.allowedDeviceIds, allowedProjectRoots: p.allowedProjectRoots }, { ...deps, fetchImpl: async () => { throw new Error('Must not contact offline Hub for revocation'); } });
  assert.equal(revoked.collaboration.controlEnabled, false); assert.equal(revoked.collaboration.receiveEnabled, true);
  checks.push({ name: 'default off and old Hub', passed: true, verified: ['both default off', 'feature unavailable', 'existing pairing untouched'] }); await evidence();
});
async function runChild(source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise(yes => child.on('exit', yes)); assert.equal(code, 0, stderr); return JSON.parse(stdout.trim());
}
test('multiple MCP processes preserve distinct IDs and dispatch a shared ID once', async () => {
  const root = await fixtureRoot('multiprocess'), config = { deviceId: randomUUID(), deviceToken: 'a'.repeat(43), hubOrigin: 'https://fixture.invalid' };
  await writePrivate(resolve(root, '.local/hub-connector.json'), config); await writePrivate(resolve(root, '.local/computer-collaboration.json'), { version: 1, deviceId: config.deviceId, hubOrigin: config.hubOrigin, controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] });
  const deviceId = randomUUID(), threadId = randomUUID(), sharedId = randomUUID();
  const moduleUrl = new URL('../scripts/collaboration-client.mjs', import.meta.url).href;
  const sources = [sharedId, sharedId, randomUUID(), randomUUID(), randomUUID(), randomUUID()].map(operationId => `import {appendFile} from 'node:fs/promises';import {createCollaborationClient} from ${JSON.stringify(moduleUrl)};const root=${JSON.stringify(root)};const client=createCollaborationClient({root,fetchImpl:async (url,options)=>{const q=JSON.parse(options.body);if(q.operation!=='receipt')await appendFile(root+'/mutations.txt',q.operationId+'\\n');return new Response(JSON.stringify({state:q.operation==='receipt'?'unknown':'accepted',operationId:q.operationId}),{headers:{'content-type':'application/json'}})}});console.log(JSON.stringify(await client.call(${JSON.stringify(deviceId)},{operation:'send',operationId:${JSON.stringify(operationId)},threadId:${JSON.stringify(threadId)},prompt:'fixture'})));`);
  const results = await Promise.all(sources.map(runChild)); assert.equal(results.length, 6);
  const rows = (await readFile(resolve(root, 'mutations.txt'), 'utf8')).trim().split('\n'); assert.equal(rows.length, 5); assert.equal(rows.filter(id => id === sharedId).length, 1);
  assert.equal((await readdir(resolve(root, '.local/collaboration-outbox'))).filter(name => name.endsWith('.json')).length, 5);
  checks.push({ name: 'cross-process durable operation reservation', passed: true, processes: 6, uniqueRecords: 5, actualDispatches: 5, sharedIdDispatches: 1 }); await evidence();
});
test('abandoned native settings mutex releases and isolated uninstall preserves foreign/edited config', async () => {
  const root = await fixtureRoot('lifecycle'), codexHome = resolve(root, 'codex-home'); await mkdir(codexHome); const config = resolve(codexHome, 'config.toml'); await writeFile(config, 'model="fixture"\n');
  await registerCollaboration({ root, codexHome, enabled: true });
  await writePrivate(resolve(root, '.local/computer-collaboration.json'), { controlEnabled: true, receiveEnabled: true });
  const cleaned = await disableCollaborationForUninstall({ root }); assert.equal(cleaned.ownedRegistrationRemoved, true); assert.equal(await readFile(config, 'utf8'), 'model="fixture"\n');
  await registerCollaboration({ root, codexHome, enabled: true }); const edited = (await readFile(config, 'utf8')).replace('command = ', 'command = "edited" # '); await writeFile(config, edited);
  const preserved = await disableCollaborationForUninstall({ root }); assert.equal(preserved.disabled, true); assert.equal(preserved.configurationPreserved, true); assert.equal(preserved.ownedRegistrationRemoved, false); assert.equal(await readFile(config, 'utf8'), edited); assert.equal((await readPrivate(resolve(root, '.local/computer-collaboration.json'))).controlEnabled, false);
  const moduleUrl = new URL('../scripts/collaboration-common.mjs', import.meta.url).href;
  const lockPath = resolve(root, '.local/abandoned-mutex');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {withCollaborationLock} from ${JSON.stringify(moduleUrl)};await withCollaborationLock(${JSON.stringify(lockPath)},async()=>{console.log('held');await new Promise(()=>{});});`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise(yes => child.stdout.once('data', yes)); child.kill(); await new Promise(yes => child.once('exit', yes));
  assert.equal(await withCollaborationLock(lockPath, async () => 'recovered'), 'recovered');
  checks.push({ name: 'isolated lifecycle and abandoned mutex', passed: true, verified: ['owned registration removed', 'edited foreign config preserved', 'policy disabled first', 'killed lock owner releases mutex'] }); await evidence();
});
test('entry root trailing separator resolves the sibling upgrade journal and explicit connector pause blocks source tools', async () => {
  const root = await fixtureRoot('pause-upgrade'), config = { deviceId: randomUUID(), deviceToken: 'a'.repeat(43), hubOrigin: 'https://fixture.invalid' };
  await writePrivate(resolve(root, '.local/hub-connector.json'), config); await writePrivate(resolve(root, '.local/computer-collaboration.json'), { version: 1, deviceId: config.deviceId, hubOrigin: config.hubOrigin, controlEnabled: true, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] });
  let calls = 0; const client = createCollaborationClient({ root: root + '/', fetchImpl: async () => { calls++; throw new Error('No real network should be called'); } });
  await writePrivate(root + '.upgrade-journal.json', { fixture: true });
  await assert.rejects(client.devices(), e => e.code === 'COLLABORATION_UPGRADING'); assert.equal(calls, 0);
  await rm(root + '.upgrade-journal.json');
  await writePrivate(resolve(root, '.local/connector-control.json'), { version: 2, paused: true, pauseScope: 'persistent', pausedSession: null, autoStart: false, autoStartSelected: true, startupPending: false, bootstrapPending: false, revision: 'fixture', settingsRevision: 'fixture', disconnectVerified: true });
  await assert.rejects(client.devices(), e => e.code === 'COLLABORATION_CONNECTOR_PAUSED'); assert.equal(calls, 0);
  checks.push({ name: 'entry trailing separator and pause gate', passed: true, networkRequests: calls }); await evidence();
});
