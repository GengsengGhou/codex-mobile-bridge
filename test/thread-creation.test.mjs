import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopBridge, BridgeError } from '../src/desktop.mjs';
import { CreationStore } from '../src/creation-store.mjs';
import { createBridgeServer } from '../src/server.mjs';

const ID = '00000000-0000-0000-0000-000000000001';
const CREATED = '00000000-0000-0000-0000-000000000002';
const REQUEST = '00000000-0000-0000-0000-000000000003';
const PROJECT = { projectId: 'local-saved', projectKind: 'local', label: 'Saved', path: 'E:/saved', hostId: 'local', isGitRepository: false };
const body = { requestId: REQUEST, prompt: 'first private prompt', projectId: PROJECT.projectId };
const nativeResult = value => ({ success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] });
const adapter = ({ projects = [PROJECT], result = { threadId: CREATED, hostId: 'local' }, schemaVersion = 2 } = {}) => {
  const calls = [];
  const bridge = new DesktopBridge({ callerThreadId: ID, request: async (pipe, method, params, options) => {
    calls.push({ method, params, options });
    if (params.tool === 'list_projects') return nativeResult({ schemaVersion, projects });
    return nativeResult(result);
  } });
  return { bridge, calls };
};

test('project adapter filters remote/cloud and creates exactly a local target with inherited defaults', async () => {
  const f = adapter({ projects: [PROJECT, { projectId: 'remote', projectKind: 'remote', hostId: 'remote' }, { projectId: 'cloud', projectKind: 'chatgpt' }] });
  assert.deepEqual(await f.bridge.projects(), [{ projectId: PROJECT.projectId, label: PROJECT.label, path: PROJECT.path, hostId: 'local', isGitRepository: false }]);
  let reserved = false;
  await f.bridge.create(body, { beforeDispatch: () => { reserved = true; } });
  assert.equal(reserved, true);
  const call = f.calls.at(-1);
  assert.equal(call.params.callerSource, 'codex'); assert.equal(call.params.tool, 'create_thread'); assert.equal(call.options.mutation, true);
  assert.deepEqual(call.params.arguments, { prompt: body.prompt, target: { type: 'project', projectId: PROJECT.projectId, environment: { type: 'local' } } });
  await f.bridge.create({ prompt: 'standalone', title: 'Title' });
  assert.deepEqual(f.calls.at(-1).params.arguments, { prompt: 'standalone', title: 'Title', target: { type: 'projectless' } });
});

test('stale project and incompatible schema stop before reservation; clientThreadId and unaccepted first turn stay unknown', async () => {
  for (const config of [{ projects: [] }, { schemaVersion: 3 }]) {
    const f = adapter(config); let reserved = false;
    await assert.rejects(f.bridge.create(body, { beforeDispatch: () => { reserved = true; } }), { code: config.projects ? 'PROJECT_UNAVAILABLE' : 'PROTOCOL_ERROR' });
    assert.equal(reserved, false); assert.ok(f.calls.every(c => c.params.tool !== 'create_thread'));
  }
  for (const result of [{ clientThreadId: CREATED, hostId: 'local' }, { threadId: CREATED, hostId: 'remote' }, { status: 'created', conversationId: CREATED, firstTurn: { status: 'failed' }, hostId: 'local' }]) {
    const f = adapter({ result }); await assert.rejects(f.bridge.create(body), { code: 'DELIVERY_UNKNOWN' });
    assert.equal(f.calls.filter(c => c.params.tool === 'create_thread').length, 1);
  }
});

async function fixture(t, { enableSend = true, sendScope = 'all-local', capabilities = ['list_threads', 'read_thread', 'list_projects', 'create_thread'], store = new CreationStore({ path: null }), fail, gate, readFail = false, archived = false, threads = [], readGate } = {}) {
  const native = adapter(); let mutations = 0;
  const bridge = native.bridge;
  bridge.capabilities = async () => capabilities;
  bridge.list = async () => ({ threads: structuredClone(threads) });
  bridge.read = async id => { if (id === CREATED) await readGate; if (readFail && id === CREATED) throw new BridgeError('Not loaded'); return { thread: { id, kind: 'codex', hostId: 'local', status: 'idle', archived: id === CREATED && archived }, turns: [] }; };
  const create = bridge.create.bind(bridge);
  bridge.create = async (args, options) => create(args, { beforeDispatch: async () => {
    await options.beforeDispatch(); mutations++; await gate;
    if (fail) throw new BridgeError('Uncertain', fail, 409);
  } });
  const server = createBridgeServer({ bridge, enableSend, sendScope, creationStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  return { mutations: () => mutations, get: path => fetch(base + path, { headers }), create: (value = body, extra = {}) => fetch(base + '/api/threads', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) }) };
}

test('creation HTTP requires all-local authorization, capabilities, session, origin and strict bounded fields', async t => {
  const f = await fixture(t);
  assert.equal((await (await f.get('/api/status')).json()).canCreate, true);
  assert.equal((await (await f.get('/api/projects')).json()).projects[0].projectId, PROJECT.projectId);
  assert.equal((await f.create(body, { Cookie: '' })).status, 401);
  assert.equal((await f.create(body, { Origin: 'http://other.example' })).status, 403);
  for (const config of [{ enableSend: false }, { sendScope: 'single' }, { capabilities: ['list_projects'] }]) {
    const denied = await fixture(t, config);
    assert.equal((await (await denied.get('/api/projects')).json()).canCreate, false);
    assert.equal((await denied.create()).status, 403); assert.equal(denied.mutations(), 0);
  }
  for (const value of [{ ...body, path: 'E:/arbitrary' }, { ...body, model: 42 }, { ...body, target: { type: 'worktree' } }, { ...body, prompt: '' }, { ...body, prompt: 'x'.repeat(12001) }, { ...body, title: 'x'.repeat(201) }, { ...body, requestId: 'invalid' }]) assert.equal((await f.create(value)).status, 400);
  assert.equal((await f.create({ ...body, model: 'override' })).status, 409);
  assert.equal((await f.create({ ...body, projectId: 'removed' })).status, 409);
  assert.equal(f.mutations(), 0);
  assert.deepEqual(await (await f.get(`/api/thread-creations/${REQUEST}`)).json(), { state: 'not_found' });
});

test('successful creation has a durable receipt, identical retries reuse it and changed payload conflicts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-creation-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'creations.json');
  const f = await fixture(t, { store: new CreationStore({ path }), readFail: true });
  const first = await f.create(); assert.equal(first.status, 200); const receipt = await first.json();
  assert.equal(receipt.created, true); assert.equal(receipt.threadId, CREATED); assert.equal(receipt.hostId, 'local');
  assert.deepEqual(await (await f.create()).json(), receipt); assert.equal(f.mutations(), 1);
  assert.equal((await (await f.create({ ...body, title: 'Changed' })).json()).code, 'CONFLICT');
  assert.deepEqual(await (await f.get(`/api/thread-creations/${REQUEST}`)).json(), { state: 'created', receipt });
  assert.deepEqual((await (await f.get('/api/threads')).json()).threads, []);
  assert.deepEqual(await (await f.get(`/api/thread-creations/${REQUEST}`)).json(), { state: 'created', receipt });
  const restored = await fixture(t, { store: new CreationStore({ path }) });
  assert.deepEqual(await (await restored.create()).json(), receipt); assert.equal(restored.mutations(), 0);
  assert.equal((await (await restored.get('/api/threads')).json()).threads[0].id, CREATED);
  assert.ok(!(await readFile(path, 'utf8')).includes(body.prompt));
});

test('uncertain creation survives restart without redispatch and in-flight duplicate never creates twice', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-creation-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'creations.json'); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { store: new CreationStore({ path }), fail: 'DESKTOP_UNAVAILABLE', gate });
  const first = f.create();
  try {
    while (!f.mutations()) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await f.create()).json()).code, 'DELIVERY_UNKNOWN');
  } finally { release(); }
  assert.equal((await (await first).json()).code, 'DELIVERY_UNKNOWN');
  const restored = await fixture(t, { store: new CreationStore({ path }) });
  assert.deepEqual(await (await restored.get(`/api/thread-creations/${REQUEST}`)).json(), { state: 'unknown' });
  assert.equal((await (await restored.create()).json()).code, 'DELIVERY_UNKNOWN');
  assert.equal(restored.mutations(), 0); assert.equal(f.mutations(), 1);
});

test('reservation persistence failure prevents creation and receipt persistence failure remains unknown', async t => {
  const broken = await fixture(t, { store: { get: async () => null, reserve: async () => { throw new BridgeError('Store broken', 'CREATION_STORE_UNAVAILABLE', 503); } } });
  assert.equal((await broken.create()).status, 503); assert.equal(broken.mutations(), 0);
  const store = new CreationStore({ path: null }); store.accept = async () => { throw new BridgeError('Store broken', 'CREATION_STORE_UNAVAILABLE', 503); };
  const f = await fixture(t, { store });
  assert.equal((await (await f.create()).json()).code, 'DELIVERY_UNKNOWN');
  assert.equal((await (await f.create()).json()).code, 'DELIVERY_UNKNOWN'); assert.equal(f.mutations(), 1);
});

test('corrupt creation journal fails closed without exposing stored fields', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-creation-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'creations.json'); await writeFile(path, '{"secret":"private"}');
  await assert.rejects(new CreationStore({ path }).get(REQUEST), { code: 'CREATION_STORE_UNAVAILABLE' });
});

test('newly created receipts never restore an archived conversation to the sidebar', async t => {
  const f = await fixture(t, { archived: true });
  assert.equal((await f.create()).status, 200);
  assert.deepEqual((await (await f.get('/api/threads')).json()).threads, []);
  assert.equal((await (await f.get(`/api/thread-creations/${REQUEST}`)).json()).state, 'created');
});

test('corrupt creation journal preserves native list and reads while creation fails closed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-creation-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'creations.json'); await writeFile(path, '{"private":"raw data"}');
  const threads = [{ id: ID, kind: 'codex', title: 'Existing', hostId: 'local', status: 'idle' }];
  const f = await fixture(t, { store: new CreationStore({ path }), threads });
  const response = await f.get('/api/threads'); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { threads, creationSupplement: { available: false, code: 'CREATION_STORE_UNAVAILABLE' } });
  assert.equal((await f.get(`/api/threads/${ID}`)).status, 200);
  assert.equal((await f.create()).status, 503); assert.equal(f.mutations(), 0);
});

test('slow new-conversation reads have a short list budget and cannot later mutate the returned list', async t => {
  let release;
  const readGate = new Promise(resolve => { release = resolve; });
  const threads = [{ id: ID, kind: 'codex', title: 'Existing', hostId: 'local', status: 'idle' }];
  const f = await fixture(t, { threads, readGate });
  await f.create(); const started = Date.now();
  try {
    const response = await f.get('/api/threads'); assert.equal(response.status, 200);
    assert.ok(Date.now() - started < 1500);
    assert.deepEqual(await response.json(), { threads, creationSupplement: { available: false, code: 'CREATION_SUPPLEMENT_UNAVAILABLE' } });
    assert.equal((await (await f.get(`/api/thread-creations/${REQUEST}`)).json()).state, 'created');
  } finally { release(); }
  assert.deepEqual((await (await f.get('/api/threads')).json()).threads, threads);
});
