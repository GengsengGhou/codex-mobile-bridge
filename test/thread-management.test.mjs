import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeError, DesktopBridge, THREAD_MANAGEMENT_TOOLS } from '../src/desktop.mjs';
import { createBridgeServer } from '../src/server.mjs';

const CALLER = '00000000-0000-0000-0000-000000000001';
const TARGET = '00000000-0000-0000-0000-000000000002';
const catalog = ['list_threads', 'read_thread', 'send_message_to_thread', ...Object.values(THREAD_MANAGEMENT_TOOLS)];

async function setup(t, { enableSend = true, sendScope = 'all-local', allowedSendThreadId = TARGET, properties = {}, names = catalog, manage } = {}) {
  const calls = [];
  const bridge = {
    callerThreadId: CALLER, capabilities: async () => names,
    read: async id => ({ thread: { id, kind: 'codex', hostId: 'local', status: 'idle', ...properties }, turns: [], page: {} }),
    manage: async (...args) => { calls.push(args); return manage?.(...args); },
    send: async () => {}, list: async () => ({ threads: [] }),
  };
  const server = createBridgeServer({ bridge, enableSend, sendScope, allowedSendThreadId });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  return { base, headers, bridge, calls,
    post: (body, id = TARGET) => fetch(`${base}/api/threads/${id}/settings`, { method: 'POST', headers, body: JSON.stringify(body) }),
    read: async (path = `/api/threads/${TARGET}`) => (await fetch(`${base}${path}`, { headers })).json(),
  };
}

test('native management adapters use exact tool arguments and mutation transport', async () => {
  const calls = [];
  const bridge = new DesktopBridge({ callerThreadId: CALLER, request: async (_pipe, method, params, options) => {
    calls.push({ method, params, options }); return { success: true, contentItems: [] };
  } });
  await bridge.manage(TARGET, 'rename', 'New title');
  await bridge.manage(TARGET, 'pin', false);
  await bridge.manage(TARGET, 'archive', true);
  assert.deepEqual(calls.map(call => call.params.tool), Object.values(THREAD_MANAGEMENT_TOOLS));
  assert.deepEqual(calls.map(call => call.params.arguments), [
    { threadId: TARGET, source: 'codex', title: 'New title' },
    { threadId: TARGET, source: 'codex', pinned: false },
    { threadId: TARGET, source: 'codex', archived: true, hostId: 'local' },
  ]);
  for (const call of calls) {
    assert.equal(call.method, 'tools/call'); assert.equal(call.params.threadId, CALLER);
    assert.equal(call.params.callerSource, 'codex'); assert.equal(call.options.mutation, true);
  }
  await assert.rejects(bridge.manage(TARGET, 'create', true), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(bridge.manage(TARGET, 'toString', true), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(bridge.call('stop_thread', {}, true), error => error.code === 'FORBIDDEN');
  assert.equal(calls.length, 3);
});

test('native uncertain management failures dispatch once and retain delivery-unknown semantics', async () => {
  let calls = 0;
  const bridge = new DesktopBridge({ callerThreadId: CALLER, request: async () => { calls++; return { success: false }; } });
  await assert.rejects(bridge.manage(TARGET, 'pin', true), error => error.code === 'DELIVERY_UNKNOWN');
  assert.equal(calls, 1);
});

test('settings return normalized receipts and accept rename/pin for active tasks', async t => {
  const s = await setup(t, { properties: { status: 'active' } });
  for (const body of [{ action: 'rename', value: '  新名字  ' }, { action: 'pin', value: true }, { action: 'pin', value: false }]) {
    const response = await s.post(body);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ...body, value: typeof body.value === 'string' ? body.value.trim() : body.value, threadId: TARGET, accepted: true });
  }
  assert.deepEqual(s.calls, [[TARGET, 'rename', '新名字'], [TARGET, 'pin', true], [TARGET, 'pin', false]]);
  const read = await s.read(); assert.equal(read.canManage, true); assert.equal(read.canArchive, false);
  assert.equal((await s.post({ action: 'archive', value: true })).status, 403);
  assert.equal(s.calls.length, 3);
});

test('archive requires an idle target other than the bridge caller', async t => {
  const s = await setup(t);
  assert.equal((await s.read()).canArchive, true);
  assert.equal((await s.post({ action: 'archive', value: true })).status, 200);
  assert.deepEqual(s.calls, [[TARGET, 'archive', true]]);
  assert.equal((await s.post({ action: 'archive', value: true }, CALLER)).status, 403);
  assert.equal((await s.read(`/api/threads/${CALLER}`)).canArchive, false);
  for (const status of ['running', 'in_progress', 'inprogress']) {
    s.bridge.read = async id => ({ thread: { id, kind: 'codex', hostId: 'local', status }, turns: [] });
    assert.equal((await s.post({ action: 'archive', value: true })).status, 403);
  }
  assert.equal(s.calls.length, 1);
});

test('invalid settings fail validation without native mutation', async t => {
  const s = await setup(t);
  for (const body of [null, [], {}, { action: 'create', value: 'title' }, { action: 'toString', value: true },
    { action: 'rename', value: ' ' }, { action: 'rename', value: 'x'.repeat(201) }, { action: 'rename', value: true },
    { action: 'pin', value: 1 }, { action: 'archive', value: false }, { action: 'archive', value: 'true' }]) {
    assert.equal((await s.post(body)).status, 400);
  }
  assert.equal((await s.post({ action: 'pin', value: true }, 'invalid')).status, 400);
  assert.equal(s.calls.length, 0);
});

test('management enforces authentication, read-only mode, and single-task scope', async t => {
  const off = await setup(t, { enableSend: false });
  assert.equal((await off.post({ action: 'pin', value: true })).status, 403);
  assert.equal((await off.read()).canManage, false);
  assert.deepEqual((await off.read('/api/status')).threadManagement, { rename: false, pin: false, archive: false });
  const s = await setup(t, { sendScope: 'single' });
  assert.equal((await s.post({ action: 'rename', value: 'title' }, CALLER)).status, 403);
  assert.equal((await s.post({ action: 'pin', value: true })).status, 200);
  assert.equal((await fetch(`${s.base}/api/threads/${TARGET}/settings`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${s.base}/api/threads/${TARGET}/settings`, { method: 'POST', headers: { ...s.headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  assert.equal(off.calls.length, 0); assert.equal(s.calls.length, 1);
});

test('management refuses remote, non-Codex, archived, and unknown-status targets', async t => {
  for (const properties of [{ hostId: 'remote' }, { kind: 'chatgpt' }, { archived: true }, { status: 'unknown' }, { status: 'failed' }]) {
    const s = await setup(t, { properties });
    assert.equal((await s.read()).canManage, false);
    assert.equal((await s.post({ action: 'rename', value: 'title' })).status, 403);
    assert.equal(s.calls.length, 0);
  }
});

test('delegated threads remain readable while all metadata mutations are disabled', async t => {
  const s = await setup(t, { properties: { delegated: true } });
  const data = await s.read(); assert.equal(data.thread.delegated, true); assert.equal(data.canManage, false); assert.equal(data.canArchive, false);
  for (const body of [{ action: 'rename', value: 'title' }, { action: 'pin', value: true }, { action: 'archive', value: true }]) assert.equal((await s.post(body)).status, 403);
  assert.equal(s.calls.length, 0);
});

test('catalog availability gates status and every settings dispatch', async t => {
  const s = await setup(t, { names: ['list_threads', 'read_thread', 'set_thread_title'] });
  assert.deepEqual((await s.read('/api/status')).threadManagement, { rename: true, pin: false, archive: false });
  assert.equal((await s.post({ action: 'pin', value: true })).status, 503);
  assert.equal((await s.post({ action: 'archive', value: true })).status, 503);
  assert.equal((await s.post({ action: 'rename', value: 'title' })).status, 200);
  assert.equal(s.calls.length, 1);
  s.bridge.capabilities = async () => { throw new BridgeError('offline'); };
  assert.deepEqual((await s.read('/api/status')).threadManagement, { rename: false, pin: false, archive: false });
  assert.equal((await s.post({ action: 'rename', value: 'title' })).status, 503);
  assert.equal(s.calls.length, 1);
  const callerOnly = await setup(t, { sendScope: 'single', allowedSendThreadId: CALLER });
  assert.deepEqual((await callerOnly.read('/api/status')).threadManagement, { rename: true, pin: true, archive: false });
});

test('settings operations share the per-task lock and never automatically retry unknown mutations', async t => {
  let release;
  const s = await setup(t, { manage: () => new Promise(resolve => { release = resolve; }) });
  const first = s.post({ action: 'rename', value: 'title' });
  for (let index = 0; !release && index < 50; index++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(release);
  try {
    assert.equal((await s.post({ action: 'pin', value: true })).status, 409);
    const send = await fetch(`${s.base}/api/threads/${TARGET}/messages`, { method: 'POST', headers: s.headers,
      body: JSON.stringify({ requestId: '00000000-0000-0000-0000-000000000010', prompt: 'overlap' }) });
    assert.equal(send.status, 409); assert.equal((await send.json()).code, 'SEND_BUSY');
  }
  finally { release(); }
  assert.equal((await first).status, 200); assert.equal(s.calls.length, 1);
  s.bridge.manage = async (...args) => { s.calls.push(args); throw new BridgeError('unknown', 'DELIVERY_UNKNOWN', 409); };
  const response = await s.post({ action: 'archive', value: true });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN');
  assert.equal(s.calls.length, 2);
});
