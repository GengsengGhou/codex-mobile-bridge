import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { createDesktopRequest } from '../src/discovery.mjs';
import { BridgeError } from '../src/desktop.mjs';

const CALLER = '11111111-1111-4111-8111-111111111111';
const TARGET = '22222222-2222-4222-8222-222222222222';
async function fixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'bridge-runtime-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return resolve(root, 'runtime.json');
}

test('saved startup config works without desktop environment and excludes private environment', async t => {
  const configPath = await fixture(t);
  const env = { CODEX_THREAD_ID: CALLER, BRIDGE_ENABLE_SEND: '1', BRIDGE_SEND_THREAD_ID: TARGET,
    BRIDGE_SEND_SCOPE: 'all-local', BRIDGE_PORT: '14317', CODEX_APP_TOOLS_PIPE_PATH: 'private-pipe',
    OPENAI_API_KEY: 'private-token', UNRELATED_ENVIRONMENT: 'private-setting' };
  const config = await loadRuntimeConfig({ env, configPath });
  assert.deepEqual(config, { callerThreadId: CALLER, enableSend: true, allowedSendThreadId: TARGET, sendScope: 'all-local', port: 14317 });
  const saved = await readFile(configPath, 'utf8');
  assert.deepEqual(JSON.parse(saved), config);
  assert.doesNotMatch(saved, /private-|PIPE_PATH|API_KEY|UNRELATED_ENVIRONMENT/);
  assert.deepEqual(await loadRuntimeConfig({ env: {}, configPath }), config);
});

const appCatalog = { tools: ['list_threads', 'read_thread'].map(name => ({ namespace: 'codex_app', name })) };

test('stale pipe reconnects through a read-only catalog probe, ignoring non-app pipes', async () => {
  const calls = [];
  const request = createDesktopRequest({ preferredPipe: 'stale', candidates: async () => ['unrelated', 'app'],
    request: async (path, method, params, options = {}) => {
      calls.push({ path, method, params, options });
      if (path === 'stale') throw new BridgeError('stale');
      if (method === 'tools/list') return path === 'app' ? appCatalog : { tools: [{ namespace: 'browser', name: 'list_threads' }, { namespace: 'browser', name: 'read_thread' }] };
      assert.equal(path, 'app');
      return { success: true };
    } });
  const params = { tool: 'list_threads', arguments: { limit: 50 } };
  assert.deepEqual(await request(null, 'tools/call', params), { success: true });
  assert.deepEqual(calls.map(call => [call.path, call.method]), [['stale', 'tools/call'], ['unrelated', 'tools/list'], ['app', 'tools/list'], ['app', 'tools/call']]);
  assert.equal(calls.filter(call => call.method === 'tools/list').every(call => call.options.mutation !== true && call.options.timeoutMs === 1000), true);
  assert.equal(calls.at(-1).params, params);
  await request(null, 'tools/call', params);
  assert.deepEqual(calls.at(-1).path, 'app');
  assert.equal(calls.length, 5);
});

test('mutation failures never discover and replay a write', async () => {
  for (const code of ['DESKTOP_UNAVAILABLE', 'DELIVERY_UNKNOWN', 'PROTOCOL_ERROR']) {
    let calls = 0, discoveries = 0;
    const expected = new BridgeError('write failed', code, code === 'DELIVERY_UNKNOWN' ? 409 : 503);
    const request = createDesktopRequest({ preferredPipe: 'stale', candidates: async () => { discoveries++; return ['app']; },
      request: async () => { calls++; throw expected; } });
    await assert.rejects(request(null, 'tools/call', { tool: 'send_message_to_thread', arguments: { prompt: 'once' } }, { mutation: true }), error => error === expected);
    assert.equal(calls, 1);
    assert.equal(discoveries, 0);
  }
});

test('ambiguous desktop discovery refuses to choose an arbitrary instance', async () => {
  const methods = [];
  const request = createDesktopRequest({ candidates: async () => ['app1', 'app2'], request: async (path, method) => {
    methods.push([path, method]);
    assert.equal(method, 'tools/list');
    return appCatalog;
  } });
  await assert.rejects(request(null, 'tools/call', { tool: 'read_thread' }), /多个 Codex 桌面连接/);
  assert.deepEqual(methods, [['app1', 'tools/list'], ['app2', 'tools/list']]);
});
