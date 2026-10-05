import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';
import { BridgeError } from '../src/desktop.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ID = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';
const ATTEMPT = '00000000-0000-0000-0000-000000000003';
const PENDING = { requestId: 'private-request', kind: 'userInput', token: 'a'.repeat(64), actionable: true, attemptId: ATTEMPT, fingerprint: 'b'.repeat(64) };
async function fixture(t, { enableSend = true, sendScope = 'single', properties = {}, failStop = false, controlError, controlDiagnostic, responseError, gate, pending = PENDING, historicalQuestions = [], deliveryStore } = {}) {
  let stops = 0, responses = 0;
  const control = {
    snapshot: async id => { if (controlError) throw Object.assign(new BridgeError('internal diagnostic', controlError, 503), { controlDiagnostic }); return { threadId: id, currentTurnId: 'turn-1', ownerClientId: 'private-owner', pendingRequests: [pending], historicalQuestions }; },
    context: async id => control.snapshot(id),
    respond: async (id, body, { beforeDispatch }) => {
      if (body.token !== pending.token) throw new BridgeError('Changed request', 'REQUEST_CHANGED', 409);
      if (!body.answers) throw new BridgeError('Invalid answer', 'INVALID_REQUEST', 400);
      await beforeDispatch(pending); responses++; await gate;
      if (responseError) throw new BridgeError('Delivery uncertain', responseError, 409);
      return { threadId: id, requestId: pending.requestId, delivered: true };
    },
    stop: async (id, turnId) => { stops++; if (failStop) throw new BridgeError('Changed turn', 'TURN_CHANGED', 409); return { threadId: id, interruptedTurnId: turnId, stopped: true }; }
  };
  const bridge = { callerThreadId: ID, read: async id => ({ thread: { id, kind: 'codex', hostId: 'local', status: 'active', ...properties }, turns: [] }) };
  const server = createBridgeServer({ bridge, control, enableSend, sendScope, ...(deliveryStore ? { deliveryStore } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  return { stops: () => stops, responses: () => responses, read: id => fetch(`${base}/api/threads/${id}/control`, { headers }), readThread: id => fetch(`${base}/api/threads/${id}`, { headers }),
    readContext: id => fetch(`${base}/api/threads/${id}/context`, { headers }),
    respond: (id = ID, body = { requestId: pending.requestId, token: pending.token, answers: { q: { answers: ['private answer'] } } }, extraHeaders = {}) => fetch(`${base}/api/threads/${id}/respond`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) }),
    stop: (id, body = { turnId: 'turn-1' }, extraHeaders = {}) => fetch(`${base}/api/threads/${id}/stop`, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) }) };
}

test('control HTTP exposes only run metadata and requires an explicit turn for stopping', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.read(ID)).json(), { available: true, threadId: ID, canStop: true, turnId: 'turn-1', pendingRequestCount: 1, pendingRequests: [{ requestId: 'private-request', kind: 'userInput', token: PENDING.token, actionable: true }] });
  assert.equal((await f.stop(ID, {})).status, 400);
  assert.equal(f.stops(), 0);
  assert.deepEqual(await (await f.stop(ID)).json(), { threadId: ID, turnId: 'turn-1', stopped: true, goalPauseError: false });
  assert.equal(f.stops(), 1);
});

test('historical async questions are public read-only history and do not change pending count', async t => {
  const history = { ...PENDING, requestId: 'async:old', kind: 'asyncUserInput', actionable: false, historical: true, questions: [{ question: 'Old choice?' }] };
  const f = await fixture(t, { historicalQuestions: [history] });
  const body = await (await f.read(ID)).json();
  assert.equal(body.pendingRequestCount, 1);
  assert.equal(body.historicalQuestions.length, 1);
  assert.equal(body.historicalQuestions[0].actionable, false);
  assert.equal(body.historicalQuestions[0].fingerprint, undefined);
  assert.equal(body.historicalQuestions[0].attemptId, undefined);
});

test('responses enforce authentication, origin, scope, local ordinary thread and validation before dispatch', async t => {
  const f = await fixture(t);
  assert.equal((await f.respond(ID, undefined, { Cookie: '' })).status, 401);
  assert.equal((await f.respond(ID, undefined, { Origin: 'http://untrusted.example' })).status, 403);
  assert.equal((await f.respond(OTHER)).status, 403);
  assert.equal((await f.respond(ID, { token: 'old', answers: {} })).status, 409);
  assert.equal((await f.respond(ID, { token: PENDING.token })).status, 400);
  assert.equal(f.responses(), 0);
  for (const config of [{ enableSend: false }, { properties: { kind: 'chatgpt' } }, { properties: { hostId: 'remote' } }, { properties: { archived: true } }, { properties: { delegated: true } }]) {
    const restricted = await fixture(t, config);
    assert.equal((await restricted.respond()).status, 403);
    assert.equal(restricted.responses(), 0);
  }
  assert.equal((await f.respond()).status, 200);
});

test('durable accepted and unknown responses prevent repeat dispatch across server restart and token rotation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bridge-response-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const responseError of [undefined, 'DELIVERY_UNKNOWN']) {
    const path = join(directory, responseError ?? 'accepted');
    const f = await fixture(t, { deliveryStore: new DeliveryStore({ path }), responseError });
    const first = await f.respond();
    assert.equal(first.status, responseError ? 409 : 200);
    if (!responseError) assert.deepEqual(await first.json(), { threadId: ID, requestId: PENDING.requestId, delivered: true });
    assert.equal((await f.respond()).status, 409); assert.equal(f.responses(), 1);
    const rotated = await fixture(t, { deliveryStore: new DeliveryStore({ path }), pending: { ...PENDING, token: 'c'.repeat(64) } });
    const duplicate = await rotated.respond();
    assert.equal((await duplicate.json()).code, 'RESPONSE_ALREADY_ATTEMPTED');
    assert.equal(rotated.responses(), 0);
    const visible = (await (await rotated.read(ID)).json()).pendingRequests[0];
    assert.equal(visible.actionable, false); assert.equal(visible.responseState, responseError ? 'unknown' : 'delivered');
    const stored = await readFile(path, 'utf8');
    assert.ok(!stored.includes('private answer')); assert.ok(!stored.includes(PENDING.token));
  }
});

test('response operations share the per-thread lock with stops and release it after delivery', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { gate });
  const first = f.respond();
  try {
    while (!f.responses()) await new Promise(resolve => setImmediate(resolve));
    assert.equal((await (await f.respond()).json()).code, 'SEND_BUSY');
    assert.equal((await (await f.stop(ID)).json()).code, 'SEND_BUSY');
  } finally { release(); }
  assert.equal((await first).status, 200);
  assert.equal((await f.stop(ID)).status, 200);
});

test('control cannot bypass session, origin, sending scope, or ordinary local task restrictions', async t => {
  const f = await fixture(t);
  assert.equal((await f.stop(ID, undefined, { Cookie: '' })).status, 401);
  assert.equal((await f.stop(ID, undefined, { Origin: 'http://untrusted.example' })).status, 403);
  assert.equal((await f.stop(OTHER)).status, 403);
  assert.equal(f.stops(), 0);
  for (const config of [{ enableSend: false }, { properties: { kind: 'chatgpt' } }, { properties: { hostId: 'remote' } }, { properties: { archived: true } }, { properties: { delegated: true } }]) {
    const restricted = await fixture(t, config);
    assert.equal((await (await restricted.read(ID)).json()).canStop, false);
    assert.equal((await restricted.stop(ID)).status, 403);
    assert.equal(restricted.stops(), 0);
  }
});

test('changed-turn stop is surfaced without retrying or changing the target', async t => {
  const f = await fixture(t, { failStop: true });
  const result = await f.stop(ID);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'TURN_CHANGED');
  assert.equal(f.stops(), 1);
});

test('control compatibility and unloaded-owner failures leave conversation reads available', async t => {
  for (const controlError of ['OWNER_UNAVAILABLE', 'PROTOCOL_ERROR', 'PROTOCOL_INCOMPATIBLE']) {
    const f = await fixture(t, { controlError });
    const control = await (await f.read(ID)).json();
    assert.equal(control.available, false);
    assert.equal(control.code, controlError);
    assert.ok(!JSON.stringify(control).includes('internal diagnostic'));
    const thread = await (await f.readThread(ID)).json();
    assert.equal(thread.thread.id, ID);
    assert.equal(thread.canSend, true);
    assert.equal(f.stops(), 0);
  }
});

test('native frame failures expose honest bounded diagnostics while conversation reads remain available', async t => {
  for (const [controlError, nativeReason, wording] of [
    ['CONTROL_FRAME_TOO_LARGE', 'frame-too-large', /超过读取上限/],
    ['CONTROL_FRAME_INVALID', 'invalid-frame', /数据格式无效/]
  ]) {
    const f = await fixture(t, { controlError, controlDiagnostic: {
      reason: nativeReason, phase: 'receive', bytes: 33554433, limit: 33554432,
      payload: 'private transcript and credential', method: 'private native method'
    } });
    for (const read of [f.read, f.readContext]) {
      const result = await read(ID); assert.equal(result.status, 200);
      const body = await result.json();
      assert.equal(body.available, false); assert.equal(body.code, controlError); assert.equal(body.nativeReason, nativeReason);
      assert.match(body.reason, wording); assert.equal(body.standby, undefined);
      assert.equal(body.canStop === true, false);
      assert.doesNotMatch(JSON.stringify(body), /private|credential|internal diagnostic|33554433|33554432/);
    }
    const thread = await (await f.readThread(ID)).json();
    assert.equal(thread.thread.id, ID); assert.equal(thread.canSend, true);
    assert.equal(f.stops(), 0); assert.equal(f.responses(), 0);
  }
});

test('owner read diagnostics distinguish timeout and disconnect without claiming the entire chat cannot continue', async t => {
  for (const [reason, expected] of [['no-client-found', /会话待命/], ['request-timeout', /超时/], ['client-disconnected', /连接已断开/], ['server-closed', /连接已断开/]]) {
    const f = await fixture(t, { properties: { status: 'notLoaded' }, controlError: 'OWNER_UNAVAILABLE', controlDiagnostic: { reason, method: 'thread-owner-discovery', version: 1 } });
    const control = await (await f.read(ID)).json();
    assert.equal(control.code, 'OWNER_UNAVAILABLE'); assert.equal(control.canStop, false);
    assert.equal(control.nativeReason, reason);
    assert.match(control.reason, expected); assert.match(control.reason, /沿用桌面设置/);
    assert.equal(control.standby === true, reason === 'no-client-found');
    assert.doesNotMatch(control.reason, /请在桌面/);
    const thread = await (await f.readThread(ID)).json();
    assert.equal(thread.canSend, true); assert.equal(f.stops(), 0);
  }
});

test('a loaded owner missing is a failure rather than cold standby', async t => {
  const f = await fixture(t, { properties: { status: 'idle' }, controlError: 'OWNER_UNAVAILABLE', controlDiagnostic: { reason: 'no-client-found' } });
  const body = await (await f.read(ID)).json();
  assert.equal(body.available, false); assert.equal(body.canStop, false); assert.equal(body.standby, undefined);
  assert.match(body.reason, /暂时无法读取/);
});

test('unavailable read diagnostics whitelist reason codes without exposing native text', async t => {
  const f = await fixture(t, { controlError: 'OWNER_UNAVAILABLE', controlDiagnostic: { reason: 'private prompt and token', method: 'private-native-data', version: 1 } });
  const body = await (await f.read(ID)).json();
  assert.equal(body.nativeReason, 'unknown-desktop-error'); assert.doesNotMatch(JSON.stringify(body), /private prompt|private-native|token/);
  assert.equal(body.available, false); assert.equal(body.canStop, false);
});

test('supplemental reads share current GET work, then recover cold standby with a fresh owner snapshot', async t => {
  let reads = 0, snapshots = 0, releaseRead, releaseSnapshot, unavailable = true;
  let readGate = new Promise(resolve => { releaseRead = resolve; });
  let snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  const bridge = { callerThreadId: ID, read: async id => { reads++; await readGate; return { thread: { id, kind: 'codex', hostId: 'local', status: 'notLoaded' }, turns: [] }; } };
  const context = { permissions: { supported: false, current: 'unknown', options: [] }, agents: { items: [] }, sources: { items: [] } };
  const control = { context: async () => { throw Error('ordinary context must share native snapshot'); }, snapshot: async id => {
    snapshots++; await snapshotGate;
    if (unavailable) throw Object.assign(new BridgeError('missing', 'OWNER_UNAVAILABLE'), { controlDiagnostic: { reason: 'no-client-found' } });
    return { threadId: id, currentTurnId: 'fresh-turn', pendingRequests: [], threadContext: context };
  } };
  const server = createBridgeServer({ bridge, control, enableSend: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1' };
  const get = path => fetch(`${base}/api/threads/${ID}/${path}`, { headers }).then(res => res.json());
  const pending = [get('control'), get('context')];
  while (reads === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(reads, 1); releaseRead();
  while (snapshots === 0) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(snapshots, 1); releaseSnapshot();
  const initial = await Promise.all(pending);
  assert.ok(initial.every(body => body.available === false && body.standby === true));
  unavailable = false; readGate = Promise.resolve(); snapshotGate = Promise.resolve();
  const recovered = await get('control');
  assert.equal(reads, 2); assert.equal(snapshots, 2);
  assert.equal(recovered.available, true); assert.equal(recovered.canStop, true); assert.equal(recovered.turnId, 'fresh-turn'); assert.equal(recovered.standby, undefined);
});

test('delegated context uses its read-only adapter while control stays forbidden', async t => {
  let snapshots = 0, contexts = 0;
  const bridge = { callerThreadId: ID, read: async id => ({ thread: { id, kind: 'codex', hostId: 'local', status: 'idle', delegated: true }, turns: [] }) };
  const control = { snapshot: async () => { snapshots++; throw Error('delegated control must not run'); }, context: async id => {
    contexts++; return { threadId: id, threadContext: { permissions: { supported: false, current: 'unknown', options: [] }, agents: { items: [] }, sources: { items: [] } } };
  } };
  const server = createBridgeServer({ bridge, control, enableSend: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1' };
  const [run, context] = await Promise.all(['control', 'context'].map(path => fetch(`${base}/api/threads/${ID}/${path}`, { headers }).then(res => res.json())));
  assert.equal(run.available, false); assert.equal(run.canStop, false); assert.equal(context.available, true);
  assert.equal(context.permissions.canOverride, false); assert.equal(snapshots, 0); assert.equal(contexts, 1);
});
