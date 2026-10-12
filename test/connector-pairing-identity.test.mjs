import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { effectivePolicy } from '../scripts/collaboration-common.mjs';
import { createCollaborationClient } from '../scripts/collaboration-client.mjs';
import { guiCommand } from '../scripts/connector-gui.mjs';

const base = resolve('work/collaboration-pairing-diagnosis');
const checks = [];
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const read = async path => JSON.parse(await readFile(path, 'utf8'));
async function fixture(t) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(resolve(base, 'identity-'));
  const local = resolve(root, '.local'); await mkdir(local); const project = resolve(root, 'project'); await mkdir(project);
  const configPath = resolve(local, 'hub-connector.json'), policyPath = resolve(local, 'computer-collaboration.json');
  const old = { version: 1, hubOrigin: 'https://old-hub.invalid', deviceId: randomUUID(), deviceToken: 'a'.repeat(43), deviceName: 'Old fixture', bridgePort: 4317 };
  const peer = randomUUID(), policy = { version: 1, hubOrigin: old.hubOrigin, deviceId: old.deviceId, controlEnabled: true, receiveEnabled: true, allowedDeviceIds: [peer], allowedProjectRoots: [project] };
  await writeFile(configPath, JSON.stringify(old)); await writeFile(policyPath, JSON.stringify(policy));
  await writeFile(resolve(local, 'collaboration-registration-state.json'), JSON.stringify({ status: 'ready', reloadRequired: false }));
  const codexHome = resolve(root, 'codex-home'); await mkdir(codexHome); const toml = resolve(codexHome, 'config.toml');
  const tomlBytes = 'model="fixture"\n[mcp_servers.foreign]\ncommand="foreign-fixture"\n'; await writeFile(toml, tomlBytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, local, project, peer, configPath, policyPath, old, policy, toml, tomlBytes };
}
async function pair(f, hubOrigin = 'https://new-hub.invalid', fetchImpl) {
  const next = { deviceId: randomUUID(), deviceToken: 'b'.repeat(43) }; let calls = 0;
  const result = await pairConnector({ origin: hubOrigin, name: 'New fixture', pairingCode: 'p'.repeat(43), configPath: f.configPath, bridgePort: 5432, replace: true, fetchImpl: fetchImpl || (async (url, options) => {
    calls++; assert.equal(url, `${hubOrigin}/api/hub/connect`); assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { pairingCode: 'p'.repeat(43), name: 'New fixture' }); return json(next);
  }) });
  return { result, next, calls };
}
function settingsDependencies(f, config) {
  return { root: f.root, configPath: f.configPath,
    fetchImpl: async (url, options) => { assert.equal(url, config.hubOrigin + '/api/hub/collaboration/devices'); assert.equal(options.headers.authorization, `Bearer ${config.deviceToken}`); return json({ version: 1, sourceDeviceId: config.deviceId, devices: [{ id: f.peer, name: 'Peer fixture', online: true }] }); },
    bridge: async current => { assert.equal(current.deviceId, config.deviceId); return { projects: [{ projectId: 'fixture-project', path: f.project, label: 'Fixture project' }] }; },
    register: async () => ({ status: 'ready', reloadRequired: true }) };
}
async function recorded(name, action) { try { await action(); checks.push({ name, passed: true }); } catch (error) { checks.push({ name, passed: false, failureType: error.code || error.name }); throw error; } }
test.after(async () => {
  await mkdir(base, { recursive: true });
  await writeFile(resolve(base, 'pairing-identity-tests.json'), JSON.stringify({ timestamp: new Date().toISOString(), checks, passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length, scope: 'Injected responses, private fixture roots only; no installed pairing, Codex TOML, live servers or commands touched.' }, null, 2) + '\n');
});

for (const sameHub of [false, true]) test(`successful ${sameHub ? 'same-Hub new-ID' : 'Hub A to Hub B'} replacement resets authorization without granting access`, async t => recorded(sameHub ? 'same-Hub new-ID reset' : 'cross-Hub reset', async () => {
  const f = await fixture(t), hub = sameHub ? f.old.hubOrigin : 'https://new-hub.invalid';
  const { result, next, calls } = await pair(f, hub); assert.equal(calls, 1);
  assert.deepEqual(await read(f.configPath), { version: 1, hubOrigin: hub, ...next, deviceName: 'New fixture', bridgePort: 5432 });
  assert.equal(result.collaborationReauthorizationRequired, true);
  const policy = await read(f.policyPath); assert.equal(policy.deviceId, next.deviceId); assert.equal(policy.hubOrigin, hub);
  assert.equal(policy.controlEnabled, false); assert.equal(policy.receiveEnabled, false); assert.deepEqual(policy.allowedDeviceIds, []); assert.deepEqual(policy.allowedProjectRoots, []); assert.equal(policy.requiresAuthorization, true);
  assert.equal((await read(resolve(f.local, 'collaboration-registration-state.json'))).status, 'authorization-required');
  assert.equal(await readFile(f.toml, 'utf8'), f.tomlBytes);
  const state = await collaborationSettings({ action: 'get-collaboration-state' }, settingsDependencies(f, await read(f.configPath)));
  assert.equal(state.collaboration.requiresAuthorization, true); assert.equal(state.collaboration.registration.status, 'authorization-required');
}));

test('unsuccessful pairing preserves complete functional prior credentials and authorization', async t => recorded('failed pair retains old credentials and policy', async () => {
  const f = await fixture(t); const paths = [f.configPath, f.policyPath, resolve(f.local, 'collaboration-registration-state.json')]; const before = await Promise.all(paths.map(path => readFile(path)));
  let calls = 0; await assert.rejects(pair(f, undefined, async () => { calls++; return json({ error: 'fixture pairing refused' }, 400); })); assert.equal(calls, 1);
  for (let i = 0; i < paths.length; i++) assert.deepEqual(await readFile(paths[i]), before[i]);
  assert.equal(effectivePolicy(await read(f.policyPath), await read(f.configPath)).controlEnabled, true);
  const client = createCollaborationClient({ root: f.root, fetchImpl: async (_url, options) => options.method === 'GET' ? json({ version: 1, sourceDeviceId: f.old.deviceId, devices: [{ id: f.peer, online: true }] }) : json({ version: 1, deviceId: f.peer }) });
  assert.equal((await client.devices()).devices[0].id, f.peer);
}));

test('first-ever pairing leaves collaboration optional and off without authorization-required nag files', async t => recorded('first pairing remains optional default-off', async () => {
  const f = await fixture(t); await Promise.all([f.configPath, f.policyPath, resolve(f.local, 'collaboration-registration-state.json')].map(path => rm(path)));
  const next = { deviceId: randomUUID(), deviceToken: 'b'.repeat(43) };
  const result = await pairConnector({ origin: 'https://new-hub.invalid', pairingCode: 'p'.repeat(43), configPath: f.configPath, fetchImpl: async () => json(next) });
  assert.equal(result.collaborationReauthorizationRequired, false);
  for (const path of [f.policyPath, resolve(f.local, 'collaboration-registration-state.json')]) await assert.rejects(readFile(path), error => error.code === 'ENOENT');
  const { collaboration } = await collaborationSettings({ action: 'get-collaboration-state' }, settingsDependencies(f, await read(f.configPath)));
  assert.equal(collaboration.controlEnabled, false); assert.equal(collaboration.receiveEnabled, false); assert.notEqual(collaboration.requiresAuthorization, true); assert.equal(collaboration.registration.status, 'disabled');
}));

test('existing-config conflict rejects before consuming another pairing code', async t => recorded('replacement requires explicit authorization before fetch', async () => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(pairConnector({ origin: 'https://new-hub.invalid', pairingCode: 'p'.repeat(43), configPath: f.configPath, fetchImpl: async () => { calls++; return json({ deviceId: randomUUID(), deviceToken: 'b'.repeat(43) }); } }));
  assert.equal(calls, 0); assert.deepEqual(await read(f.configPath), f.old); assert.deepEqual(await read(f.policyPath), f.policy);
}));

test('authorization cleanup failure reports a saved pairing and never throws a consumed-code retry', async t => recorded('saved credentials survive reset cleanup failure', async () => {
  const f = await fixture(t); await rm(f.policyPath); await mkdir(f.policyPath);
  const { result, next, calls } = await pair(f); assert.equal(calls, 1); assert.equal((await read(f.configPath)).deviceId, next.deviceId);
  assert.equal(result.collaborationResetPending, true); assert.equal(result.collaborationReauthorizationRequired, true);
  assert.equal(typeof result.warning, 'string'); assert.ok(result.warning.length > 0); assert.equal(await readFile(f.toml, 'utf8'), f.tomlBytes);
}));

test('GUI pairing preserves saved-credential cleanup warnings while attempting normal Hub startup', async t => recorded('GUI reports saved pair partial warning without replay', async () => {
  const f = await fixture(t); await rm(f.policyPath); await mkdir(f.policyPath);
  const next = { deviceId: randomUUID(), deviceToken: 'b'.repeat(43) }; let pairCalls = 0, watcherCalls = 0, oldStops = 0;
  const intent = { paused: false, revision: 'fixture-revision', settingsRevision: 'fixture-settings', autoStart: true, pauseScope: 'none', bootstrapPending: false, startupPending: false };
  const result = await guiCommand({ action: 'pair', origin: 'https://new-hub.invalid', name: 'New fixture', code: 'p'.repeat(43), replace: true }, {
    root: f.root, configPath: f.configPath,
    control: { read: async () => intent, completePairing: async () => ({ superseded: false, intent }), mayRun: async () => true },
    pair: options => pairConnector({ ...options, fetchImpl: async () => { pairCalls++; return json(next); } }),
    stopPrevious: async () => { oldStops++; }, registerDeferred: async () => {}, watch: async () => { watcherCalls++; return { pid: 1234 }; }
  });
  assert.equal(pairCalls, 1); assert.equal(oldStops, 1); assert.equal(watcherCalls, 1);
  assert.equal(result.paired, true); assert.equal(result.partialSuccess, true); assert.equal(result.collaborationResetPending, true); assert.equal(result.collaborationReauthorizationRequired, true); assert.equal(typeof result.warning, 'string'); assert.ok(result.warning.length > 0);
  assert.equal(result.recoveryCompleted, true, 'Owned Hub startup completion remains independent from the collaboration reset warning');
  assert.equal((await read(f.configPath)).deviceId, next.deviceId); assert.equal(result.deviceId, next.deviceId); assert.equal(await readFile(f.toml, 'utf8'), f.tomlBytes);
}));

test('legacy mismatched policy and stale ready-registration status are surfaced as requiring authorization', async t => recorded('legacy mismatch has actionable settings state', async () => {
  const f = await fixture(t), next = { ...f.old, hubOrigin: 'https://new-hub.invalid', deviceId: randomUUID(), deviceToken: 'b'.repeat(43) };
  await writeFile(f.configPath, JSON.stringify(next));
  const { collaboration: state } = await collaborationSettings({ action: 'get-collaboration-state' }, settingsDependencies(f, next));
  assert.equal(state.requiresAuthorization, true); assert.equal(state.registration.status, 'authorization-required'); assert.equal(state.controlEnabled, false); assert.equal(state.receiveEnabled, false); assert.deepEqual(state.allowedDeviceIds, []); assert.deepEqual(state.allowedProjectRoots, []);
}));

test('only a normal explicit save grants and binds newly selected permissions to the new identity', async t => recorded('explicit save grants only new identity and selection', async () => {
  const f = await fixture(t); await pair(f); const config = await read(f.configPath); let registered = 0;
  const deps = settingsDependencies(f, config); deps.register = async options => { registered++; assert.equal(options.enabled, true); return { status: 'ready', reloadRequired: true }; };
  const command = { action: 'save-collaboration', controlEnabled: true, receiveEnabled: true, allowedDeviceIds: [f.peer], allowedProjectRoots: [f.project] };
  const { collaboration } = await collaborationSettings(command, deps); assert.equal(registered, 1);
  const policy = await read(f.policyPath); assert.equal(policy.deviceId, config.deviceId); assert.equal(policy.hubOrigin, config.hubOrigin); assert.equal(policy.controlEnabled, true); assert.equal(policy.receiveEnabled, true); assert.notEqual(policy.requiresAuthorization, true); assert.notEqual(collaboration.requiresAuthorization, true);
  assert.deepEqual(policy.allowedDeviceIds, [f.peer]); assert.deepEqual(policy.allowedProjectRoots, [f.project]); assert.equal(collaboration.registration.status, 'ready'); assert.equal(await readFile(f.toml, 'utf8'), f.tomlBytes);
}));

test('client blocks stale policy and requiresAuthorization before any remote request', async t => recorded('stale client fails closed without network', async () => {
  const f = await fixture(t); let networkCalls = 0; const client = createCollaborationClient({ root: f.root, fetchImpl: async () => { networkCalls++; throw Error('network must not run'); } });
  const next = { ...f.old, deviceId: randomUUID(), deviceToken: 'b'.repeat(43) }; await writeFile(f.configPath, JSON.stringify(next));
  await assert.rejects(client.devices(), error => error.code === 'COLLABORATION_BINDING_CHANGED');
  await writeFile(f.policyPath, JSON.stringify({ ...f.policy, deviceId: next.deviceId, requiresAuthorization: true }));
  const blocked = effectivePolicy(await read(f.policyPath), next); assert.equal(blocked.controlEnabled, false); assert.equal(blocked.receiveEnabled, false);
  await assert.rejects(client.devices(), error => error.code === 'COLLABORATION_BINDING_CHANGED'); assert.equal(networkCalls, 0);
}));

test('revoked current device credential remains distinguishable from stale collaboration binding', async t => recorded('device revocation preserves distinct error code', async () => {
  const f = await fixture(t), client = createCollaborationClient({ root: f.root, fetchImpl: async () => json({ code: 'DEVICE_REVOKED', error: 'Fixture device credential revoked; re-pair required.' }, 401) });
  await assert.rejects(client.devices(), error => error.code === 'DEVICE_REVOKED');
}));

test('fresh old or unbound heartbeat cannot mark newly paired credentials online', async t => recorded('new pairing never inherits old online heartbeat', async () => {
  const f = await fixture(t); await pair(f); const config = await read(f.configPath);
  for (const heartbeat of [{ state: 'online', hubOrigin: f.old.hubOrigin, deviceId: f.old.deviceId }, { state: 'online' }]) {
    const status = await guiCommand({ action: 'status' }, { root: f.root, read: async () => config, probe: async () => ({ connected: true }), control: { read: async () => ({ paused: false, autoStart: false }) }, readState: async () => ({ ...heartbeat, updatedAt: new Date().toISOString() }) });
    assert.equal(status.bridgeConnected, true); assert.equal(status.hubConnected, false); assert.equal(status.hubState, 'waiting');
  }
}));

test('temporary project reload failure preserves authorization and retry succeeds with the same fresh selection', async t => recorded('project read failure is distinct and preserves choices', async () => {
  const f=await fixture(t);await writeFile(f.policyPath,JSON.stringify({...f.policy,controlEnabled:false,receiveEnabled:false}));
  const before=await readFile(f.policyPath),registrationPath=resolve(f.local,'collaboration-registration-state.json'),beforeRegistration=await readFile(registrationPath);
  const deps=settingsDependencies(f,f.old);let unavailable=true,registrations=0;
  deps.bridge=async()=>{if(unavailable)throw Error('Isolated temporary project failure');return{projects:[{projectId:'fixture-project',path:f.project,label:'Fixture project'}]};};
  deps.register=async()=>{registrations++;return{status:'registered'};};
  const command={action:'save-collaboration',controlEnabled:true,receiveEnabled:true,allowedDeviceIds:[f.peer],allowedProjectRoots:[f.project]};
  const state=await collaborationSettings({action:'get-collaboration-state'},deps);assert.equal(state.collaboration.projectsAvailable,false);assert.equal(state.collaboration.devicesAvailable,true);
  await assert.rejects(collaborationSettings(command,deps),error=>error.code==='COLLABORATION_PROJECTS_UNAVAILABLE');
  assert.equal(registrations,0);assert.deepEqual(await readFile(f.policyPath),before);assert.deepEqual(await readFile(registrationPath),beforeRegistration);
  unavailable=false;const saved=await collaborationSettings(command,deps);assert.equal(registrations,1);assert.equal(saved.collaboration.receiveEnabled,true);assert.deepEqual(saved.collaboration.allowedDeviceIds,[f.peer]);assert.deepEqual(saved.collaboration.allowedProjectRoots,[f.project]);
}));

test('an offline peer still present in the fresh account list is a valid explicit authorization choice', async t => recorded('offline present peer may be explicitly authorized', async () => {
  const f=await fixture(t);await writeFile(f.policyPath,JSON.stringify({...f.policy,controlEnabled:false,receiveEnabled:false}));
  const deps=settingsDependencies(f,f.old);deps.fetchImpl=async()=>json({version:1,sourceDeviceId:f.old.deviceId,devices:[{id:f.peer,name:'Peer fixture',online:false}]});
  const {collaboration}=await collaborationSettings({action:'save-collaboration',controlEnabled:true,receiveEnabled:true,allowedDeviceIds:[f.peer],allowedProjectRoots:[f.project]},deps);
  assert.equal(collaboration.receiveEnabled,true);assert.deepEqual(collaboration.allowedDeviceIds,[f.peer]);
}));

test('fresh lists reject obsolete IDs or project paths without granting a same-name replacement', async t => recorded('real stale selection rejects without same-name replacement', async () => {
  const f=await fixture(t);await writeFile(f.policyPath,JSON.stringify({...f.policy,controlEnabled:false,receiveEnabled:false}));const before=await readFile(f.policyPath),newPeer=randomUUID();let registrations=0;
  const deps=settingsDependencies(f,f.old);deps.fetchImpl=async()=>json({version:1,sourceDeviceId:f.old.deviceId,devices:[{id:newPeer,name:'Peer fixture',online:true}]});deps.register=async()=>{registrations++;return{status:'registered'};};
  const command={action:'save-collaboration',controlEnabled:true,receiveEnabled:true,allowedDeviceIds:[f.peer],allowedProjectRoots:[f.project]};
  await assert.rejects(collaborationSettings(command,deps),error=>error.code==='COLLABORATION_SELECTION_CHANGED');assert.deepEqual(await readFile(f.policyPath),before);
  deps.fetchImpl=async()=>json({version:1,sourceDeviceId:f.old.deviceId,devices:[{id:f.peer,name:'Peer fixture',online:false}]});
  await assert.rejects(collaborationSettings({...command,allowedProjectRoots:[resolve(f.root,'missing-project')]},deps),error=>error.code==='COLLABORATION_SELECTION_CHANGED');assert.equal(registrations,0);assert.deepEqual(await readFile(f.policyPath),before);
}));
