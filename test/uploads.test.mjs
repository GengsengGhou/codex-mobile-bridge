import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createBridgeServer } from '../src/server.mjs';
import { UploadStore, UPLOAD_LIMIT } from '../src/uploads.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = () => new Promise(resolve => setTimeout(resolve, 40));
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'bridge-upload-')), cwd = path.join(root, 'workspace'); await mkdir(cwd);
  let thread = { id, kind: 'codex', hostId: 'local', status: 'idle', cwd }, server, base, headers;
  const journal = path.join(root, 'uploads.json');
  const start = async () => {
    const bridge = { callerThreadId: id, read: async () => ({ thread, turns: [] }), send: () => { throw Error('Uploads must not send chat'); } };
    server = createBridgeServer({ bridge, enableSend: true, uploadStore: new UploadStore({ path: journal }), ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const home = await fetch(base); headers = { cookie: home.headers.get('set-cookie').split(';')[0], 'x-bridge-client': 'mobile-v1' }; await home.arrayBuffer();
  };
  const stop = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); };
  await start(); t.after(async () => { await stop(); await rm(root, { recursive: true, force: true }); });
  const url = (uploadId, meta = {}, threadId = id) => `${base}/api/threads/${threadId}/uploads/${uploadId}?${new URLSearchParams(meta)}`;
  const meta = (bytes, name = 'attachment.bin') => ({ name, size: bytes.length, sha256: hash(bytes) });
  const post = (uploadId, bytes, metadata = meta(bytes), extra = {}) => fetch(url(uploadId, metadata), { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', ...extra }, body: bytes });
  const get = (uploadId, threadId) => fetch(url(uploadId, {}, threadId), { headers });
  const raw = (uploadId, metadata) => {
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    const request = http.request(url(uploadId, metadata), { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    request.on('error', reject);
    return { request, done };
  };
  return { root, cwd, journal, meta, post, get, raw, setThread: value => { thread = value; }, thread, url, get headers() { return headers; }, restart: async () => { await stop(); await start(); } };
}
test('uploads require authentication, write scope and genuine local writable thread', async t => {
  const f = await fixture(t), bytes = Buffer.from('hello'), uploadId = randomUUID();
  assert.equal((await f.post(uploadId, bytes, f.meta(bytes), { cookie: '' })).status, 401);
  assert.equal((await f.post(uploadId, bytes, f.meta(bytes), { 'x-bridge-client': '' })).status, 401);
  assert.equal((await f.post(uploadId, bytes, f.meta(bytes), { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await f.get(uploadId, randomUUID())).status, 403);
  for (const change of [{ id: randomUUID() }, { hostId: 'remote' }, { kind: 'chatgpt' }, { archived: true }, { status: 'unknown' }, { cwd: path.parse(f.cwd).root }, { cwd: '\\\\server\\share' }]) {
    f.setThread({ ...f.thread, ...change });
    assert.equal((await f.post(uploadId, bytes)).status, 403, JSON.stringify(change));
  }
  assert.equal((await readdir(f.cwd)).length, 0);
});
test('disabled sending blocks uploads and lookup before filesystem mutation', async t => {
  const f = await fixture(t, { enableSend: false });
  assert.equal((await f.post(randomUUID(), Buffer.from('x'))).status, 403);
  assert.equal((await f.get(randomUUID())).status, 403);
  assert.deepEqual(await readdir(f.cwd), []);
});
test('binary upload is durable, readable, idempotent and never sends chat', async t => {
  const f = await fixture(t), uploadId = randomUUID(), bytes = Buffer.from([0, 255, 1, 2, 128]);
  const response = await f.post(uploadId, bytes, f.meta(bytes, '中文.bin'));
  assert.equal(response.status, 200); const receipt = await response.json();
  assert.equal(receipt.path, `mobile-uploads/${uploadId}/中文.bin`);
  assert.deepEqual(await readFile(receipt.absolutePath), bytes);
  assert.deepEqual((await (await f.get(uploadId)).json()).receipt, receipt);
  assert.deepEqual(await (await f.post(uploadId, bytes, f.meta(bytes, '中文.bin'))).json(), receipt);
  await f.restart();
  assert.deepEqual((await (await f.get(uploadId)).json()).receipt, receipt);
  assert.deepEqual(await (await f.post(uploadId, bytes, f.meta(bytes, '中文.bin'))).json(), receipt);
  assert.equal((await f.post(uploadId, bytes, f.meta(bytes, 'other.bin'))).status, 409);
  const download = await fetch(f.url(uploadId).split('/uploads/')[0] + `/file?${new URLSearchParams({ path: receipt.path, mode: 'download' })}`, { headers: f.headers });
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});
test('filenames, declared limits and parent junctions are rejected', async t => {
  const f = await fixture(t), bytes = Buffer.from('x');
  for (const name of ['../x', 'sub/x', 'sub\\x', 'C:x', 'NUL.txt', 'con', '.env', 'private.key', 'node_modules', '$recycle.bin', 'bad\n.txt', 'end.', 'end ']) {
    assert.equal((await f.post(randomUUID(), bytes, f.meta(bytes, name))).status, 400, name);
  }
  assert.equal((await f.post(randomUUID(), bytes, { name: 'x.txt', size: UPLOAD_LIMIT + 1, sha256: hash(bytes) })).status, 413);
  assert.equal((await f.post(randomUUID(), bytes, { ...f.meta(bytes), sha256: 'not-hash' })).status, 400);
  const outside = path.join(f.root, 'outside'); await mkdir(outside);
  await symlink(outside, path.join(f.cwd, 'mobile-uploads'), 'junction');
  assert.equal((await f.post(randomUUID(), bytes)).status, 403);
  assert.deepEqual(await readdir(outside), []);
});
test('hash and actual byte counts are bounded; normal failures leave no partials and same ID can retry', async t => {
  const f = await fixture(t), uploadId = randomUUID(), bytes = Buffer.from('good');
  const wrong = await f.post(uploadId, Buffer.from('evil'), f.meta(bytes));
  assert.equal(wrong.status, 400); assert.equal((await wrong.json()).code, 'UPLOAD_INTEGRITY');
  const directory = path.join(f.cwd, 'mobile-uploads', uploadId);
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await f.get(uploadId)).status, 200);
  assert.equal((await (await f.get(uploadId)).json()).state, 'unknown');
  assert.equal((await f.post(uploadId, bytes)).status, 200);
  const oversized = f.raw(randomUUID(), f.meta(Buffer.from('x'))); oversized.request.end(Buffer.from('too big'));
  assert.equal((await oversized.done).status, 413);
  const short = f.raw(randomUUID(), f.meta(bytes)); short.request.end(Buffer.from('x'));
  assert.equal((await short.done).status, 400);
});
test('interrupted and parallel uploads preserve identity and report uploading', async t => {
  const f = await fixture(t), uploadId = randomUUID(), bytes = Buffer.from('complete');
  const slow = f.raw(uploadId, f.meta(bytes)); slow.request.write(bytes.subarray(0, 1)); await pause();
  assert.equal((await (await f.get(uploadId)).json()).state, 'uploading');
  const duplicate = await f.post(uploadId, bytes);
  assert.equal(duplicate.status, 409); assert.equal((await duplicate.json()).code, 'UPLOAD_BUSY');
  const ignored = slow.done.catch(() => {}); slow.request.destroy(); await ignored; await pause();
  assert.deepEqual(await readdir(path.join(f.cwd, 'mobile-uploads', uploadId)), []);
  assert.equal((await f.post(uploadId, bytes)).status, 200);
});
test('existing directories and files are never overwritten; committed files are verified after restart', async t => {
  const f = await fixture(t), bytes = Buffer.from('original'), occupied = randomUUID();
  const directory = path.join(f.cwd, 'mobile-uploads', occupied); await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'attachment.bin'), 'keep');
  assert.equal((await f.post(occupied, bytes)).status, 409);
  assert.equal(await readFile(path.join(directory, 'attachment.bin'), 'utf8'), 'keep');
  const uploadId = randomUUID(), receipt = await (await f.post(uploadId, bytes)).json();
  await writeFile(receipt.absolutePath, 'tampered');
  await f.restart();
  const changed = await f.get(uploadId);
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'UPLOAD_FILE_CHANGED');
  assert.equal((await f.post(uploadId, bytes)).status, 409);
  await rm(receipt.absolutePath);
  assert.equal((await f.get(uploadId)).status, 409);
  assert.equal((await f.post(uploadId, bytes)).status, 409);
});
test('changed workspace and uncertain commit recovery do not create a duplicate', async t => {
  const f = await fixture(t), bytes = Buffer.from('recover'), uploadId = randomUUID();
  const receipt = await (await f.post(uploadId, bytes)).json();
  const journal = JSON.parse(await readFile(f.journal, 'utf8'));
  journal.uploads[0].state = 'pending'; delete journal.uploads[0].receipt;
  await writeFile(f.journal, JSON.stringify(journal)); await f.restart();
  assert.deepEqual((await (await f.get(uploadId)).json()).receipt, receipt);
  const other = path.join(f.root, 'other'); await mkdir(other); f.setThread({ ...f.thread, cwd: other });
  const changed = await f.post(uploadId, bytes);
  assert.equal(changed.status, 409); assert.equal((await changed.json()).code, 'UPLOAD_WORKSPACE_CHANGED');
  assert.equal((await f.get(uploadId)).status, 409);
  assert.deepEqual(await readdir(other), []);
});
test('corrupt upload journal fails closed before writing into workspace', async t => {
  const f = await fixture(t); await writeFile(f.journal, '{bad'); await f.restart();
  const response = await f.post(randomUUID(), Buffer.from('x'));
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'UPLOAD_STORE_UNAVAILABLE');
  assert.deepEqual(await readdir(f.cwd), []);
});
test('upload identity binds to its conversation and unexpected pending files are preserved', async t => {
  const f = await fixture(t, { sendScope: 'all-local' }), bytes = Buffer.from('good'), uploadId = randomUUID();
  assert.equal((await f.post(uploadId, Buffer.from('evil'), f.meta(bytes))).status, 400);
  const final = path.join(f.cwd, 'mobile-uploads', uploadId, 'attachment.bin');
  await writeFile(final, 'unexpected');
  const retry = await f.post(uploadId, bytes);
  assert.equal(retry.status, 409); assert.equal((await retry.json()).code, 'UPLOAD_UNKNOWN');
  assert.equal(await readFile(final, 'utf8'), 'unexpected');
  const otherId = randomUUID(); f.setThread({ ...f.thread, id: otherId });
  assert.equal((await (await f.get(uploadId, otherId)).json()).state, 'not_found');
  const response = await fetch(f.url(uploadId, f.meta(bytes), otherId), { method: 'POST', headers: { ...f.headers, 'content-type': 'application/octet-stream' }, body: bytes });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'UPLOAD_CONFLICT');
});
test('upload journal caps reserved IDs and total declared bytes', async () => {
  const store = new UploadStore({ path: null });
  const entry = i => ({ uploadId: String(i), threadId: id, size: UPLOAD_LIMIT });
  for (let i = 0; i < 51; i++) await store.reserve(entry(i));
  await assert.rejects(store.reserve(entry(51)), error => error.code === 'UPLOAD_LIMIT_REACHED');
  const ids = new UploadStore({ path: null });
  for (let i = 0; i < 500; i++) await ids.reserve({ ...entry(i), size: 0 });
  await assert.rejects(ids.reserve({ ...entry(500), size: 0 }), error => error.code === 'UPLOAD_LIMIT_REACHED');
});
