import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';

async function fixture(t, remoteAccess) {
  const bridge = { callerThreadId: '00000000-0000-0000-0000-000000000001' };
  const server = createBridgeServer({ bridge, remoteAccess });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base); await response.text();
  const headers = { cookie: response.headers.get('set-cookie').split(';')[0], 'x-bridge-client': 'mobile-v1', 'content-type': 'application/json' };
  return (path, options = {}) => fetch(base + path, { ...options, headers: { ...headers, ...options.headers } });
}

test('local setup requires authenticated exact actions and never starts from reads', async t => {
  const calls = [];
  const state = { supported: true, installed: true, state: 'stopped', url: null };
  const request = await fixture(t, { status: async () => state, start: async () => { calls.push('start'); return { ...state, state: 'starting', accessCode: 'one-time-test-code' }; }, stop: async () => { calls.push('stop'); return state; } });
  assert.deepEqual(await (await request('/api/access')).json(), { mode: 'local', authenticated: true });
  assert.deepEqual(await (await request('/api/remote-access')).json(), state);
  assert.deepEqual(calls, []);
  const post = { method: 'POST', body: '{"action":"start"}' };
  assert.equal((await request('/api/remote-access', { ...post, headers: { cookie: '' } })).status, 401);
  assert.equal((await request('/api/remote-access', { ...post, headers: { origin: 'https://evil.example' } })).status, 403);
  for (const body of ['{}', 'null', '{"action":"install"}', '{"action":"start","port":80}']) assert.equal((await request('/api/remote-access', { method: 'POST', body })).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await (await request('/api/remote-access', post)).json()).accessCode, 'one-time-test-code');
  assert.equal((await request('/api/remote-access', { method: 'POST', body: '{"action":"stop"}' })).status, 200);
  assert.deepEqual(calls, ['start', 'stop']);
});

test('embedded server has no provisioner or installation side effects', async t => {
  const request = await fixture(t);
  assert.equal((await (await request('/api/remote-access')).json()).supported, false);
  assert.equal((await request('/api/remote-access', { method: 'POST', body: '{"action":"start"}' })).status, 503);
});
