import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';
const id = '00000000-0000-0000-0000-000000000001';
test('authenticated conditional snapshots validate fresh content, preserve authorization and keep static upgrades revalidated', async t => {
  let revision = 0;
  const thread = { id, kind: 'codex', hostId: 'local', status: 'idle' };
  const bridge = { callerThreadId: id, capabilities: async () => ['list_threads', 'read_thread'], list: async () => ({ threads: [thread] }), read: async () => ({ thread, turns: [{ id: 'turn', items: [{ text: String(revision) }] }], page: { hasMore: false } }) };
  const server = createBridgeServer({ bridge, enableSend: true, sendScope: 'all-local', control: { snapshot: async () => ({ threadId: id, pendingRequests: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base); const cookie = root.headers.get('set-cookie').split(';')[0];
  const headers = { Cookie: cookie, 'X-Bridge-Client': 'mobile-v1' };
  for (const path of ['/api/status', '/api/threads', `/api/threads/${id}`, `/api/threads/${id}/control`]) {
    const response = await fetch(base + path, { headers }); const etag = response.headers.get('etag');
    assert.ok(etag); const validated = await fetch(base + path, { headers: { ...headers, 'If-None-Match': etag } });
    assert.equal(validated.status, 304); assert.equal(await validated.text(), '');
    assert.equal((await fetch(base + path, { headers: { 'If-None-Match': etag } })).status, 401);
  }
  const current = await fetch(`${base}/api/threads/${id}`, { headers }); revision += 1;
  assert.equal((await fetch(`${base}/api/threads/${id}`, { headers: { ...headers, 'If-None-Match': current.headers.get('etag') } })).status, 200);
  const asset = await fetch(`${base}/app.js`); assert.equal(asset.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await fetch(`${base}/app.js`, { headers: { 'If-None-Match': asset.headers.get('etag') } })).status, 304);
  assert.equal(root.headers.get('cache-control'), 'no-store');
});
