import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBridgeServer } from '../src/server.mjs';

const id = '11111111-1111-4111-8111-111111111111';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-files-'));
  const cwd = path.join(root, 'workspace');
  await mkdir(cwd);
  let thread = { id, kind: 'codex', hostId: 'local', cwd };
  const bridge = { callerThreadId: id, read: async () => ({ thread, turns: [] }) };
  const server = createBridgeServer({ bridge });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = await fetch(base);
  const headers = { cookie: home.headers.get('set-cookie').split(';')[0], 'x-bridge-client': 'mobile-v1' };
  await home.arrayBuffer();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const request = (resource, input = '', mode, customHeaders = headers) => fetch(`${base}/api/threads/${id}/${resource}?${new URLSearchParams({ path: input, ...(mode ? { mode } : {}) })}`, { headers: customHeaders });
  return { root, cwd, request, setThread: value => { thread = value; }, thread, headers };
}
test('file APIs require both session cookie and client header', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('files', '', null, {})).status, 401);
  assert.equal((await f.request('files', '', null, { cookie: f.headers.cookie })).status, 401);
  assert.equal((await f.request('file', 'a.txt', 'download', { 'x-bridge-client': 'mobile-v1' })).status, 401);
});
test('listing, metadata and byte modes retain deterministic paths and safe MIME', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, 'folder'));
  await writeFile(path.join(f.cwd, '中文.txt'), 'hello\n');
  await writeFile(path.join(f.cwd, 'script.svg'), '<svg onload="alert(1)"/>');
  await writeFile(path.join(f.cwd, '.env'), 'secret');
  const listing = await (await f.request('files')).json();
  assert.equal(listing.path, ''); assert.equal(listing.parentPath, null);
  assert.deepEqual(listing.entries.map(e => e.name), ['folder', 'script.svg', '中文.txt']);
  const sub = await (await f.request('files', 'folder')).json();
  assert.equal(sub.parentPath, '');
  const info = await (await f.request('file', '中文.txt')).json();
  assert.equal(info.size, 6); assert.equal(info.previewKind, 'text');
  const preview = await f.request('file', path.join(f.cwd, '中文.txt') + ':12:3', 'preview');
  assert.equal(preview.status, 200); assert.equal(await preview.text(), 'hello\n');
  const svg = await f.request('file', 'script.svg', 'preview');
  assert.match(svg.headers.get('content-type'), /^text\/plain/);
  await svg.arrayBuffer();
  const download = await f.request('file', '中文.txt', 'download');
  assert.match(download.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''/);
  assert.equal(await download.text(), 'hello\n');
  for (const [name, mime, bytes] of [['picture.png', 'image/png', Buffer.from([137, 80, 78, 71])], ['report.pdf', 'application/pdf', Buffer.from('%PDF-1.7\n')]]) {
    await writeFile(path.join(f.cwd, name), bytes);
    const response = await f.request('file', name, 'preview');
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), mime);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  }
  await writeFile(path.join(f.cwd, 'empty.txt'), '');
  assert.equal(await (await f.request('file', 'empty.txt', 'preview')).text(), '');
});
test('paths stay confined and credentials and links cannot be accessed', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'outside.txt'), 'outside');
  await writeFile(path.join(f.cwd, '.env'), 'secret');
  await writeFile(path.join(f.cwd, 'private.key'), 'secret');
  for (const name of ['../outside.txt', path.join(f.root, 'outside.txt'), '.env', 'private.key', 'a.txt:stream', '\\\\server\\share\\x', '\\\\?\\C:\\x', 'C:\\', 'NUL']) {
    assert.equal((await f.request('file', name)).status, 403, name);
  }
  assert.equal((await f.request('file', 'missing.txt')).status, 404);
  assert.equal((await f.request('file', 'missing.txt', 'nonsense')).status, 400);
  await symlink(f.root, path.join(f.cwd, 'escape'), 'junction');
  assert.equal((await f.request('file', 'escape/outside.txt')).status, 403);
  const listing = await (await f.request('files')).json();
  assert.equal(listing.entries.some(e => e.name === 'escape'), false);
});
test('only genuine local codex workspace reads are allowed', async t => {
  const f = await fixture(t);
  for (const change of [{ id: '22222222-2222-4222-8222-222222222222' }, { kind: 'chatgpt' }, { hostId: 'remote' }, { cwd: null }, { cwd: path.parse(f.cwd).root }]) {
    f.setThread({ ...f.thread, ...change });
    assert.equal((await f.request('files')).status, 403);
  }
  const linked = path.join(f.root, 'linked-workspace');
  await symlink(f.cwd, linked, 'junction');
  f.setThread({ ...f.thread, cwd: linked });
  assert.equal((await f.request('files')).status, 403);
});
test('listing explicitly truncates at 300 entries and file limits precede streaming', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 301 }, (_, i) => writeFile(path.join(f.cwd, `file-${String(i).padStart(3, '0')}.txt`), '')));
  const listing = await (await f.request('files')).json();
  assert.equal(listing.entries.length, 300); assert.equal(listing.truncated, true);
  for (const [name, size, mode, expected] of [['large.txt', 1048577, 'preview', 413], ['large.png', 20 * 1048576 + 1, 'preview', 413], ['large.pdf', 30 * 1048576 + 1, 'preview', 413], ['large.bin', 100 * 1048576 + 1, 'download', 413], ['unknown.bin', 1, 'preview', 415]]) {
    const handle = await open(path.join(f.cwd, name), 'w'); await handle.truncate(size); await handle.close();
    assert.equal((await f.request('file', name, mode)).status, expected);
  }
});
test('directory scan is bounded even when all entries are excluded', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 1501 }, (_, i) => writeFile(path.join(f.cwd, `.excluded-${i}`), '')));
  const listing = await (await f.request('files')).json();
  assert.deepEqual(listing.entries, []);
  assert.equal(listing.truncated, true);
  // A second request also succeeds after the bounded iterator closes its handle.
  assert.equal((await f.request('files')).status, 200);
});
