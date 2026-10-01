import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { createFilesPanel } from '../public/files.js';

const ID = '00000000-0000-0000-0000-000000000001';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const listing = (path, parentPath, entries = [], truncated = false) => ({ path, parentPath, entries, truncated });
function mount(t, handler) {
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:4317/', pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  const { window } = dom;
  window.HTMLDialogElement.prototype.show = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  const urls = new Map();
  let nextUrl = 1;
  window.URL.createObjectURL = blob => { const url = `blob:test-${nextUrl++}`; urls.set(url, blob); return url; };
  window.URL.revokeObjectURL = url => urls.delete(url);
  const calls = [];
  const fetchImpl = async (path, options) => { calls.push({ path, options }); return handler(path, options); };
  let thread = { id: ID, cwd: 'E:/work/project' };
  const panel = createFilesPanel({ document: window.document, window, fetchImpl, getThread: () => thread });
  panel.setThread(thread);
  t.after(() => { panel.dispose(); window.close(); });
  return { window, doc: window.document, calls, urls, panel, setThread: value => { thread = value; panel.setThread(value); } };
}

test('remote login expiry signals without a local root refresh', async t => {
  const ui = mount(t, async () => json({ code: 'LOGIN_REQUIRED' }, 401));
  let signals = 0;
  ui.window.addEventListener('bridge-login-required', () => signals++);
  ui.doc.querySelector('#filesButton').click();
  for (let attempt = 0; attempt < 30 && !signals; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(signals, 1); assert.equal(ui.calls.length, 1);
  assert.match(ui.doc.querySelector('#filesState').textContent, /登录/);
});

test('browses directories, returns from a child, previews text safely, and downloads through a blob', async t => {
  const ui = mount(t, async path => {
    if (path.endsWith('/files?')) return json(listing('', null, [{ name: 'docs', path: 'docs', type: 'directory' }]));
    if (path.endsWith('/files?path=docs')) return json(listing('docs', '', [{ name: 'guide.md', path: 'docs/guide.md', type: 'file', size: 15 }]));
    if (path.endsWith('/file?path=docs%2Fguide.md&mode=info')) return json({ name: 'guide.md', path: 'docs/guide.md', size: 15, modifiedAt: null, previewKind: 'text' });
    if (path.endsWith('/file?path=docs%2Fguide.md&mode=preview')) return new Response('<img src=x onerror=alert(1)>', { status: 200 });
    if (path.endsWith('/file?path=docs%2Fguide.md&mode=download')) return new Response('download text', { status: 200 });
    throw new Error(`Unexpected request ${path}`);
  });
  const captures = [];
  ui.window.HTMLAnchorElement.prototype.click = function () { captures.push({ href: this.href, download: this.download }); };
  ui.doc.querySelector('#filesButton').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesPanel').open, true);
  assert.equal(ui.doc.querySelector('#filesEntries button').textContent.includes('docs'), true);
  assert.equal(ui.calls[0].options.credentials, 'same-origin');
  assert.equal(ui.calls[0].options.headers['X-Bridge-Client'], 'mobile-v1');
  ui.doc.querySelector('#filesEntries button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesBack').disabled, false);
  ui.doc.querySelector('#filesBack').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  ui.doc.querySelector('#filesEntries button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  ui.doc.querySelector('#filesEntries button').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('.file-text-preview')?.textContent, '<img src=x onerror=alert(1)>', JSON.stringify({ calls: ui.calls.map(call => call.path), status: ui.doc.querySelector('#filesState').textContent }));
  assert.equal(ui.doc.querySelector('.file-text-preview img'), null);
  ui.doc.querySelector('#filesDownload').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(captures, [{ href: 'blob:test-1', download: 'guide.md' }]);
  assert.ok(ui.calls.some(call => call.path.endsWith('/file?path=docs%2Fguide.md&mode=download')));
});

test('uses image and PDF previews as blobs, retains download fallback, and revokes previews on close', async t => {
  const ui = mount(t, async path => {
    if (path.endsWith('mode=info')) {
      const pdf = path.includes('manual.pdf');
      return json({ name: pdf ? 'manual.pdf' : 'photo.png', path: pdf ? 'manual.pdf' : 'photo.png', size: 5, previewKind: pdf ? 'pdf' : 'image' });
    }
    if (path.endsWith('mode=preview')) return new Response(new Uint8Array([1, 2, 3]));
    throw new Error(`Unexpected request ${path}`);
  });
  ui.doc.querySelector('#filesButton').click();
  ui.panel.openFile('photo.png');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('.file-image-preview').src, 'blob:test-1');
  ui.panel.openFile('manual.pdf');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('.file-pdf-preview').getAttribute('sandbox'), '');
  assert.match(ui.doc.querySelector('#filesState').textContent, /下载文件/);
  assert.equal(ui.doc.querySelector('#filesDownload').hidden, false);
  ui.doc.querySelector('#filesClose').click();
  assert.equal(ui.urls.size, 0);
});

test('ignores a late directory response after close and a late preview after thread switch', async t => {
  let pending;
  const ui = mount(t, path => {
    if (path.endsWith('/files?')) return new Promise(resolve => { pending = resolve; });
    if (path.endsWith('mode=info')) return new Promise(resolve => { pending = resolve; });
    throw new Error(`Unexpected request ${path}`);
  });
  ui.doc.querySelector('#filesButton').click();
  ui.doc.querySelector('#filesClose').click();
  pending(json(listing('E:/work/project', null, [{ name: 'late.txt', path: 'late.txt', type: 'file', size: 2 }])));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesEntries').children.length, 0);

  ui.doc.querySelector('#filesButton').click();
  ui.panel.openFile('late.txt');
  ui.setThread({ id: '00000000-0000-0000-0000-000000000002', cwd: 'E:/other' });
  pending(json({ name: 'late.txt', path: 'late.txt', size: 2, previewKind: 'text' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesPanel').open, false);
  assert.equal(ui.doc.querySelector('#filesState').textContent, '');
});

test('a 401 read refreshes the same-origin session once before retrying', async t => {
  const ui = mount(t, async path => {
    if (path === '/') return json({ refreshed: true });
    if (ui.calls.filter(call => call.path === path).length === 1) return json({ error: 'expired' }, 401);
    return json(listing('E:/work/project', null));
  });
  ui.doc.querySelector('#filesButton').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.calls.filter(call => call.path === '/').length, 1);
  assert.equal(ui.calls.filter(call => call.path.endsWith('/files?')).length, 2);
  assert.equal(ui.doc.querySelector('#filesState').textContent, '此目录为空。');
});

test('a root file and a canonicalized absolute link keep Back pointed at the cwd-relative parent', async t => {
  const ui = mount(t, async path => {
    if (path.endsWith('/file?path=E%3A%2Fwork%2Fproject%2Fguide.md&mode=info')) return json({ name: 'guide.md', path: 'guide.md', size: 0, previewKind: null });
    if (path.endsWith('/file?path=file.txt&mode=info')) return json({ name: 'file.txt', path: 'file.txt', size: 0, previewKind: null });
    if (path.endsWith('/files?')) return json(listing('', null, []));
    throw new Error(`Unexpected request ${path}`);
  });
  ui.doc.querySelector('#filesButton').click();
  ui.panel.openFile('E:/work/project/guide.md');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesBack').disabled, false);
  ui.doc.querySelector('#filesBack').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(ui.calls.some(call => call.path.endsWith('/files?')));
  ui.panel.openFile('file.txt');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesBack').disabled, false);
  ui.doc.querySelector('#filesBack').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.calls.filter(call => call.path.endsWith('/files?')).length, 3);
});

test('preview limits and authorization errors leave a clear state without reading bytes', async t => {
  const ui = mount(t, async path => {
    if (path.endsWith('/file?path=large.txt&mode=info')) return json({ name: 'large.txt', path: 'large.txt', size: 1024 * 1024 + 1, previewKind: 'text' });
    if (path.endsWith('/file?path=private.txt&mode=info')) return json({ error: 'outside scope' }, 403);
    throw new Error(`Unexpected request ${path}`);
  });
  ui.doc.querySelector('#filesButton').click();
  ui.panel.openFile('large.txt');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(ui.doc.querySelector('#filesState').textContent, /超过预览大小限制/);
  assert.equal(ui.calls.some(call => call.path.endsWith('mode=preview')), false);
  ui.panel.openFile('private.txt');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesState').textContent, '此文件不允许访问。');
  assert.equal(ui.doc.querySelector('#filesPreview').children.length, 0);
});

test('changing cwd on the selected thread invalidates and closes a pending read', async t => {
  let release;
  const ui = mount(t, path => path.endsWith('/files?') ? new Promise(resolve => { release = resolve; }) : undefined);
  ui.doc.querySelector('#filesButton').click();
  ui.setThread({ id: ID, cwd: 'E:/changed' });
  release(json(listing('', null, [{ name: 'stale.txt', path: 'stale.txt', type: 'file', size: 1 }])));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.querySelector('#filesPanel').open, false);
  assert.equal(ui.doc.querySelector('#filesEntries').children.length, 0);
  assert.equal(ui.doc.querySelector('#filesState').textContent, '');
});
