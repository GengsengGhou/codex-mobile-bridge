import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { BridgeError, DesktopBridge, encodeFrame, pipeRequest, normalizeThread } from '../src/desktop.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { DeliveryStore, promptHash } from '../src/delivery-store.mjs';

const ID = '00000000-0000-0000-0000-000000000001';
const data = { thread: { id: ID, kind: 'codex', hostId: 'local', title: '验收任务', status: 'idle' }, page: {}, turns: [] };
async function setup(t, { enableSend = false, status = 'idle', send, sendScope = 'single', deliveryStore = new DeliveryStore({ path: null }) } = {}) {
  let sends = 0;
  const bridge = { callerThreadId: ID, capabilities: async () => ['list_threads', 'read_thread', 'send_message_to_thread'],
    list: async () => ({ threads: [data.thread] }), read: async () => ({ ...data, thread: { ...data.thread, status } }),
    send: async (...args) => { sends++; return send?.(...args); } };
  const server = createBridgeServer({ bridge, enableSend, sendScope, deliveryStore });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base);
  const cookie = root.headers.get('set-cookie')?.split(';')[0];
  const headers = { cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  return { base, headers, bridge, sends: () => sends, post: body => fetch(`${base}/api/threads/${ID}/messages`, { method: 'POST', headers, body: JSON.stringify(body) }) };
}

test('updated desktop requires callerSource and returns the same requested task', async () => {
  const bridge = new DesktopBridge({ callerThreadId: ID, metadataReader: async () => ({}), request: async (_pipe, method, params) => {
    assert.equal(method, 'tools/call');
    if (params.callerSource !== 'codex') throw new BridgeError('Invalid app tool request', 'PROTOCOL_ERROR', 502);
    assert.equal(params.threadId, ID);
    assert.equal(params.arguments.threadId, ID);
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify(data) }] };
  } });
  assert.equal((await bridge.read(ID)).thread.id, ID);
});

test('each sidebar list follows current desktop preferences and transcript reads cannot overwrite collection ranks', async () => {
  let manual = false, metadataReads = 0;
  const bridge = new DesktopBridge({ callerThreadId: ID, metadataReader: async () => {
    metadataReads++; return { projects: [{ id: 'dev', rootPaths: ['E:/dev'] }], threadOrders: { dev: ['old', ID] }, sorting: { projectThreads: manual ? 'manual' : 'updated_at', chats: 'updated_at' } };
  } });
  bridge.call = async tool => tool === 'list_threads' ? { pinnedThreads: [], threads: [
    { id: ID, kind: 'codex', hostId: 'local', cwd: 'E:/dev', updatedAt: 1 },
    { id: 'old', kind: 'codex', hostId: 'local', cwd: 'E:/dev', updatedAt: 10 },
  ] } : { thread: { id: ID, kind: 'codex', cwd: 'E:/dev' }, turns: [] };
  const first = await bridge.list();
  assert.equal(first.threads[0].projectThreadOrder, 0);
  manual = true;
  const second = await bridge.list();
  assert.equal(second.threads[0].projectThreadOrder, 1); assert.equal(metadataReads, 2);
  const read = await bridge.read(ID);
  assert.equal(read.thread.projectThreadOrder, undefined); assert.equal(read.thread.projectOrder, undefined);
  assert.equal(read.thread.projectId, 'dev');
  assert.equal(metadataReads, 2);
});

test('metadata reads skip native tool outputs and transcript normalization while checking identity and delegated eligibility', async () => {
  const bridge = new DesktopBridge({ callerThreadId: ID, metadataReader: async () => ({}) });
  bridge.call = async (tool, args) => {
    assert.equal(tool, 'read_thread'); assert.equal(args.threadId, ID); assert.equal(args.turnLimit, 1); assert.equal(args.includeOutputs, false);
    return { thread: { id: ID, kind: 'codex', hostId: 'local', status: { type: 'active' }, parentThreadId: 'parent', cwd: 'E:/repo' },
      turns: [{ id: 'current', items: [{ type: 'agentMessage', text: 'private transcript' }] }] };
  };
  const actual = await bridge.readMetadata(ID);
  assert.equal(actual.thread.status, 'active'); assert.equal(actual.thread.delegated, true); assert.equal(actual.thread.cwd, 'E:/repo');
  assert.deepEqual(actual.turns, []); assert.doesNotMatch(JSON.stringify(actual), /private transcript|parentThreadId/);
  bridge.call = async () => ({ thread: { id: 'wrong' }, turns: [] });
  await assert.rejects(bridge.readMetadata(ID), { code: 'PROTOCOL_ERROR' });
});

test('output hydration rejection falls back once to the same read, preserving messages, paging and identity', async () => {
  const calls = [];
  const bridge = new DesktopBridge({ callerThreadId: ID, metadataReader: async () => ({}), request: async (_pipe, _method, params, options) => {
    calls.push({ args: params.arguments, options });
    assert.equal(params.tool, 'read_thread'); assert.equal(options.mutation, false);
    if (params.arguments.includeOutputs) throw new BridgeError('rejected', 'DESKTOP_REJECTED', 502);
    return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ...data,
      page: { hasMore: true, nextCursor: 'older', order: 'newest_first' },
      turns: [{ id: 'new', items: [{ id: 'reply', type: 'agentMessage', text: 'Readable reply' }] },
        { id: 'old', items: [{ id: 'input', type: 'userMessage', content: [{ type: 'text', text: 'Readable input' }] }] }]
    }) }] };
  } });
  const actual = await bridge.read(ID, 'original-cursor', { turnLimit: 3 });
  assert.equal(actual.outputsAvailable, false); assert.equal(actual.thread.id, ID);
  assert.equal(actual.page.nextCursor, 'older'); assert.equal(actual.page.hasMore, true);
  assert.deepEqual(actual.turns.map(turn => turn.id), ['old', 'new']);
  assert.deepEqual(actual.turns.flatMap(turn => turn.items).map(item => item.text), ['Readable input', 'Readable reply']);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, { ...calls[0].args, includeOutputs: false });
  assert.equal(calls[1].args.cursor, 'original-cursor'); assert.equal(calls[1].args.turnLimit, 3);
});

test('read fallback rejects wrong identity or shape and never retries unrelated failures or mutations', async () => {
  for (const reply of [null, [], { thread: { id: 'wrong' }, turns: [] }, { thread: { id: ID }, turns: null }]) {
    let calls = 0;
    const bridge = new DesktopBridge({ callerThreadId: ID });
    bridge.call = async () => { if (++calls === 1) throw new BridgeError('rejected', 'DESKTOP_REJECTED', 502); return reply; };
    await assert.rejects(bridge.read(ID), { code: 'PROTOCOL_ERROR' }); assert.equal(calls, 2);
  }
  for (const code of ['PROTOCOL_ERROR', 'DESKTOP_UNAVAILABLE', 'UNSUPPORTED_THREAD', 'DELIVERY_UNKNOWN']) {
    let calls = 0;
    const bridge = new DesktopBridge({ callerThreadId: ID });
    bridge.call = async () => { calls++; throw new BridgeError('fault', code); };
    await assert.rejects(bridge.read(ID), { code }); assert.equal(calls, 1);
  }
  let calls = 0;
  const bridge = new DesktopBridge({ callerThreadId: ID, request: async () => { calls++; throw new BridgeError('rejected', 'DESKTOP_REJECTED', 502); } });
  await assert.rejects(bridge.send(ID, 'no retry'), { code: 'DESKTOP_REJECTED' }); assert.equal(calls, 1);
});

test('successful output reads keep recognized delegation inputs and a fallback can recover on the next read', async () => {
  let failure = true;
  const bridge = new DesktopBridge({ callerThreadId: ID, metadataReader: async () => ({}) });
  bridge.call = async (_tool, args) => {
    if (failure && args.includeOutputs) throw new BridgeError('rejected', 'DESKTOP_REJECTED', 502);
    return { ...data, turns: [{ id: 'turn', items: [{ id: 'input', type: 'functionCallOutput', namespace: 'codex_app', name: 'create_thread',
      output: args.includeOutputs ? { text: '<codex_delegation><source_thread_id>parent</source_thread_id><input>Initial input</input></codex_delegation>', truncated: false } : undefined }] }] };
  };
  assert.equal((await bridge.read(ID)).outputsAvailable, false);
  failure = false;
  const recovered = await bridge.read(ID);
  assert.equal(recovered.outputsAvailable, undefined);
  assert.equal(recovered.turns[0].items[0].source, 'desktop-bridge'); assert.equal(recovered.turns[0].items[0].text, 'Initial input');
});

test('HTTP cannot emit or cache a snapshot from another thread even with a permissive adapter', async t => {
  const s = await setup(t, { enableSend: true });
  s.bridge.read = async () => ({ ...data, thread: { ...data.thread, id: 'wrong' } });
  const response = await fetch(`${s.base}/api/threads/${ID}`, { headers: s.headers });
  assert.equal(response.status, 502); assert.equal((await response.json()).code, 'PROTOCOL_ERROR');
  assert.equal(response.headers.get('etag'), null);
});

test('a healthy catalog cannot mask broken desktop reads, and recovery restores health', async t => {
  const s = await setup(t, { enableSend: true });
  const original = s.bridge.read;
  s.bridge.read = async () => { throw new BridgeError('接口已变化', 'PROTOCOL_ERROR', 502, { secret: 'hidden' }); };
  const failed = await (await fetch(`${s.base}/api/status`, { headers: s.headers })).json();
  assert.equal(failed.connected, false); assert.equal(failed.canSend, false);
  assert.deepEqual(failed.error, { code: 'PROTOCOL_ERROR', message: '接口已变化' });
  assert.ok(!JSON.stringify(failed).includes('hidden'));
  s.bridge.read = original;
  const recovered = await (await fetch(`${s.base}/api/status`, { headers: s.headers })).json();
  assert.equal(recovered.connected, true); assert.equal(recovered.error, null);
});
test('task normalization preserves identity/order and excludes hidden/tool payloads', () => {
  const actual = normalizeThread({ thread: { id: ID, status: { type: 'active' } }, page: { order: 'newest_first', hasMore: true, nextCursor: 'opaque' }, turns: [
    { id: 'new', items: [{ id: 'm', type: 'agentMessage', text: '<script>bad</script>' }, { type: 'reasoning', content: ['hidden'] }, { type: 'mcpToolCall', arguments: { apiKey: 'secret' }, status: 'completed' }] },
    { id: 'old', items: [{ type: 'userMessage', content: [{ type: 'text', text: '你好' }] }] },
  ] });
  assert.equal(actual.thread.id, ID); assert.equal(actual.thread.status, 'active');
  assert.deepEqual(actual.turns.map(t => t.id), ['old', 'new']);
  assert.equal(actual.page.nextCursor, 'opaque');
  assert.equal(actual.turns[1].items[0].text, '<script>bad</script>');
  assert.ok(!JSON.stringify(actual).includes('secret')); assert.ok(!JSON.stringify(actual).includes('hidden'));
});
test('HTTP API requires session, custom header, matching Origin and Host', async t => {
  const s = await setup(t);
  assert.equal((await fetch(`${s.base}/api/threads`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/threads`, { headers: { ...s.headers, Origin: 'https://evil.example' } })).status, 403);
  const reboundStatus = await new Promise((resolve, reject) => {
    const req = http.get(`${s.base}/api/threads`, { headers: { ...s.headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal((await fetch(`${s.base}/api/threads`, { headers: { ...s.headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${s.base}/api/threads`, { headers: s.headers })).status, 200);
});

test('normalization preserves delegated read-only identity without exposing agent metadata', () => {
  for (const properties of [{ parentThreadId: ID }, { agentNickname: 'worker' }, { source: { subAgent: { spawn: { parent_thread_id: ID } } } }, { source: { subagent: 'private payload' } }]) {
    const normalized = normalizeThread({ thread: { id: ID, ...properties }, turns: [] });
    assert.equal(normalized.thread.delegated, true);
    assert.equal(JSON.stringify(normalized).includes('private payload'), false);
    assert.equal(normalized.thread.source, undefined); assert.equal(normalized.thread.parentThreadId, undefined);
  }
  assert.equal(normalizeThread({ thread: { id: ID, source: 'vscode' }, turns: [] }).thread.delegated, undefined);
});
test('desktop delegation input is visible while unrelated and truncated outputs remain private', () => {
  const envelope = '<codex_delegation>\n <source_thread_id>test</source_thread_id>\n <input>你好 <input>literal</input>\n第二行</input>\n</codex_delegation>';
  const actual = normalizeThread({ thread: { id: ID }, turns: [{ id: 't', items: [
    { id: 'input', type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: envelope, truncated: false } },
    { type: 'functionCallOutput', name: 'exec_command', output: { text: 'private-token' } },
    { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread', output: { text: envelope, truncated: true } },
  ] }] });
  const inputs = actual.turns[0].items.filter(i => i.type === 'userMessage');
  assert.equal(inputs.length, 1); assert.equal(inputs[0].text, '你好 <input>literal</input>\n第二行');
  assert.ok(!JSON.stringify(actual).includes('private-token'));
});
test('known subagent rejection is distinguished from uncertain mutation failure', async () => {
  const bridge = new DesktopBridge({ callerThreadId: ID, request: async () => ({ success: false, contentItems: [{ type: 'inputText', text: 'direct app-server input is not allowed for multi-agent v2 sub-agents' }] }) });
  await assert.rejects(bridge.send(ID, 'test'), e => e.code === 'UNSUPPORTED_THREAD');
  bridge.request = async () => ({ success: false });
  await assert.rejects(bridge.send(ID, 'test'), e => e.code === 'DELIVERY_UNKNOWN');
});
test('status identifies the enabled task and accepted messages carry desktop receipts', async t => {
  const s = await setup(t, { enableSend: true });
  const status = await (await fetch(`${s.base}/api/status`, { headers: s.headers })).json();
  assert.equal(status.allowedSendThreadId, ID); assert.equal(status.defaultThreadId, ID);
  const requestId = randomUUID();
  const receipt = await (await s.post({ requestId, prompt: 'receipt' })).json();
  assert.equal(receipt.threadId, ID); assert.equal(receipt.requestId, requestId);
  assert.ok(Number.isFinite(Date.parse(receipt.acceptedAt)));
});
test('read-only mode rejects writes before calling desktop', async t => {
  const s = await setup(t);
  const response = await s.post({ requestId: randomUUID(), prompt: '你好' });
  assert.equal(response.status, 403); assert.equal(s.sends(), 0);
});
test('duplicate request ID returns same outcome and dispatches once', async t => {
  const s = await setup(t, { enableSend: true });
  const message = { requestId: randomUUID(), prompt: '只回复测试通过' };
  assert.equal((await s.post(message)).status, 200);
  assert.equal((await s.post(message)).status, 200);
  assert.equal(s.sends(), 1);
  assert.equal((await s.post({ ...message, prompt: '不同消息' })).status, 409);
});
test('unknown delivery is never automatically dispatched again', async t => {
  const s = await setup(t, { enableSend: true, send: () => { throw new BridgeError('unknown', 'DELIVERY_UNKNOWN', 409); } });
  const message = { requestId: randomUUID(), prompt: '测试消息' };
  assert.equal((await s.post(message)).status, 409);
  const second = await s.post(message);
  assert.equal((await second.json()).code, 'DELIVERY_UNKNOWN'); assert.equal(s.sends(), 1);
});

async function journalPath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-delivery-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'deliveries.json');
}
const lookup = (s, requestId, id = ID) => fetch(`${s.base}/api/threads/${id}/messages/${requestId}`, { headers: s.headers });

test('persisted accepted receipts survive restart and cannot dispatch a second time', async t => {
  const path = await journalPath(t);
  const message = { requestId: randomUUID(), prompt: 'restart receipt' };
  const first = await setup(t, { enableSend: true, deliveryStore: new DeliveryStore({ path }) });
  const receipt = await (await first.post(message)).json();
  const restarted = await setup(t, { enableSend: true, deliveryStore: new DeliveryStore({ path }) });
  assert.deepEqual(await (await restarted.post(message)).json(), receipt);
  assert.equal(first.sends(), 1); assert.equal(restarted.sends(), 0);
  assert.deepEqual(await (await lookup(restarted, message.requestId)).json(), { state: 'accepted', receipt });
  assert.equal((await restarted.post({ ...message, prompt: 'changed' })).status, 409);
});

test('pending journal entries survive restart as unknown and never redispatch', async t => {
  const path = await journalPath(t), message = { requestId: randomUUID(), prompt: 'pending' };
  await new DeliveryStore({ path }).reserve({ requestId: message.requestId, threadId: ID, promptHash: promptHash(message.prompt) });
  const s = await setup(t, { enableSend: true, deliveryStore: new DeliveryStore({ path }) });
  assert.deepEqual(await (await lookup(s, message.requestId)).json(), { state: 'unknown' });
  assert.equal((await (await s.post(message)).json()).code, 'DELIVERY_UNKNOWN');
  assert.equal(s.sends(), 0);
});

test('authenticated receipt lookup works with sending disabled and is scoped to its task', async t => {
  const deliveryStore = new DeliveryStore({ path: null }), requestId = randomUUID();
  await deliveryStore.reserve({ requestId, threadId: ID, promptHash: promptHash('receipt') });
  const receipt = { accepted: true, threadId: ID, requestId, acceptedAt: new Date().toISOString() };
  await deliveryStore.accept(requestId, receipt);
  const s = await setup(t, { deliveryStore });
  assert.deepEqual(await (await lookup(s, requestId)).json(), { state: 'accepted', receipt });
  assert.deepEqual(await (await lookup(s, requestId, '00000000-0000-0000-0000-000000000002')).json(), { state: 'not_found' });
  assert.deepEqual(await (await lookup(s, randomUUID())).json(), { state: 'not_found' });
  assert.equal((await lookup(s, 'invalid')).status, 400);
  assert.equal((await fetch(`${s.base}/api/threads/${ID}/messages/${requestId}`)).status, 401);
  assert.equal(s.sends(), 0);
});

test('reservation persistence failure prevents dispatch; receipt persistence failure remains unknown', async t => {
  for (const phase of ['reserve', 'accept']) {
    const deliveryStore = new DeliveryStore({ path: null });
    let writes = 0;
    deliveryStore.persist = async () => { if (++writes === (phase === 'reserve' ? 1 : 2)) throw new BridgeError('disk unavailable', 'DELIVERY_STORE_UNAVAILABLE', 503); };
    const s = await setup(t, { enableSend: true, deliveryStore });
    const message = { requestId: randomUUID(), prompt: 'write failure' };
    const response = await s.post(message);
    assert.equal(response.status, phase === 'reserve' ? 503 : 409);
    assert.equal(s.sends(), phase === 'reserve' ? 0 : 1);
    if (phase === 'accept') {
      assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN');
      assert.deepEqual(await (await lookup(s, message.requestId)).json(), { state: 'unknown' });
      assert.equal((await s.post(message)).status, 409); assert.equal(s.sends(), 1);
    }
  }
});

test('corrupt delivery journals fail closed before dispatch and receipt lookup', async t => {
  const path = await journalPath(t);
  await writeFile(path, '{broken');
  const s = await setup(t, { enableSend: true, deliveryStore: new DeliveryStore({ path }) });
  const message = { requestId: randomUUID(), prompt: 'corrupt journal' };
  assert.equal((await (await s.post(message)).json()).code, 'DELIVERY_STORE_UNAVAILABLE');
  assert.equal((await lookup(s, message.requestId)).status, 503); assert.equal(s.sends(), 0);
});

test('safe desktop rejections release reservations while protocol failures retain unknown entries', async t => {
  for (const code of ['DESKTOP_UNAVAILABLE', 'DESKTOP_REJECTED', 'UNSUPPORTED_THREAD', 'PROTOCOL_ERROR']) {
    const s = await setup(t, { enableSend: true, send: () => { throw new BridgeError('rejected', code, 502); } });
    const message = { requestId: randomUUID(), prompt: 'rejected' };
    assert.equal((await s.post(message)).status, 502);
    assert.deepEqual(await (await lookup(s, message.requestId)).json(), { state: code === 'PROTOCOL_ERROR' ? 'unknown' : 'not_found' });
    assert.equal(s.sends(), 1);
  }
});
test('active ordinary task accepts follow-ups while single-task scope remains enforced', async t => {
  const s = await setup(t, { enableSend: true, status: 'active' });
  const read = await (await fetch(`${s.base}/api/threads/${ID}`, { headers: s.headers })).json();
  assert.equal(read.canSend, true); assert.equal(read.sendMode, 'follow-up');
  assert.equal((await s.post({ requestId: randomUUID(), prompt: '测试' })).status, 200);
  const response = await fetch(`${s.base}/api/threads/00000000-0000-0000-0000-000000000002/messages`, { method: 'POST', headers: s.headers, body: '{}' });
  assert.equal(response.status, 403); assert.equal(s.sends(), 1);
});

test('all-local sending accepts other local tasks but rejects remote and non-Codex records', async t => {
  const s = await setup(t, { enableSend: true, sendScope: 'all-local' });
  const otherId = '00000000-0000-0000-0000-000000000002';
  s.bridge.read = async id => ({ ...data, thread: { ...data.thread, id } });
  const post = () => fetch(`${s.base}/api/threads/${otherId}/messages`, { method: 'POST', headers: s.headers, body: JSON.stringify({ requestId: randomUUID(), prompt: '普通任务' }) });
  assert.equal((await post()).status, 200);
  for (const properties of [{ kind: 'chatgpt' }, { hostId: 'remote' }, { archived: true }]) {
    s.bridge.read = async id => ({ ...data, thread: { ...data.thread, id, ...properties } });
    assert.equal((await post()).status, 403);
  }
  assert.equal(s.sends(), 1);
  const status = await (await fetch(`${s.base}/api/status`, { headers: s.headers })).json();
  assert.equal(status.sendScope, 'all-local'); assert.equal(status.allowedSendThreadId, null);
});

test('the same request ID cannot race preflight across two different tasks', async t => {
  const s = await setup(t, { enableSend: true, sendScope: 'all-local' });
  let release;
  s.bridge.read = async id => { await new Promise(r => { release = r; }); return { ...data, thread: { ...data.thread, id } }; };
  const requestId = randomUUID();
  const first = s.post({ requestId, prompt: 'one' });
  for (let i = 0; !release && i < 50; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(release);
  try {
    const other = await fetch(`${s.base}/api/threads/00000000-0000-0000-0000-000000000002/messages`, { method: 'POST', headers: s.headers, body: JSON.stringify({ requestId, prompt: 'two' }) });
    assert.equal(other.status, 409);
  } finally { release(); }
  assert.equal((await first).status, 200); assert.equal(s.sends(), 1);
});
test('simultaneous different sends cannot race the idle check', async t => {
  let complete;
  const s = await setup(t, { enableSend: true, send: () => new Promise(r => { complete = r; }) });
  const first = s.post({ requestId: randomUUID(), prompt: 'one' });
  for (let i = 0; !complete && i < 50; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(complete);
  try { assert.equal((await s.post({ requestId: randomUUID(), prompt: 'two' })).status, 409); }
  finally { complete(); }
  assert.equal((await first).status, 200); assert.equal(s.sends(), 1);
});
test('malformed JSON and non-object bodies do not trigger desktop sends', async t => {
  const s = await setup(t, { enableSend: true });
  for (const body of ['null', '[]', '{']) {
    const response = await fetch(`${s.base}/api/threads/${ID}/messages`, { method: 'POST', headers: s.headers, body });
    assert.equal(response.status, 400);
  }
  assert.equal(s.sends(), 0);
});
async function pipeFixture(t, handler) {
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\codex-mobile-test-${randomUUID()}` : join(tmpdir(), `cmb-${randomUUID()}.sock`);
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.once('data', chunk => handler(socket, chunk)); });
  await new Promise(r => server.listen(address, r));
  t.after(() => new Promise(r => { for (const s of sockets) s.destroy(); server.close(r); }));
  return address;
}
test('pipe framing handles split headers and Chinese UTF-8 payloads', async t => {
  const path = await pipeFixture(t, socket => {
    const frame = encodeFrame({ jsonrpc: '2.0', id: 1, result: { message: '中文分段消息' } });
    socket.write(frame.subarray(0, 2)); setTimeout(() => socket.write(frame.subarray(2, 19)), 5); setTimeout(() => socket.write(frame.subarray(19)), 10);
  });
  assert.deepEqual(await pipeRequest(path, 'tools/list', {}), { message: '中文分段消息' });
});

test('real pipe rejection triggers only the bounded output-free read while parallel sockets retain thread identity', async t => {
  const other = '00000000-0000-0000-0000-000000000002', requests = [];
  const path = await pipeFixture(t, (socket, bytes) => {
    const request = JSON.parse(bytes.subarray(4).toString('utf8')), args = request.params.arguments; requests.push(args);
    if (args.threadId === ID && args.includeOutputs) {
      socket.end(encodeFrame({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'Codex app tool request failed' } })); return;
    }
    const result = { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ ...data, thread: { ...data.thread, id: args.threadId } }) }] };
    const send = () => socket.end(encodeFrame({ jsonrpc: '2.0', id: 1, result }));
    if (args.threadId === ID) setTimeout(send, 20); else send();
  });
  const bridge = new DesktopBridge({ pipePath: path, callerThreadId: ID, metadataReader: async () => ({}) });
  const [first, second] = await Promise.all([bridge.read(ID), bridge.read(other)]);
  assert.equal(first.thread.id, ID); assert.equal(first.outputsAvailable, false);
  assert.equal(second.thread.id, other); assert.equal(second.outputsAvailable, undefined);
  assert.equal(requests.filter(args => args.threadId === ID).length, 2); assert.equal(requests.filter(args => args.threadId === other).length, 1);
});
test('disconnect after a mutation write reports unknown delivery', async t => {
  const path = await pipeFixture(t, socket => socket.destroy());
  await assert.rejects(pipeRequest(path, 'tools/call', {}, { mutation: true }), e => e.code === 'DELIVERY_UNKNOWN');
});
test('oversized desktop frame is rejected without allocation', async t => {
  const path = await pipeFixture(t, socket => { const header = Buffer.alloc(4); header.writeUInt32LE(9000000); socket.write(header); });
  await assert.rejects(pipeRequest(path, 'tools/list', {}), e => e.code === 'PROTOCOL_ERROR');
});
test('read timeout disconnects without hanging server', async t => {
  const path = await pipeFixture(t, () => {});
  await assert.rejects(pipeRequest(path, 'tools/list', {}, { timeoutMs: 30 }), e => e.code === 'DESKTOP_UNAVAILABLE');
});

test('invalid request protocol errors are distinguished from desktop availability', async t => {
  const path = await pipeFixture(t, socket => socket.end(encodeFrame({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid app tool request' } })));
  await assert.rejects(pipeRequest(path, 'tools/call', {}), e => e.code === 'PROTOCOL_ERROR');
});
