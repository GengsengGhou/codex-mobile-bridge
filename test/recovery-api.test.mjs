import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';
import { BridgeError } from '../src/desktop.mjs';

async function fixture(t, recovery = null) {
  const bridge = { callerThreadId: '00000000-0000-0000-0000-000000000071',
    capabilities: () => assert.fail('Recovery must not depend on desktop connection'),
    read: () => assert.fail('Recovery must not read chats') };
  const server = createBridgeServer({ bridge, recovery });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base); await response.text();
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-bridge-client': 'mobile-v1', 'content-type': 'application/json' };
  return (options = {}) => fetch(`${base}/api/recovery`, { ...options, headers: { ...headers, ...options.headers } });
}

test('recovery status and setting changes work independently of offline desktop', async t => {
  const state = { supported: true, autoStart: false, autoRestart: true, supervisorRunning: true, state: 'running' };
  const updates = [];
  const request = await fixture(t, { status: async () => state, configure: async patch => { updates.push(patch); Object.assign(state, patch); return state; } });
  assert.deepEqual(await (await request()).json(), state);
  const result = await request({ method: 'PUT', body: JSON.stringify({ autoStart: true }) });
  assert.equal(result.status, 200);
  assert.equal((await result.json()).autoStart, true);
  assert.deepEqual(updates, [{ autoStart: true }]);
});

test('recovery API rejects unauthorized, cross-site and malformed mutations before dispatch', async t => {
  let mutations = 0;
  const request = await fixture(t, { status: async () => ({}), configure: async () => { mutations++; return {}; } });
  const valid = { method: 'PUT', body: '{"autoRestart":false}' };
  assert.equal((await request({ ...valid, headers: { cookie: '' } })).status, 401);
  assert.equal((await request({ ...valid, headers: { 'x-bridge-client': '' } })).status, 401);
  assert.equal((await request({ ...valid, headers: { origin: 'https://elsewhere.example' } })).status, 403);
  assert.equal((await request({ ...valid, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await request({ ...valid, headers: { 'content-type': 'text/plain' } })).status, 400);
  for (const body of ['{}', '[]', 'null', '{"autoStart":1}', '{"autoStart":"false"}', '{"autoStart":true,"command":"whoami"}']) {
    assert.equal((await request({ method: 'PUT', body })).status, 400);
  }
  assert.equal((await request({ method: 'POST' })).status, 405);
  assert.equal(mutations, 0);
});

test('embedded server defaults cannot change OS startup and known failures remain visible', async t => {
  const request = await fixture(t);
  assert.equal((await (await request()).json()).supported, false);
  assert.equal((await request({ method: 'PUT', body: '{"autoStart":true}' })).status, 503);
  const failed = await fixture(t, { status: async () => { throw new BridgeError('无法读取登录启动项', 'RECOVERY_UNAVAILABLE', 503); } });
  const response = await failed();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '无法读取登录启动项', code: 'RECOVERY_UNAVAILABLE' });
});
