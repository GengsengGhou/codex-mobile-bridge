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
async function fixture(t, { enableSend = true, sendScope = 'single', properties = {}, failStop = false, controlError, responseError, gate, pending = PENDING, historicalQuestions = [], deliveryStore } = {}) {
  let stops = 0, responses = 0;
  const control = {
    snapshot: async id => { if (controlError) throw new BridgeError('internal diagnostic', controlError, 503); return { threadId: id, currentTurnId: 'turn-1', ownerClientId: 'private-owner', pendingRequests: [pending], historicalQuestions }; },
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
