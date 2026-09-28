import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridgeServer } from '../src/server.mjs';
import { DesktopBridge, BridgeError } from '../src/desktop.mjs';
import { JSDOM } from 'jsdom';
import { createArchivesPanel } from '../public/archives.js';

const ID = '00000000-0000-0000-0000-000000000071';
const OTHER = '00000000-0000-0000-0000-000000000072';
const row = { id: ID, kind: 'codex', hostId: 'local', title: 'Archived example', cwd: 'E:/work', status: 'notLoaded' };
async function setup(t, { enabled = true, scope = 'all-local', manage, readThread = row } = {}) {
  const calls = [];
  const bridge = { callerThreadId: OTHER, capabilities: async () => ['list_archived_threads', 'set_thread_archived'],
    call: async (tool, args) => { calls.push({ tool, args }); return { threads: [row, { ...row, id: OTHER, hostId: 'remote' }], nextCursor: 'next-page' }; },
    read: async () => ({ thread: readThread }), manage: async (...args) => { calls.push({ manage: args }); await manage?.(); } };
  const server = createBridgeServer({ bridge, enableSend: enabled, sendScope: scope, allowedSendThreadId: OTHER });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(base), cookie = root.headers.get('set-cookie').split(';')[0]; await root.text();
  const headers = { cookie, 'x-bridge-client': 'mobile-v1' };
  return { calls, request: (path, options = {}) => fetch(base + path, { headers, ...options }), bridge };
}
test('archives use native local pagination and restore only an explicitly listed local thread', async t => {
  const f = await setup(t);
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 409);
  const response = await f.request('/api/archives?cursor=older');
  assert.equal(response.status, 200);
  const page = await response.json(); assert.equal(page.threads.length, 1); assert.equal(page.threads[0].canRestore, true);
  assert.equal(page.nextCursor, 'next-page');
  assert.deepEqual(f.calls[0], { tool: 'list_archived_threads', args: { source: 'codex', hostId: 'local', limit: 30, cursor: 'older' } });
  const restored = await f.request(`/api/archives/${ID}/restore`, { method: 'POST' });
  assert.deepEqual(await restored.json(), { accepted: true, threadId: ID, archived: false });
  assert.deepEqual(f.calls.at(-1), { manage: [ID, 'archive', false] });
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 409);
});
test('archive source checks, scope and real local identity restrict restore', async t => {
  const f = await setup(t, { scope: 'single' });
  assert.equal((await f.request('/api/archives', { headers: {} })).status, 401);
  assert.equal((await f.request('/api/archives', { headers: { origin: 'https://evil.example' } })).status, 403);
  const page = await (await f.request('/api/archives')).json(); assert.equal(page.threads[0].canRestore, false);
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 403);
  assert.equal(f.calls.some(c => c.manage), false);
  const remote = await setup(t, { readThread: { ...row, hostId: 'other' } });
  await remote.request('/api/archives');
  assert.equal((await remote.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 403);
  assert.equal(remote.calls.some(c => c.manage), false);
});
test('ambiguous restore dispatches once; malformed native list is explicit failure', async t => {
  const f = await setup(t, { manage: () => { throw new BridgeError('Lost response', 'DELIVERY_UNKNOWN', 409); } });
  await f.request('/api/archives');
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 409);
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 409);
  assert.equal(f.calls.filter(c => c.manage).length, 1);
  f.bridge.call = async () => ({ threads: 'incompatible' });
  assert.equal((await f.request('/api/archives')).status, 502);
});

test('delegated archived conversations cannot be restored', async t => {
  const f = await setup(t, { readThread: { ...row, delegated: true } });
  f.bridge.call = async () => ({ threads: [{ ...row, source: { subAgent: { parentThreadId: OTHER } } }], nextCursor: null });
  assert.equal((await (await f.request('/api/archives')).json()).threads[0].canRestore, false);
  assert.equal((await f.request(`/api/archives/${ID}/restore`, { method: 'POST' })).status, 403);
  assert.equal(f.calls.some(call => call.manage), false);
});
test('archive listing is in the native call allowlist and unarchive retains exact native args', async () => {
  const calls = [];
  const bridge = new DesktopBridge({ callerThreadId: OTHER, request: async (_pipe, method, params, options) => {
    calls.push({ method, params, options }); return { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ threads: [], nextCursor: null }) }] };
  } });
  await bridge.call('list_archived_threads', { source: 'codex', hostId: 'local', limit: 30 });
  await bridge.manage(ID, 'archive', false);
  assert.equal(calls[0].options.mutation, false);
  assert.deepEqual(calls[1].params.arguments, { threadId: ID, source: 'codex', archived: false, hostId: 'local' });
  assert.equal(calls[1].options.mutation, true);
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function mount(t, api) {
  const dom = new JSDOM('<div class="drawer-foot"></div>');
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let refreshed = 0;
  createArchivesPanel({ document: dom.window.document, window: dom.window, api, onRestored: () => { refreshed++; } });
  t.after(() => dom.window.close());
  return { doc: dom.window.document, refreshed: () => refreshed };
}
test('archive UI paginates, confirms the chosen restore and refreshes conversations', async t => {
  const calls = [];
  const ui = mount(t, async (path, options = {}) => {
    calls.push({ path, options });
    if (options.method === 'POST') return { accepted: true, threadId: ID, archived: false };
    if (path.includes('cursor=')) return { threads: [{ ...row, id: OTHER, title: '<script>literal</script>', canRestore: false }], nextCursor: null };
    return { threads: [{ ...row, canRestore: true }], nextCursor: 'cursor' };
  });
  ui.doc.querySelector('#archivesButton').click(); await flush();
  [...ui.doc.querySelectorAll('.archives-footer button')].find(b => b.textContent === '加载更多').click(); await flush();
  assert.equal(ui.doc.querySelectorAll('.archive-row').length, 2); assert.equal(ui.doc.querySelector('script'), null);
  ui.doc.querySelector('.archive-row button').click(); await flush();
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 0);
  assert.equal(ui.doc.querySelector('.archive-row button').textContent, '确认恢复');
  ui.doc.querySelector('.archive-row button').click(); await flush();
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1); assert.equal(ui.refreshed(), 1);
  assert.equal(ui.doc.querySelector(`.archive-row[data-thread-id="${ID}"]`), null);
});
test('late archived lists do not repopulate a closed dialog and unknown restore never retries', async t => {
  let resolveList, posts = 0;
  const ui = mount(t, async (path, options = {}) => {
    if (options.method === 'POST') { posts++; throw new Error('offline'); }
    return new Promise(resolve => { resolveList = resolve; });
  });
  ui.doc.querySelector('#archivesButton').click();
  ui.doc.querySelector('[aria-label="关闭归档会话"]').click();
  resolveList({ threads: [{ ...row, canRestore: true }], nextCursor: null }); await flush();
  assert.equal(ui.doc.querySelectorAll('.archive-row').length, 0);
  ui.doc.querySelector('#archivesButton').click(); resolveList({ threads: [{ ...row, canRestore: true }], nextCursor: null }); await flush();
  ui.doc.querySelector('.archive-row button').click(); ui.doc.querySelector('.archive-row button').click(); await flush();
  assert.equal(posts, 1); assert.equal(ui.doc.querySelector('.archive-row button'), null);
  assert.match(ui.doc.querySelector('.archives-feedback').textContent, /不会自动重试/);
});
