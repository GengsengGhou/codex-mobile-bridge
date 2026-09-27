import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SidebarOrderStore, validateOrder } from '../src/sidebar-order.mjs';
import { createBridgeServer } from '../src/server.mjs';

const ID = '00000000-0000-0000-0000-000000000001';
test('shared sidebar order survives a store restart and rejects a stale concurrent writer', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-order-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'sidebar-order.json'), store = new SidebarOrderStore(path);
  const order = { projects: ['path:e:/one', 'path:e:/two'], threads: { 'path:e:/one': [ID] } };
  const first = await store.save({ revision: 0, order });
  assert.equal(first.revision, 1);
  assert.deepEqual(await new SidebarOrderStore(path).read(), first);
  const attempts = await Promise.allSettled([store.save({ revision: 1, order }), store.save({ revision: 1, order })]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(attempts.find(r => r.status === 'rejected').reason.code, 'ORDER_CONFLICT');
  const restored = await store.save({ revision: 2, order: { projects: [], threads: {} } });
  assert.equal(restored.revision, 3); assert.equal(restored.order.projects.length, 0);
});

test('sidebar order rejects malformed IDs, duplicate entries and unsafe keys', () => {
  for (const order of [null, { projects: ['a', 'a'], threads: {} }, { projects: [], threads: { a: ['not-id'] } },
    { projects: [], threads: { a: [ID, ID] } }, JSON.parse('{"projects":[],"threads":{"__proto__":[]}}')]) {
    assert.throws(() => validateOrder(order), e => e.code === 'INVALID_REQUEST');
  }
});

test('order HTTP writes require the same session and origin checks as messages', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-order-http-'));
  const server = createBridgeServer({ bridge: { callerThreadId: ID }, orderStore: new SidebarOrderStore(join(dir, 'order.json')) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const body = JSON.stringify({ revision: 0, order: { projects: ['one'], threads: {} } });
  const headers = { cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/api/sidebar-order', { method: 'PUT', body })).status, 401);
  assert.equal((await fetch(base + '/api/sidebar-order', { method: 'PUT', headers: { ...headers, Origin: 'https://example.org' }, body })).status, 403);
  const accepted = await fetch(base + '/api/sidebar-order', { method: 'PUT', headers, body });
  assert.equal(accepted.status, 200); assert.equal((await accepted.json()).revision, 1);
  assert.equal((await fetch(base + '/api/sidebar-order', { method: 'PUT', headers, body })).status, 409);
});
