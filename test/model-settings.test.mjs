import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { advertisedModels, modelSelection, validateModelSelection } from '../src/model-settings.mjs';
import { DesktopBridge } from '../src/desktop.mjs';
import { createBridgeServer } from '../src/server.mjs';

const tool = { name: 'send_message_to_thread', inputSchema: { properties: { model: { description: 'Models and supported reasoning efforts on the calling host: alpha (Model one.; supported reasoning efforts: low, high), beta (Model two.; supported reasoning efforts: high, ultra).' }, thinking: { enum: ['low', 'high', 'ultra'] } } } };
test('model catalog uses desktop-advertised combinations and fails closed on schema changes', () => {
  assert.deepEqual(advertisedModels(tool), [{ id: 'alpha', efforts: ['low', 'high'] }, { id: 'beta', efforts: ['high', 'ultra'] }]);
  assert.deepEqual(advertisedModels({}), []);
  assert.deepEqual(advertisedModels({ inputSchema: { properties: { ...tool.inputSchema.properties, model: { description: 'alpha supports all efforts' } } } }), []);
  assert.deepEqual(modelSelection({}), {});
  assert.throws(() => modelSelection({ thinking: 'high' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateModelSelection({ model: 'alpha', thinking: 'ultra' }, advertisedModels(tool)), { code: 'MODEL_UNAVAILABLE' });
});

test('desktop send and creation forward explicit settings and omit the desktop default', async () => {
  const calls = [];
  const bridge = new DesktopBridge({ callerThreadId: randomUUID(), request: async (_path, _method, params) => {
    calls.push(params.arguments);
    return { success: true, contentItems: [{ type: 'inputText', text: 'done' }] };
  } });
  const id = randomUUID();
  await bridge.send(id, 'default'); await bridge.send(id, 'selected', { model: 'alpha', thinking: 'high' });
  assert.deepEqual(calls[0], { threadId: id, hostId: 'local', prompt: 'default' });
  assert.deepEqual(calls[1], { threadId: id, hostId: 'local', prompt: 'selected', model: 'alpha', thinking: 'high' });
  bridge.projects = async () => [];
  bridge.call = async (_tool, args) => { calls.push(args); return { threadId: id, hostId: 'local' }; };
  await bridge.create({ prompt: 'new', model: 'alpha', thinking: 'low' });
  assert.equal(calls[2].model, 'alpha'); assert.equal(calls[2].thinking, 'low');
});

test('HTTP validates before dispatch, fingerprints settings, and rejects active overrides without a delivery marker', async t => {
  const id = randomUUID(), sends = []; let status = 'idle';
  const bridge = { callerThreadId: id, toolCatalog: [tool], capabilities: async () => ['list_threads', 'read_thread', 'send_message_to_thread'],
    read: async () => ({ thread: { id, kind: 'codex', hostId: 'local', status }, turns: [], page: {} }),
    send: async (...args) => sends.push(args) };
  const server = createBridgeServer({ bridge, enableSend: true, sendScope: 'all-local' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const post = body => fetch(`${base}/api/threads/${id}/messages`, { method: 'POST', headers: { cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const body = { prompt: 'same', requestId: randomUUID(), model: 'alpha', thinking: 'high' };
  assert.equal((await post(body)).status, 200);
  assert.equal((await post(body)).status, 200); assert.equal(sends.length, 1);
  assert.equal((await post({ ...body, thinking: 'low' })).status, 409);
  const invalid = await post({ ...body, requestId: randomUUID(), thinking: 'ultra' });
  assert.equal((await invalid.json()).code, 'MODEL_UNAVAILABLE'); assert.equal(sends.length, 1);
  status = 'active'; const activeId = randomUUID();
  const active = await post({ ...body, requestId: activeId });
  assert.equal((await active.json()).code, 'MODEL_CHANGE_ACTIVE'); assert.equal(sends.length, 1);
  assert.equal((await post({ prompt: 'supplement', requestId: activeId })).status, 200);
  assert.deepEqual(sends[1][2], {});
});
