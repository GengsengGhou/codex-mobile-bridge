import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createUploads } from '../public/uploads.js';

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const respond = body => new Response(JSON.stringify(body));
const file = (name = 'note.txt', text = 'hello') => ({ name, size: Buffer.byteLength(text), arrayBuffer: async () => Uint8Array.from(Buffer.from(text)).buffer });
async function settle(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('upload did not settle'); }
function setup(t, route, session = {}, getThread = () => ({ cwd: 'E:/project' })) {
  const dom = new JSDOM('<input id="attachmentPicker" type="file"><button id="attachButton"></button><ul id="attachmentList"></ul><div id="attachmentError"></div>', { url: 'http://localhost' });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
  for (const [key, value] of Object.entries(session)) dom.window.sessionStorage.setItem(key, value);
  const calls = [];
  const uploads = createUploads({ document: dom.window.document, window: dom.window, getThread, fetchImpl: async (path, options = {}) => { calls.push({ path, ...options }); return route(path, options); } });
  uploads.setThread(A);
  return { uploads, calls, window: dom.window };
}
function receipt(path) {
  const url = new URL(path, 'http://localhost'), uploadId = url.pathname.split('/').at(-1);
  return { uploaded: true, uploadId, threadId: A, name: url.searchParams.get('name'), size: Number(url.searchParams.get('size')), sha256: url.searchParams.get('sha256'), path: `mobile-uploads/${uploadId}/note.txt`, absolutePath: `E:/project/mobile-uploads/${uploadId}/note.txt`, uploadedAt: 1 };
}
test('uploads raw bytes without sending and builds an explicit attachment-only prompt', async t => {
  const ui = setup(t, path => respond(receipt(path)));
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
  assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0].method, 'POST');
  assert.equal(ui.calls[0].headers['Content-Type'], 'application/octet-stream');
  assert.equal(Buffer.from(ui.calls[0].body).toString(), 'hello');
  assert.match(ui.uploads.snapshot(A, '').prompt, /请查看这些附件。.*附件：/s);
  assert.match(ui.uploads.snapshot(A, '').prompt, /\[note.txt\]\(<E:\/project\/mobile-uploads\//);
});

test('configured workspace receipts retain logical IDs and build the physical attachment link', async t => {
  const ui = setup(t, path => {
    const value = receipt(path);
    return respond({ ...value, workspacePath: `project/${value.path}`, absolutePath: `E:/project/project/${value.path}` });
  });
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
  assert.match(ui.uploads.snapshot(A, 'draft').prompt, /E:\/project\/project\/mobile-uploads\//);
});

test('configured receipts reject workspace escape, absolute paths, wrong suffix and forged physical paths', async t => {
  for (const directory of ['../project', '/project', 'C:/outside', 'nested/../project', 'nested\\project', '']) {
    const ui = setup(t, path => { const value = receipt(path); return respond({ ...value, workspacePath: `${directory}/${value.path}`, absolutePath: `E:/project/${directory}/${value.path}` }); });
    await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'unknown');
    assert.equal(ui.uploads.snapshot(A, 'draft'), null);
  }
  const ui = setup(t, path => { const value = receipt(path); return respond({ ...value, workspacePath: `project/${value.path}`, absolutePath: `E:/outside/project/${value.path}` }); });
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'unknown');
});
test('late uploads stay in the original thread and captured removals preserve newer files', async t => {
  let finish;
  const ui = setup(t, path => new Promise(resolve => { finish = () => resolve(respond(receipt(path))); }));
  await ui.uploads.add([file()]); ui.uploads.setThread(B); finish();
  await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
  assert.equal(ui.uploads.getItems(B).length, 0);
  const ids = ui.uploads.snapshot(A, 'draft').attachmentIds;
  ui.uploads.getItems(A).push({ uploadId: 'new', state: 'failed' });
  ui.uploads.remove(A, ids); assert.equal(ui.uploads.getItems(A)[0].uploadId, 'new');
});
test('wrong receipt remains unresolved and reload checks without another POST', async t => {
  const ui = setup(t, path => respond({ ...receipt(path), threadId: B }));
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'unknown');
  assert.equal(ui.uploads.snapshot(A, 'draft'), null);
  const key = `codex-mobile-uploads:${A}`, stored = ui.window.sessionStorage.getItem(key);
  const reload = setup(t, () => respond({ state: 'not_found' }), { [key]: stored });
  await settle(() => reload.uploads.getItems(A)[0]?.error?.includes('同一文件'));
  assert.equal(reload.calls.length, 1); assert.equal(reload.calls[0].method, undefined);
});
test('storage failures, oversize files and excessive counts prevent POST', async t => {
  const ui = setup(t, () => { assert.fail('must not dispatch'); });
  await ui.uploads.add(Array.from({ length: 6 }, () => file()));
  await ui.uploads.add([{ ...file(), size: 20 * 1024 * 1024 + 1 }]);
  Object.defineProperty(ui.window.Storage.prototype, 'setItem', { value() { throw new Error('full'); } });
  await ui.uploads.add([file()]); assert.equal(ui.calls.length, 0);
  assert.match(ui.window.document.getElementById('attachmentError').textContent, /无法保存/);
});

test('corrupt metadata fails closed until the user explicitly clears its record', async t => {
  for (const stored of ['{bad', '[{"uploadId":"bad"}]', '{}']) {
    const ui = setup(t, () => { assert.fail('corrupt metadata must not dispatch'); }, { [`codex-mobile-uploads:${A}`]: stored });
    assert.equal(ui.uploads.status(A).blocked, true); assert.equal(ui.uploads.snapshot(A, 'draft'), null);
    await ui.uploads.add([file()]); assert.equal(ui.calls.length, 0);
    const clear = [...ui.window.document.querySelectorAll('button')].find(button => button.textContent === '清除附件恢复记录');
    clear.click(); assert.equal(ui.uploads.status(A).blocked, false);
  }
});

test('hash preparation blocks sending before a file has finished reading', async t => {
  let finish;
  const ui = setup(t, path => respond(receipt(path)));
  const adding = ui.uploads.add([{ ...file(), arrayBuffer: () => new Promise(resolve => { finish = resolve; }) }]);
  assert.equal(ui.uploads.status(A).blocked, true); assert.equal(ui.uploads.snapshot(A, 'draft'), null);
  finish(Uint8Array.from(Buffer.from('hello')).buffer); await adding;
  await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
});

test('repeated receipt checks share one request and preflight detects a deleted upload', async t => {
  let resolveCheck, checks = 0;
  const ui = setup(t, (path, options) => options.method === 'POST' ? respond(receipt(path)) : new Promise(resolve => { checks++; resolveCheck = resolve; }));
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
  const item = ui.uploads.getItems(A)[0], first = ui.uploads.check(item), second = ui.uploads.check(item);
  assert.equal(checks, 1); resolveCheck(respond({ state: 'not_found' })); await Promise.all([first, second]);
  assert.equal(ui.uploads.snapshot(A, 'draft'), null);
});

test('backend invalid filename rejection is a definitive failure, not an uncertain upload', async t => {
  const ui = setup(t, () => new Response(JSON.stringify({ code: 'INVALID_UPLOAD', error: '文件名无效或不允许上传' }), { status: 400 }));
  await ui.uploads.add([file('secret.key')]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'failed');
  assert.equal(ui.calls.length, 1); assert.match(ui.uploads.getItems(A)[0].error, /文件名/);
});

test('restored ready receipts are revalidated and current workspace changes prevent send', async t => {
  let cwd = 'E:/project';
  const ui = setup(t, (path, options) => options.method === 'POST' ? respond(receipt(path)) : respond({ state: 'uploaded', receipt: ui.uploads.getItems(A)[0].receipt }), {}, () => ({ cwd }));
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
  const saved = ui.window.sessionStorage.getItem(`codex-mobile-uploads:${A}`), valid = ui.uploads.getItems(A)[0].receipt;
  const restored = setup(t, () => respond({ state: 'not_found' }), { [`codex-mobile-uploads:${A}`]: saved });
  assert.equal(restored.uploads.status(A).blocked, true);
  await settle(() => restored.uploads.getItems(A)[0]?.error?.includes('同一文件'));
  assert.equal(restored.calls.length, 1);
  cwd = 'E:/other'; assert.equal(ui.uploads.snapshot(A, 'draft'), null);
  assert.equal(await ui.uploads.prepare(A, 'draft'), null);
  assert.equal(ui.uploads.getItems(A)[0].receipt.absolutePath, valid.absolutePath);
});

test('repeated Retry shares one POST and cannot race a receipt check', async t => {
  let finish, first = true;
  const ui = setup(t, path => {
    if (first) { first = false; return new Response(JSON.stringify({ code: 'UPLOAD_LIMIT_REACHED', error: 'retry later' }), { status: 429 }); }
    return new Promise(resolve => { finish = () => resolve(respond(receipt(path))); });
  });
  await ui.uploads.add([file()]); await settle(() => ui.uploads.getItems(A)[0]?.state === 'failed');
  const buttons = [...ui.window.document.querySelectorAll('button')], retry = buttons.find(button => button.textContent === '重试');
  retry.click(); retry.click(); const checking = ui.uploads.check(ui.uploads.getItems(A)[0]);
  assert.equal(ui.calls.length, 2); finish(); await checking;
  await settle(() => ui.uploads.getItems(A)[0]?.state === 'ready');
});

test('storage read exceptions block the queue until explicit successful retry', async t => {
  const ui = setup(t, () => { assert.fail('read errors must not dispatch'); });
  const prototype = ui.window.Storage.prototype, original = prototype.getItem;
  prototype.getItem = function () { throw new Error('denied'); };
  ui.uploads.setThread(B); assert.equal(ui.uploads.status(B).blocked, true);
  assert.equal(ui.uploads.snapshot(B, 'draft'), null);
  prototype.getItem = original;
  [...ui.window.document.querySelectorAll('button')].find(button => button.textContent === '重试读取附件记录').click();
  assert.equal(ui.uploads.status(B).blocked, false);
});
