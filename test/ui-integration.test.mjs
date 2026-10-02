import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { webcrypto } from 'node:crypto';

const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const C = '00000000-0000-0000-0000-000000000003';
const UPLOAD = '00000000-0000-0000-0000-000000000004';
function readyAttachment() {
  const receipt = { uploaded: true, uploadId: UPLOAD, threadId: A, name: 'notes.txt', size: 5, sha256: 'a'.repeat(64), path: `mobile-uploads/${UPLOAD}/notes.txt`, absolutePath: `E:/project/mobile-uploads/${UPLOAD}/notes.txt`, uploadedAt: 1 };
  return { ...receipt, cwd: 'E:/project', state: 'ready', receipt };
}
const rows = [
  { id: A, title: 'Alpha', projectKey: 'project-one', projectName: 'One', projectOrder: 0, projectThreadOrder: 0, status: 'idle' },
  { id: B, title: 'Beta', projectKey: 'project-one', projectName: 'One', projectOrder: 0, projectThreadOrder: 1, status: 'idle' },
  { id: C, title: 'Gamma', projectKey: 'project-two', projectName: 'Two', projectOrder: 1, projectThreadOrder: 0, status: 'idle' },
];
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const snapshot = (id, text = `${id === A ? 'Alpha' : 'Beta'} reply`, status = 'idle') => ({
  thread: { id, ...rows.find(row => row.id === id), status }, canSend: true, sendMode: status === 'active' ? 'follow-up' : 'message', sendDisabledReason: null,
  page: { hasMore: false, nextCursor: null }, turns: [{ id: `turn-${id}`, startedAt: 1000, status: 'completed', items: [{ id: `reply-${id}`, type: 'agentMessage', phase: 'final_answer', text }] }],
});
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate, label) {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); }
  assert.fail(`Timed out: ${label}`);
}

function pollingClock(window) {
  let now = Date.now(), nextId = 0;
  const timers = new Map();
  window.Date.now = () => now;
  window.setTimeout = (callback, delay = 0, ...args) => {
    const id = ++nextId;
    timers.set(id, { callback, args, at: now + Math.max(0, Number(delay) || 0) });
    return id;
  };
  window.clearTimeout = id => timers.delete(id);
  return {
    get pending() { return timers.size; },
    async advance(ms) {
      const target = now + ms;
      for (let count = 0; count < 1000; count++) {
        const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) { now = target; return; }
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        await timer.callback(...timer.args);
      }
      assert.fail('Polling clock did not settle');
    },
  };
}

async function mount(t, route = () => undefined, { session = {}, expectedRows = 3, urlThread = A, automaticClock = false, language = 'zh-CN', delayedMath = false } = {}) {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `http://127.0.0.1:4317/?thread=${urlThread}`, runScripts: 'outside-only', pretendToBeVisual: true });
  Object.defineProperty(dom.window.navigator, 'language', { value: language, configurable: true }); // Existing Chinese-copy fixtures default to zh-CN.
  t.after(() => dom.window.close());
  const { window } = dom, requests = [], errors = [], intervals = [];
  Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });
  window.File.prototype.arrayBuffer = function () { return new Promise((resolve, reject) => { const reader = new window.FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsArrayBuffer(this); }); };
  for (const [key, value] of Object.entries(session)) window.sessionStorage.setItem(key, value);
  window.matchMedia = query => ({ matches: !query.includes('max-width'), addEventListener() {}, removeEventListener() {} });
  window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  window.HTMLElement.prototype.setPointerCapture = function () {};
  window.HTMLElement.prototype.releasePointerCapture = function () {};
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.show = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
  window.setInterval = callback => { intervals.push(callback); return intervals.length; };
  const clock = automaticClock ? pollingClock(window) : null;
  window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  let savedOrder = { revision: 0, order: { projects: [], threads: {} } };
  window.fetch = async (path, options = {}) => {
    const call = { path, ...options }; requests.push(call);
    const special = await route(call);
    if (special !== undefined) return special;
    if (path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', allowedSendThreadId: null, callerThreadId: A, defaultThreadId: A });
    if (path === '/api/threads') return response({ threads: rows });
    const uploadMatch = path.match(/^\/api\/threads\/([^/?]+)\/uploads\/([^/?]+)$/);
    if (uploadMatch && !options.method) {
      const item = JSON.parse(window.sessionStorage.getItem(`codex-mobile-uploads:${uploadMatch[1]}`) || '[]').find(item => item.uploadId === uploadMatch[2]);
      return response(item?.receipt ? { state: 'uploaded', receipt: item.receipt } : { state: 'not_found' });
    }
    if (path === '/api/sidebar-order') {
      if (options.method === 'PUT') { const body = JSON.parse(options.body); savedOrder = { revision: savedOrder.revision + 1, order: body.order }; }
      return response(savedOrder);
    }
    const match = path.match(/^\/api\/threads\/([^/?]+)$/);
    if (match) return response(snapshot(match[1]));
    throw new Error(`Unexpected UI request: ${path}`);
  };
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const mathGate = delayedMath ? deferred() : null;
  window.__modules = {};
  for (const match of source.matchAll(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm)) {
    const modules = { ...await import(new URL('../public/' + match[2].slice(2), import.meta.url)) };
    if (modules.createApi) { const create = modules.createApi; modules.createApi = options => create({ ...options, fetchImpl: window.fetch }); }
    if (modules.appendMarkdown) { const append = modules.appendMarkdown; modules.appendMarkdown = (parent, value, _doc, options) => append(parent, value, window.document, options); }
    if (modules.appendMarkdown && mathGate) {
      const markdownSource = (await readFile(new URL('../public/markdown.js', import.meta.url), 'utf8'))
        .replace(/^import .*;\r?\n/gm, '')
        .replaceAll('export ', '')
        .replace('import("./vendor/katex/katex.mjs")', 'releaseKatex');
      const [{ createI18n }, { splitLocalReference }] = await Promise.all([
        import('../public/i18n.js'), import('../public/files.js')
      ]);
      const createDelayedMarkdown = new Function('createI18n', 'splitLocalReference', 'releaseKatex', 'window', `${markdownSource}\nreturn { appendMarkdown, parseMarkdown, safeHref, mathReady };`);
      Object.assign(modules, createDelayedMarkdown(createI18n, splitLocalReference, mathGate.promise, window));
    }
    window.__modules[match[2]] = modules;
  }
  source = source.replace(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm, (_, names, path) => `const {${names.replace(/\s+as\s+/g, ':')}} = globalThis.__modules[${JSON.stringify(path)}];`);
  window.eval(source);
  const doc = window.document;
  await until(() => doc.querySelector('#transcript').textContent.includes('Alpha reply') && doc.querySelectorAll('.task-item').length === expectedRows, 'initial task content and list').catch(error => {
    throw new Error(`${error.message}; app errors: ${errors.map(item => item?.message || item).join('; ')}`);
  });
  assert.deepEqual(errors, []);
  return { window, doc, requests, errors, intervals, clock, mathGate, mathReady: window.__modules['./markdown.js']?.mathReady, markdown: window.__modules['./markdown.js'], savedOrder: () => savedOrder };
}

test('model settings stay scoped to each chat and omit overrides for default and active supplements', async t => {
  let active = false;
  const options = [{ id: 'gpt-6-luna', efforts: ['low', 'high', 'max'] }, { id: 'gpt-6-astra', efforts: ['high', 'ultra'] }];
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, modelOptions: { send: options, create: options } });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply', active ? 'active' : 'idle'));
    if (call.path.endsWith('/messages')) return response({ accepted: true });
  });
  const change = (id, value) => { const node = ui.doc.getElementById(id); node.value = value; node.dispatchEvent(new ui.window.Event('change', { bubbles: true })); };
  ui.doc.getElementById('modelSettingsButton').click();
  assert.equal(ui.doc.getElementById('messageModel').value, '');
  change('messageModel', 'gpt-6-luna'); change('messageThinking', 'high');
  assert.ok(![...ui.doc.getElementById('messageThinking').options].some(value => value.value === 'ultra'));
  ui.doc.getElementById('modelSettingsDone').click();
  const stored = JSON.parse(ui.window.sessionStorage.getItem(`codex-mobile-model:${A}`));
  assert.deepEqual(stored, { model: 'gpt-6-luna', thinking: 'high' });
  const input = ui.doc.getElementById('promptInput'); input.value = 'selected'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'POST'), 'selected send');
  const first = JSON.parse(ui.requests.find(call => call.method === 'POST').body);
  assert.equal(first.model, 'gpt-6-luna'); assert.equal(first.thinking, 'high');
  await until(() => !ui.doc.getElementById('modelSettingsButton').disabled, 'send settled');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta', 'second chat selected');
  ui.doc.getElementById('modelSettingsButton').click(); assert.equal(ui.doc.getElementById('messageModel').value, '');
  ui.doc.getElementById('modelSettingsDone').click();
  await until(() => ui.doc.getElementById('transcript').textContent.includes('Beta reply'), 'second chat loaded');
  active = true;
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Alpha', 'first chat restored');
  assert.match(ui.doc.getElementById('modelSettingsButton').textContent, /6-luna/);
  await until(() => ui.doc.getElementById('sendButton').getAttribute('aria-label') === '补充到当前轮次', 'active send mode');
  input.value = 'supplement'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.requests.filter(call => call.method === 'POST').length === 2, 'active supplement');
  const second = JSON.parse(ui.requests.filter(call => call.method === 'POST')[1].body);
  assert.equal(second.model, undefined); assert.equal(second.thinking, undefined);
  assert.deepEqual(JSON.parse(ui.window.sessionStorage.getItem(`codex-mobile-model:${A}`)), stored);
  await until(() => !ui.doc.getElementById('modelSettingsButton').disabled, 'active send settled');
});

test('null model storage does not break the page and desktop default sends no overrides', async t => {
  const ui = await mount(t, call => call.path.endsWith('/messages') ? response({ accepted: true }) : undefined, { session: { [`codex-mobile-model:${A}`]: 'null' } });
  const input = ui.doc.getElementById('promptInput'); input.value = 'desktop default'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'POST'), 'default send');
  const body = JSON.parse(ui.requests.find(call => call.method === 'POST').body);
  assert.equal(body.model, undefined); assert.equal(body.thinking, undefined); assert.deepEqual(ui.errors, []);
  await until(() => !ui.doc.getElementById('modelSettingsButton').disabled, 'default send settled');
});

test('followup suggestions fill only the current draft and confirm before appending to existing text', async t => {
  const prompt = '将这份示例报告精简为适合20分钟汇报的版本，保留关键图表和主要结论。';
  const ui = await mount(t, call => call.path === `/api/threads/${A}` ? response(snapshot(A, `Alpha reply\n\n- :codex-followup[精简为20分钟版]{prompt=${JSON.stringify(prompt)}}`)) : undefined);
  const button = ui.doc.querySelector('.markdown-followup'), input = ui.doc.getElementById('promptInput');
  assert.ok(button && !button.disabled);
  button.click();
  assert.equal(input.value, prompt);
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-draft:${A}`), prompt);
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
  input.value = '保留原来的草稿'; input.dispatchEvent(new ui.window.Event('input'));
  button.click();
  assert.equal(input.value, '保留原来的草稿');
  assert.equal(ui.doc.getElementById('followupDraftDialog').open, true);
  ui.doc.getElementById('followupDraftCancel').click();
  assert.equal(input.value, '保留原来的草稿');
  button.click(); ui.doc.getElementById('followupDraftAppend').click();
  assert.equal(input.value, `保留原来的草稿\n\n${prompt}`);
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
  assert.deepEqual(ui.errors, []);
});

test('composer shows one icon action and empty submission never stops an active turn', async t => {
  let active = false;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply', active ? 'active' : 'idle'));
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: active, turnId: active ? 'active-turn' : null, pendingRequestCount: 0 });
  });
  const input = ui.doc.getElementById('promptInput'), send = ui.doc.getElementById('sendButton'), stop = ui.doc.getElementById('stopButton');
  assert.equal(send.hidden, false); assert.equal(send.disabled, true); assert.equal(send.textContent, '↑'); assert.equal(stop.hidden, true);
  active = true; ui.doc.getElementById('refreshButton').click();
  await until(() => !stop.hidden && !stop.disabled, 'authoritative active stop');
  assert.equal(send.hidden, true); assert.equal(stop.textContent, ''); assert.ok(stop.querySelector('.stop-icon'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
  input.value = '补充内容'; input.dispatchEvent(new ui.window.Event('input'));
  assert.equal(send.hidden, false); assert.equal(stop.hidden, true); assert.equal(send.disabled, false);
  assert.equal(send.getAttribute('aria-label'), '补充到当前轮次');
  assert.equal(ui.doc.getElementById('composerHint').textContent, '');
  stop.click();
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
  input.value = ''; input.dispatchEvent(new ui.window.Event('input'));
  assert.equal(stop.hidden, false); assert.equal(send.hidden, true);
});

test('slow control refresh stays in the background while thread switches preserve drafts and unavailable state', async t => {
  const delayedControl = deferred();
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return delayedControl.promise;
    if (call.path === `/api/threads/${B}/control`) return response({ threadId: B, available: false, reason: 'OWNER_UNAVAILABLE', pendingRequestCount: 0 });
    if (call.path.endsWith('/control')) return response({ threadId: C, available: true, canStop: false, pendingRequestCount: 0 });
  }, { automaticClock: true });

  assert.ok(ui.doc.getElementById('transcript').textContent.includes('Alpha reply'));
  assert.ok(ui.requests.some(call => call.path === `/api/threads/${A}/control`));
  ui.doc.getElementById('refreshButton').click();
  await ui.clock.advance(0);
  const statusReads = ui.requests.filter(call => call.path === '/api/status').length;
  const historyReads = ui.requests.filter(call => call.path === `/api/threads/${A}`).length;
  ui.doc.getElementById('refreshButton').click();
  await ui.clock.advance(0);
  assert.ok(ui.requests.filter(call => call.path === '/api/status').length > statusReads, 'status polling continues during the pending control read');
  assert.ok(ui.requests.filter(call => call.path === `/api/threads/${A}`).length > historyReads, 'history polling continues during the pending control read');
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/control`).length, 1, 'pending control reads are coalesced by thread');
  const input = ui.doc.getElementById('promptInput');
  input.value = 'draft for Alpha'; input.dispatchEvent(new ui.window.Event('input'));

  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta' && ui.doc.getElementById('transcript').textContent.includes('Beta reply'), 'switch while prior control read is pending');
  assert.equal(input.value, '');
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-draft:${A}`), 'draft for Alpha');
  await until(() => ui.doc.getElementById('controlSummary').textContent.includes('OWNER_UNAVAILABLE'), 'real unavailable result displayed');

  delayedControl.resolve(response({ threadId: A, available: true, canStop: true, turnId: 'old-alpha-turn', pendingRequestCount: 0 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Beta');
  assert.equal(ui.doc.getElementById('controlSummary').textContent, 'OWNER_UNAVAILABLE');
  assert.equal(ui.doc.getElementById('stopButton').hidden, true);

  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Alpha' && input.value === 'draft for Alpha', 'saved draft restored');
  assert.deepEqual(ui.errors, []);
});

test('app starts while math import is delayed and transcript plus other Markdown consumers hydrate in place', async t => {
  const formulaText = 'Alpha reply\n\nInline $x^2$ and display $$y^2$$.\n\nBad $\\frac{1}{$ then valid $z^2$.';
  const ui = await mount(t, call => call.path === `/api/threads/${A}` ? response(snapshot(A, formulaText)) : undefined, { delayedMath: true });
  const input = ui.doc.getElementById('promptInput');
  assert.ok(ui.doc.getElementById('transcript').textContent.includes('Alpha reply'));
  assert.equal(ui.doc.querySelectorAll('#transcript .markdown-math-fallback').length, 4);
  assert.equal(ui.doc.querySelectorAll('#transcript .katex').length, 0);

  input.value = 'Alpha draft'; input.dispatchEvent(new ui.window.Event('input'));
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta', 'switch while math import is pending');
  input.value = 'Beta draft'; input.dispatchEvent(new ui.window.Event('input'));
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Alpha' && input.value === 'Alpha draft', 'restore selection and draft before math loads');

  const other = ui.doc.createElement('div');
  ui.doc.body.append(other);
  ui.markdown.appendMarkdown(other, 'Other view $q^2$ and invalid $\\frac{1}{$.', ui.doc);
  const overLimit = ui.doc.createElement('div');
  ui.doc.body.append(overLimit);
  ui.markdown.appendMarkdown(overLimit, Array.from({ length: 129 }, () => '$w$').join(' '), ui.doc);
  assert.equal(other.querySelectorAll('.katex').length, 0);
  assert.equal(overLimit.querySelectorAll('.markdown-math-fallback').length, 129);

  const katex = (await import('../public/vendor/katex/katex.mjs')).default;
  ui.mathGate.resolve({ default: katex });
  await ui.mathReady;
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha');
  assert.equal(input.value, 'Alpha draft');
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-draft:${B}`), 'Beta draft');
  assert.equal(ui.doc.querySelectorAll('#transcript .katex').length, 3);
  assert.equal(ui.doc.querySelectorAll('#transcript .markdown-math-fallback').length, 1);
  assert.equal(other.querySelectorAll('.katex').length, 1);
  assert.equal(other.querySelectorAll('.markdown-math-fallback').length, 1);
  assert.equal(overLimit.querySelectorAll('.katex').length, 128);
  assert.equal(overLimit.querySelectorAll('.markdown-math-fallback').length, 1);
  assert.deepEqual(ui.errors, []);
});

test('followup confirmation clears on selection change and login expiry without changing drafts', async t => {
  const suggestion = ':codex-followup[继续检查]{prompt="未发送的私有建议"}';
  const ui = await mount(t, call => call.path === `/api/threads/${A}` ? response(snapshot(A, `Alpha reply\n\n${suggestion}`)) : undefined);
  const input = ui.doc.getElementById('promptInput'), dialog = ui.doc.getElementById('followupDraftDialog'), preview = ui.doc.getElementById('followupDraftPreview');
  input.value = '原始草稿'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('.markdown-followup').click(); assert.equal(dialog.open, true);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  assert.equal(dialog.open, false); assert.equal(preview.textContent, '');
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta', 'selection switch completed');
  ui.doc.getElementById('followupDraftAppend').click(); assert.equal(input.value, '');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Alpha' && !input.disabled, 'original draft restored');
  assert.equal(input.value, '原始草稿');
  ui.doc.querySelector('.markdown-followup').click(); assert.equal(dialog.open, true);
  ui.window.dispatchEvent(new ui.window.Event('bridge-login-required'));
  assert.equal(dialog.open, false); assert.equal(preview.textContent, '');
  ui.doc.getElementById('followupDraftAppend').click(); ui.doc.querySelector('.markdown-followup').click();
  assert.equal(dialog.open, false); assert.equal(input.value, '原始草稿');
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-draft:${A}`), '原始草稿');
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
});

test('successful logout clears a pending followup confirmation and prevents a late append', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/access') return response({ mode: 'remote' });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply\n\n:codex-followup[继续检查]{prompt="未发送的私有建议"}'));
    if (call.path === '/auth/logout') return response({ loggedOut: true });
  });
  const input = ui.doc.getElementById('promptInput'); input.value = '保留的草稿'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('.markdown-followup').click();
  [...ui.doc.querySelectorAll('.access-panel button')].find(button => button.textContent === '退出登录').click();
  await until(() => !ui.doc.querySelector('.access-notice').hidden, 'logout confirmed');
  assert.equal(ui.doc.getElementById('followupDraftDialog').open, false);
  assert.equal(ui.doc.getElementById('followupDraftPreview').textContent, '');
  ui.doc.getElementById('followupDraftAppend').click(); ui.doc.querySelector('.markdown-followup').click();
  assert.equal(input.value, '保留的草稿'); assert.equal(ui.doc.getElementById('followupDraftDialog').open, false);
  assert.deepEqual(ui.requests.filter(call => call.method === 'POST').map(call => call.path), ['/auth/logout']);
});

test('an unready attachment keeps the active arrow disabled and cannot trigger stop', async t => {
  const pendingUpload = { ...readyAttachment(), state: 'unknown', receipt: undefined };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply', 'active'));
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: true, turnId: 'active-turn', pendingRequestCount: 0 });
  }, { session: { [`codex-mobile-uploads:${A}`]: JSON.stringify([pendingUpload]) } });
  assert.equal(ui.doc.getElementById('sendButton').hidden, false); assert.equal(ui.doc.getElementById('sendButton').disabled, true);
  assert.equal(ui.doc.getElementById('stopButton').hidden, true);
  ui.doc.getElementById('stopButton').click();
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
});

test('a cold historical chat shows quiet standby and can explicitly send with inherited settings', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    if (call.path === '/api/threads') return response({ threads: rows.map(row => row.id === A ? { ...row, status: 'notLoaded' } : row) });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply', 'notLoaded'));
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: false, canStop: false, code: 'OWNER_UNAVAILABLE', standby: true, reason: '会话待命，发送时沿用桌面设置' });
    if (call.path === `/api/threads/${A}/messages`) return response({ accepted: true });
  });
  await until(() => ui.doc.getElementById('controlSummary').textContent.includes('沿用桌面设置'), 'standby state loaded');
  assert.equal(ui.doc.getElementById('controlState').hidden, true);
  assert.equal(ui.doc.getElementById('stopButton').hidden, true);
  assert.equal(ui.doc.getElementById('threadStatus').textContent, '等待继续');
  const input = ui.doc.getElementById('promptInput'); input.value = '继续同一会话'; input.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.doc.getElementById('sendButton').disabled, false); assert.equal(ui.doc.getElementById('stopButton').hidden, true);
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.requests.some(call => call.path.endsWith('/messages') && call.method === 'POST'), 'explicit ordinary cold send');
  const body = JSON.parse(ui.requests.find(call => call.method === 'POST').body);
  assert.equal(body.prompt, '继续同一会话'); assert.equal(body.permissionMode, undefined);
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  await until(() => ui.doc.getElementById('notice').textContent.includes('桌面已接收消息') && !ui.doc.getElementById('modelSettingsButton').disabled, 'cold send refreshed and settled');
});

test('composer sends explicit permission only for a new turn and preserves the next choice for active supplements', async t => {
  let active = false;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, permissionOptions: { send: [{ id: 'full-access' }, { id: 'request-approval' }], create: [] } });
    if (call.path === `/api/threads/${A}`) return response(snapshot(A, 'Alpha reply', active ? 'active' : 'idle'));
    if (call.path.endsWith('/messages')) return response({ accepted: true });
  });
  const select = ui.doc.getElementById('messagePermission'); select.value = 'request-approval'; select.dispatchEvent(new ui.window.Event('change'));
  const send = value => { const input = ui.doc.getElementById('promptInput'); input.value = value; input.dispatchEvent(new ui.window.Event('input')); ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true })); };
  send('new turn'); await until(() => ui.requests.some(call => call.method === 'POST'), 'permission send');
  assert.equal(JSON.parse(ui.requests.find(call => call.method === 'POST').body).permissionMode, 'request-approval');
  await until(() => !select.disabled, 'permission send settled');
  active = true; ui.doc.getElementById('refreshButton').click();
  await until(() => ui.doc.getElementById('sendButton').getAttribute('aria-label') === '补充到当前轮次', 'active mode');
  send('active supplement'); await until(() => ui.requests.filter(call => call.method === 'POST').length === 2, 'supplement send');
  assert.equal(JSON.parse(ui.requests.filter(call => call.method === 'POST')[1].body).permissionMode, undefined);
  await until(() => !select.disabled, 'supplement settled');
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-permission:${A}`), 'request-approval');
});

test('one native turn shows 165 minutes 36 seconds once across split work blocks and unchanged polls', async t => {
  let reads = 0;
  const turn = { id: 'long-native-turn', status: 'completed', startedAt: 1000, durationMs: (165 * 60 + 36) * 1000, items: [
    { id: 'work-one', type: 'activity', text: '恢复连接' },
    { id: 'question', type: 'agentMessage', phase: 'final_answer', text: 'Alpha reply 当前页面是否已正常加载？' },
    { id: 'work-two', type: 'activity', text: '核对状态' },
    { id: 'answer', type: 'userMessage', text: '已正常加载' },
    { id: 'work-three', type: 'activity', text: '读取子智能体历史' },
    { id: 'followup', type: 'userMessage', text: '但是显示的内容非常复杂' },
    { id: 'done', type: 'agentMessage', phase: 'final_answer', text: '已完成调整' },
  ] };
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) { reads++; return response({ ...snapshot(A), turns: [turn] }); }
  });
  const summaries = () => [...ui.doc.querySelectorAll('.work-process > summary')].map(node => node.textContent);
  assert.deepEqual(summaries(), ['工作过程', '工作过程', '工作过程 · 用时 165 分 36 秒']);
  ui.doc.getElementById('refreshButton').click();
  await until(() => reads >= 2, 'unchanged native poll');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(summaries(), ['工作过程', '工作过程', '工作过程 · 用时 165 分 36 秒']);
  assert.deepEqual(ui.errors, []);
});

test('transformed two-image native input reconciles one pending copy and preserves a distinct repeated user message', async t => {
  const names = ['Screenshot_20260929_091208_com.huawei.browser.jpg', 'Screenshot_20260929_091228_com.huawei.browser.jpg'];
  const ids = [UPLOAD, '00000000-0000-0000-0000-000000000005'];
  const paths = names.map((name, index) => `E:/project/mobile-uploads/${ids[index]}/${name}`);
  const draft = '请比较两张示例图片，并核对显示内容和累计用时。';
  const prompt = `${draft}\n\n附件：\n${names.map((name, index) => `[${name}](<${paths[index]}>)`).join('\n')}`;
  const nativePrompt = prompt.replaceAll('\n', '\r\n').replaceAll('(<', '(&lt;').replaceAll('>)', '&gt;)');
  const old = { id: 'preexisting-turn', startedAt: 1, status: 'completed', items: [{ id: 'old-native-user', type: 'userMessage', text: prompt }] };
  const current = { id: 'current-native-turn', startedAt: 2, status: 'inProgress', items: [{ id: 'new-native-user', type: 'userMessage', text: nativePrompt }, { id: 'reply', type: 'agentMessage', phase: 'final_answer', text: 'Alpha reply' }] };
  const pending = [{ requestId: '00000000-0000-0000-0000-000000000006', prompt, draftPrompt: draft, attachmentIds: ids, baselineKeys: ['preexisting-turn\u001fold-native-user'], state: 'accepted' }];
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) return response({ ...snapshot(A), turns: [old, current], page: { hasMore: true, nextCursor: 'before' } });
    if (call.path === `/api/threads/${A}?cursor=before`) return response({ ...snapshot(A), turns: [old], page: { hasMore: false } });
    if (call.path.startsWith(`/api/threads/${A}/file?`)) return response({ code: 'FILE_FORBIDDEN', error: 'isolated access fixture' }, 403);
  }, { session: { [`codex-mobile-pending:${A}`]: JSON.stringify(pending) } });
  assert.equal(ui.doc.querySelectorAll('#transcript .message.user').length, 2);
  assert.equal(ui.doc.querySelectorAll('.message-pending').length, 0);
  const links = [...ui.doc.querySelectorAll('[data-turn-id="current-native-turn"] button[data-local-file]')];
  assert.deepEqual(links.map(node => node.dataset.localFile), paths);
  links[0].click();
  await until(() => ui.requests.some(call => call.path.startsWith(`/api/threads/${A}/file?`)), 'file reference stays scoped to selected thread');
  const fileCall = ui.requests.find(call => call.path.startsWith(`/api/threads/${A}/file?`));
  assert.equal(new URL(fileCall.path, 'http://fixture').searchParams.get('path'), paths[0]);
  ui.doc.getElementById('filesClose').click();
  ui.doc.getElementById('olderButton').click();
  await until(() => ui.doc.getElementById('olderButton').hidden, 'older page merged');
  ui.doc.getElementById('refreshButton').click();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(ui.doc.querySelectorAll('#transcript .message.user').length, 2);
  assert.equal(ui.doc.querySelectorAll('.message-pending').length, 0);
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
});

test('older bridge blocks a restored explicit permission without clearing the draft or posting', async t => {
  const ui = await mount(t, undefined, { session: { [`codex-mobile-permission:${A}`]: 'full-access' } });
  const input = ui.doc.getElementById('promptInput'); input.value = 'keep this draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  assert.equal(ui.requests.some(call => call.method === 'POST'), false); assert.equal(input.value, 'keep this draft');
  assert.match(ui.doc.getElementById('notice').textContent, /权限.*不可用/);
});

test('running supplement migration reconciles one stable user bubble through polling, older pages and cached thread switches', async t => {
  let migrated = false;
  const supplement = { id: 'native-user-id', type: 'userMessage', source: 'desktop-bridge', text: '同一条补充消息' };
  const old = { id: 'old-position', startedAt: 1000, status: 'completed', items: [supplement, { id: 'old-work', type: 'activity', text: '工具活动' }] };
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}?cursor=before`) return response({ ...snapshot(A), turns: [old], page: { hasMore: false } });
    if (call.path === `/api/threads/${A}`) return response({ ...snapshot(A), sendMode: 'follow-up', turns: migrated ? [{ id: 'new-position', startedAt: 1100, status: 'inProgress', items: [supplement, { id: 'reply', type: 'agentMessage', text: 'Alpha reply' }] }] : [{ ...old, items: [...old.items, { id: 'reply', type: 'agentMessage', text: 'Alpha reply' }] }], page: { hasMore: true, nextCursor: 'before' } });
  });
  assert.equal(ui.doc.querySelectorAll('.message.user').length, 1); migrated = true; ui.doc.getElementById('refreshButton').click();
  await until(() => ui.doc.querySelector('.turn[data-turn-id="new-position"] .message.user'), 'migrated position');
  assert.equal(ui.doc.querySelectorAll('.message.user').length, 1);
  ui.doc.getElementById('olderButton').click(); await until(() => ui.doc.getElementById('olderButton').hidden, 'old page settled');
  assert.equal(ui.doc.querySelectorAll('.message.user').length, 1);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click(); await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta', 'other chat');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click(); await until(() => ui.doc.querySelector('.turn[data-turn-id="new-position"] .message.user'), 'cached restore');
  await until(() => ui.doc.getElementById('threadLoadState').hidden, 'cached latest read settled');
  assert.equal(ui.doc.querySelectorAll('.message.user').length, 1);
});

test('long current questions stay collapsed across polls, reload and thread switches without losing answers', async t => {
  const request = { requestId: 'current-long', token: 'long-token', kind: 'asyncUserInput', turnId: 'turn-live', title: '等待回答', actionable: true, questions: [{ id: 'q', header: '资源', question: '请确认超算任务资源与路径。'.repeat(100) + '/scratch/project/very-long-name/run.slurm', options: [], isOther: false, isSecret: false }] };
  const route = call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    const control = call.path.match(/^\/api\/threads\/([^/]+)\/control$/);
    if (control) return response({ threadId: control[1], available: true, pendingRequestCount: control[1] === A ? 1 : 0, pendingRequests: control[1] === A ? [request] : [], historicalQuestions: [] });
  };
  const ui = await mount(t, route); await until(() => ui.doc.querySelector('.pending-question-form'), 'long question');
  assert.equal(ui.doc.getElementById('pendingRequests').hidden, true);
  ui.doc.getElementById('controlToggle').click(); assert.equal(ui.doc.getElementById('pendingRequests').hidden, false);
  const answer = ui.doc.querySelector('.pending-answer'); answer.value = '保留草稿'; answer.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('closePendingRequests').click(); assert.equal(ui.doc.getElementById('pendingRequests').hidden, true);
  ui.doc.getElementById('refreshControl').click(); await until(() => ui.requests.filter(call => call.path.endsWith('/control')).length >= 2, 'poll');
  assert.equal(ui.doc.getElementById('pendingRequests').hidden, true);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click(); await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta', 'switch away');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click(); await until(() => ui.doc.querySelector('.pending-answer'), 'return');
  assert.equal(ui.doc.getElementById('pendingRequests').hidden, true); assert.equal(ui.doc.querySelector('.pending-answer').value, '保留草稿');
  const session = Object.fromEntries(Array.from({ length: ui.window.sessionStorage.length }, (_, i) => ui.window.sessionStorage.key(i)).map(key => [key, ui.window.sessionStorage.getItem(key)]));
  const reloaded = await mount(t, route, { session }); await until(() => reloaded.doc.querySelector('.pending-answer'), 'reload long question');
  assert.equal(reloaded.doc.getElementById('pendingRequests').hidden, true); assert.equal(reloaded.doc.querySelector('.pending-answer').value, '保留草稿');
  assert.ok(!reloaded.doc.getElementById('controlSummary').textContent.includes('新'));
});

test('positively stale questions move to closable history and offline controls preserve actionable requests', async t => {
  let available = true;
  const request = { requestId: 'old-question', token: 'old-token', turnId: 'old-turn', kind: 'asyncUserInput', actionable: false, reasonCode: 'NOT_LATEST_TURN', questions: [{ id: 'q', question: '旧问题', options: [] }] };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response(available ? { threadId: A, available: true, pendingRequestCount: 1, pendingRequests: [request] } : { threadId: A, available: false, reason: '连接中断' });
  });
  await until(() => ui.doc.getElementById('historicalQuestionsContent').textContent.includes('旧问题'), 'stale migrated');
  assert.equal(ui.doc.querySelectorAll('.pending-card').length, 0); assert.equal(ui.doc.getElementById('controlState').hidden, true);
  ui.doc.getElementById('closeHistoricalQuestions').click(); assert.equal(ui.doc.getElementById('historicalQuestions').hidden, true);
  ui.doc.getElementById('refreshControl').click(); await until(() => ui.requests.filter(call => call.path.endsWith('/control')).length === 2, 'stale poll'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(ui.doc.getElementById('historicalQuestions').hidden, true); assert.equal(ui.doc.getElementById('showHistoricalQuestions').hidden, false);
  ui.doc.getElementById('showHistoricalQuestions').click(); assert.equal(ui.doc.getElementById('historicalQuestions').hidden, false);
  available = false; ui.doc.getElementById('refreshControl').click(); await until(() => ui.doc.getElementById('controlSummary').textContent.includes('连接中断'), 'unavailable retained');
  assert.equal(ui.doc.getElementById('historicalQuestions').hidden, false);
});

test('historical questions stay in collapsed task details without a pending banner', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 0, pendingRequests: [], historicalQuestions: [{ requestId: 'async:old', kind: 'asyncUserInput', actionable: false, questions: [{ question: 'Old access choice?' }] }] });
  });
  await until(() => ui.doc.querySelector('.historical-questions').textContent.includes('Old access choice'), 'historical disclosure');
  assert.equal(ui.doc.querySelector('#threadDetails').open, false);
  assert.equal(ui.doc.querySelector('.historical-questions').closest('details').id, 'threadDetails');
  assert.equal(ui.doc.querySelector('#historicalQuestionsTitle').textContent, '历史提问');
  assert.equal(ui.doc.querySelector('#pendingRequests .historical-questions'), null);
  assert.match(ui.doc.querySelector('.historical-questions').textContent, /Old access choice/);
  assert.equal(ui.doc.querySelector('#controlSummary').textContent, '');
  assert.equal(ui.doc.querySelector('#controlState').hidden, true);
  assert.equal(ui.doc.querySelector('.pending-question-form'), null);
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
});

test('task detail expansion survives polling and remains scoped to each thread while live approvals stay visible', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    const match = call.path.match(/^\/api\/threads\/([^/]+)\/control$/);
    if (match) return response({ threadId: match[1], available: true, pendingRequests: match[1] === A ? [approvalRequest] : [], historicalQuestions: [{ questions: [{ question: match[1] === A ? 'Alpha historical question' : 'Beta historical question' }] }] });
  });
  const details = ui.doc.querySelector('#threadDetails');
  await until(() => ui.doc.querySelector('.pending-card'), 'live approval');
  assert.equal(details.open, false); assert.equal(ui.doc.querySelector('#controlState').hidden, false);
  assert.ok(ui.doc.querySelector('#pendingRequests .pending-accept'));
  details.open = true; await new Promise(resolve => setTimeout(resolve, 0));
  const before = ui.requests.length; ui.doc.querySelector('#refreshButton').click();
  await until(() => ui.requests.length > before, 'refresh started'); await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(details.open, true);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.querySelector('#historicalQuestionsContent').textContent.includes('Beta historical'), 'beta history');
  assert.equal(details.open, false); assert.equal(ui.doc.querySelector('#controlState').hidden, true);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.querySelector('#historicalQuestionsContent').textContent.includes('Alpha historical'), 'alpha history restored');
  assert.equal(details.open, true); details.open = false; await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(ui.requests.some(call => call.method === 'POST'), false);
});

test('idle composer keeps attachment and font controls accessible without a routine status row', async t => {
  const ui = await mount(t);
  assert.equal(ui.doc.querySelector('#composerHint').classList.contains('sr-only'), true);
  assert.equal(ui.doc.querySelector('#attachButton').parentElement.className, 'composer-input-row');
  assert.equal(ui.doc.querySelector('#sendButton').parentElement, ui.doc.querySelector('#promptInput').parentElement);
  assert.equal(ui.doc.querySelector('#messagePermission').closest('dialog').id, 'modelSettingsDialog');
  assert.equal(ui.doc.querySelector('#attachButton').getAttribute('aria-describedby'), 'attachmentHelp');
  assert.match(ui.doc.querySelector('#attachmentHelp').textContent, /当前会话目录/);
  assert.equal(ui.doc.querySelector('#fontControl').closest('.conversation-header') !== null, true);
  assert.equal(ui.doc.querySelector('#olderRow').parentElement.id, 'transcript');
  assert.equal(ui.doc.querySelector('#historyState').textContent, '已到最早消息');
  ui.doc.querySelector('#fontControl').click(); assert.equal(ui.doc.querySelector('#fontDialog').open, true);
  assert.equal(ui.doc.querySelector('#fontRange').min, '10'); assert.equal(ui.doc.querySelector('#fontRange').max, '48');
});

test('ready attachments compose on explicit Send and clear the original raw draft on acceptance', async t => {
  let sent;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) { sent = JSON.parse(call.body); return response({ accepted: true }); }
  }, { session: { [`codex-mobile-uploads:${A}`]: JSON.stringify([readyAttachment()]), [`codex-mobile-draft:${A}`]: 'inspect notes' } });
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(ui.doc.querySelector('#attachmentList').children.length, 1);
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => sent && ui.doc.querySelector('#attachmentList').children.length === 0, 'accepted attachment send');
  assert.match(sent.prompt, /^inspect notes\n\n附件：\n\[notes.txt\]/);
  assert.equal(ui.doc.querySelector('#promptInput').value, '');
});

test('reloading an unknown attachment message recovers its receipt and clears captured chips once', async t => {
  const attachment = readyAttachment(), requestId = '00000000-0000-0000-0000-000000000005';
  const prompt = `请查看这些附件。\n\n附件：\n[notes.txt](<${attachment.absolutePath}>)`;
  const ui = await mount(t, call => {
    if (call.path.includes('/messages/')) return response({ state: 'accepted', receipt: { accepted: true, requestId, threadId: A } });
  }, { session: { [`codex-mobile-uploads:${A}`]: JSON.stringify([attachment]), [`codex-mobile-pending:${A}`]: JSON.stringify([{ requestId, prompt, draftPrompt: '', attachmentIds: [UPLOAD], state: 'unknown', draftRevision: 'legacy' }]) } });
  await until(() => ui.doc.querySelector('#attachmentList').children.length === 0, 'receipt attachment cleanup');
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
});

test('a newer uploaded attachment survives acceptance of an older attachment snapshot', async t => {
  const sending = deferred();
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) return sending.promise;
    if (call.path.includes('/uploads/') && call.method === 'POST') {
      const url = new URL(call.path, 'http://localhost'), uploadId = url.pathname.split('/').at(-1);
      return response({ uploaded: true, uploadId, threadId: A, name: url.searchParams.get('name'), size: Number(url.searchParams.get('size')), sha256: url.searchParams.get('sha256'), path: `mobile-uploads/${uploadId}/new.txt`, absolutePath: `E:/project/mobile-uploads/${uploadId}/new.txt`, uploadedAt: 1 });
    }
  }, { session: { [`codex-mobile-uploads:${A}`]: JSON.stringify([readyAttachment()]) } });
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'POST'), 'message dispatched');
  const picker = ui.doc.querySelector('#attachmentPicker');
  Object.defineProperty(picker, 'files', { value: [new ui.window.File(['new'], 'new.txt')], configurable: true });
  picker.dispatchEvent(new ui.window.Event('change'));
  await until(() => ui.doc.querySelector('#attachmentList').textContent.includes('new.txt') && ui.doc.querySelector('#attachmentList').textContent.split('已就绪').length === 3, 'new upload ready');
  sending.resolve(response({ accepted: true }));
  await until(() => ui.doc.querySelector('#attachmentList').children.length === 1, 'old snapshot cleared');
  assert.match(ui.doc.querySelector('#attachmentList').textContent, /new.txt/);
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/messages`).length, 1);
});

test('an unresolved restored upload blocks composer dispatch and offers matching file reselection', async t => {
  const item = readyAttachment(); item.state = 'uploading'; delete item.receipt;
  const ui = await mount(t, call => call.path.includes('/uploads/') ? response({ state: 'not_found' }) : undefined,
    { session: { [`codex-mobile-uploads:${A}`]: JSON.stringify([item]), [`codex-mobile-draft:${A}`]: 'please inspect' } });
  await until(() => ui.doc.querySelector('#attachmentList').textContent.includes('同一文件'), 'not found recovery');
  assert.equal(ui.doc.querySelector('#sendButton').disabled, true);
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(ui.doc.querySelector('#promptInput').value, 'please inspect');
});

test('the conversation Files button browses and a local Markdown link opens its file preview', async t => {
  const targetPath = 'E:/work/project/guide.md';
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A, `Alpha reply. Read [the guide](<${targetPath}:12>)`);
      data.thread.cwd = 'E:/work/project';
      return response(data);
    }
    if (call.path.startsWith(`/api/threads/${A}/files?`)) return response({ path: '', parentPath: null, entries: [{ name: 'guide.md', path: 'guide.md', type: 'file', size: 25, modifiedAt: null, previewKind: 'text' }], truncated: false });
    if (call.path.startsWith(`/api/threads/${A}/file?`)) {
      const url = new URL(call.path, 'http://127.0.0.1');
      assert.equal(url.searchParams.get('path'), targetPath);
      assert.equal(url.searchParams.get('mode'), 'info');
      return response({ name: 'guide.md', path: 'guide.md', size: 25, modifiedAt: null, previewKind: null });
    }
  });
  const button = ui.doc.querySelector('.markdown-file-link');
  assert.ok(button);
  assert.equal(button.dataset.localFile, targetPath);
  ui.doc.querySelector('#filesButton').click();
  await until(() => ui.doc.querySelector('#filesEntries').children.length === 1, 'file list');
  assert.equal(ui.requests.some(call => call.path.startsWith(`/api/threads/${A}/files?`)), true);
  button.click();
  await until(() => ui.doc.querySelector('#filesState').textContent.includes('无法预览'), 'linked file metadata');
  assert.equal(ui.doc.querySelector('#filesDownload').hidden, false);
  assert.equal(ui.requests.some(call => call.path.startsWith(`/api/threads/${A}/file?`)), true);
  ui.doc.querySelector('#filesBack').click();
  await until(() => ui.requests.filter(call => call.path.startsWith(`/api/threads/${A}/files?`)).length === 2, 'return to cwd from absolute file');
  assert.deepEqual(ui.errors, []);
});

const R = '00000000-0000-0000-0000-000000000010';
const pendingSession = () => ({
  [`codex-mobile-pending:${A}`]: JSON.stringify([{ requestId: R, prompt: 'Interrupted send', baselineKeys: [], state: 'sending' }]),
  [`codex-mobile-unknown:${A}`]: '1', [`codex-mobile-draft:${A}`]: 'Interrupted send'
});

test('reload recovers an accepted receipt without resending the persisted message', async t => {
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages/${R}`) return response({ state: 'accepted', receipt: { accepted: true, threadId: A, requestId: R } });
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A);
      data.turns[0].items.push({ id: 'saved-input', type: 'userMessage', text: 'Interrupted send' });
      return response(data);
    }
  }, { session: pendingSession() });
  await until(() => ui.doc.querySelector('#notice').textContent.includes('已找回'), 'receipt recovery');
  assert.equal(ui.doc.querySelector('#promptInput').value, '');
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-unknown:${A}`), null);
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-pending:${A}`), null);
  assert.equal(ui.doc.querySelector('#transcript').textContent.split('Interrupted send').length - 1, 1);
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
});

for (const result of [{ state: 'unknown' }, { state: 'not_found' }, { state: 'accepted', receipt: { accepted: true, threadId: B, requestId: R } }]) {
  test(`receipt ${result.state}${result.receipt ? ' for another task' : ''} cannot unlock an uncertain send`, async t => {
    const ui = await mount(t, call => call.path === `/api/threads/${A}/messages/${R}` ? response(result) : undefined, { session: pendingSession() });
    await until(() => ui.requests.some(call => call.path.endsWith(`/messages/${R}`)), 'receipt read');
    await new Promise(r => setTimeout(r, 10));
    assert.equal(ui.doc.querySelector('#sendButton').disabled, true);
    assert.equal(ui.doc.querySelector('#promptInput').value, 'Interrupted send');
    assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-unknown:${A}`), '1');
    assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  });
}

test('native rename sends only the chosen task and refreshes its desktop title', async t => {
  let title = 'Beta';
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, threadManagement: { rename: true, pin: true, archive: true } });
    if (call.path === '/api/threads') return response({ threads: rows.map(row => row.id === B ? { ...row, title } : row) });
    if (call.path === `/api/threads/${B}/settings`) {
      const body = JSON.parse(call.body); title = body.value;
      return response({ ...body, threadId: B, accepted: true });
    }
  });
  const row = ui.doc.querySelector(`.task-row[data-order-id="${B}"]`);
  [...row.querySelectorAll('.task-menu-actions button')].find(button => button.textContent === '重命名').click();
  assert.equal(ui.doc.querySelector('#threadActionDialog').open, true);
  ui.doc.querySelector('#threadNameInput').value = 'Renamed Beta';
  ui.doc.querySelector('#threadActionForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.doc.querySelector('#taskList').textContent.includes('Renamed Beta'), 'native title refresh');
  assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Alpha');
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(JSON.parse(ui.requests.find(call => call.method === 'POST').body), { action: 'rename', value: 'Renamed Beta' });
  assert.deepEqual(ui.errors, []);
});

test('protocol ambiguity keeps the exact request and disables another send', async t => {
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) return response({ code: 'PROTOCOL_ERROR', error: 'incompatible reply' }, 502);
    if (call.path.startsWith(`/api/threads/${A}/messages/`)) return response({ state: 'unknown' });
  });
  const input = ui.doc.querySelector('#promptInput'); input.value = 'Do not duplicate'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.doc.querySelector('#notice').textContent.includes('尚未确认'), 'uncertain result');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(ui.doc.querySelector('#sendButton').disabled, true);
  assert.equal(JSON.parse(ui.window.sessionStorage.getItem(`codex-mobile-pending:${A}`))[0].state, 'unknown');
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
});

test('unexpected POST 304 preserves the draft and delivery lock until read-only receipt recovery', async t => {
  let accepted = false;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) return new Response(null, { status: 304 });
    if (call.path.startsWith(`/api/threads/${A}/messages/`)) return response(accepted ? { state: 'accepted', receipt: { accepted: true, threadId: A, requestId: call.path.split('/').at(-1) } } : { state: 'unknown' });
  });
  const input = ui.doc.getElementById('promptInput'); input.value = 'Retain this unsent draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await until(() => ui.doc.getElementById('notice').textContent.includes('尚未确认'), 'unexpected 304 uncertainty');
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  assert.equal(input.value, 'Retain this unsent draft');
  assert.equal(ui.doc.getElementById('sendButton').disabled, true);
  assert.equal(JSON.parse(ui.window.sessionStorage.getItem(`codex-mobile-pending:${A}`))[0].state, 'unknown');
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  accepted = true;
  [...ui.doc.querySelectorAll('#notice button')].find(button => button.textContent === '重新核对回执').click();
  await until(() => !ui.window.sessionStorage.getItem(`codex-mobile-unknown:${A}`), 'read-only receipt recovery');
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  assert.equal(input.value, '');
});

test('storage failure prevents dispatch while keeping the draft', async t => {
  const ui = await mount(t);
  const original = ui.window.Storage.prototype.setItem;
  ui.window.Storage.prototype.setItem = function (key, value) {
    if (key.includes('pending:') || key.includes('unknown:')) throw new ui.window.DOMException('Storage full', 'QuotaExceededError');
    return original.call(this, key, value);
  };
  const input = ui.doc.querySelector('#promptInput'); input.value = 'Keep this draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(input.value, 'Keep this draft');
  assert.ok(ui.doc.querySelector('#notice').textContent.includes('尚未发送'));
});

test('editing away and back to the sent text still creates a distinct draft', async t => {
  const receipt = deferred();
  const ui = await mount(t, call => call.path === `/api/threads/${A}/messages` ? receipt.promise : undefined);
  const input = ui.doc.querySelector('#promptInput');
  input.value = 'Repeat intentionally'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'POST'), 'send started');
  assert.equal(input.disabled, false);
  input.value = 'different'; input.dispatchEvent(new ui.window.Event('input'));
  input.value = 'Repeat intentionally'; input.dispatchEvent(new ui.window.Event('input'));
  receipt.resolve(response({ accepted: true, threadId: A }));
  await until(() => ui.doc.querySelector('#notice').textContent.includes('桌面已接收'), 'acceptance settled');
  assert.equal(input.value, 'Repeat intentionally');
});

test('stop submits the exact observed turn once and restores idle controls', async t => {
  let stopped = false;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: !stopped, turnId: stopped ? null : 'observed-turn', pendingRequestCount: 0 });
    if (call.path === `/api/threads/${A}/stop`) {
      assert.deepEqual(JSON.parse(call.body), { turnId: 'observed-turn' });
      stopped = true;
      return response({ threadId: A, turnId: 'observed-turn', stopped: true });
    }
  });
  await until(() => !ui.doc.querySelector('#stopButton').hidden, 'stop capability ready');
  ui.doc.querySelector('#stopButton').click();
  ui.doc.querySelector('#stopButton').click();
  await until(() => ui.doc.querySelector('#stopButton').hidden, 'stopped UI');
  assert.equal(ui.requests.filter(call => call.path.endsWith('/stop')).length, 1);
  assert.ok(ui.doc.querySelector('#notice').textContent.includes('已停止'));
  assert.deepEqual(ui.errors, []);
});

const approvalRequest = {
  requestId: 'approval-1', token: 'approval-token', kind: 'commandApproval', turnId: 'turn-1', title: 'Run command', actionable: true, disabledReason: null,
  command: 'npm test -- --runInBand', cwd: 'E:/work/project', reason: 'Run the requested checks'
};

test('pending command approval shows full context and sends one explicit decision', async t => {
  let pending = true;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: pending ? 1 : 0, pendingRequests: pending ? [approvalRequest] : [] });
    if (call.path === `/api/threads/${A}/respond`) { pending = false; return response({ threadId: A, requestId: 'approval-1', delivered: true }); }
  });
  await until(() => ui.doc.querySelector('.pending-card'), 'command approval card');
  const card = ui.doc.querySelector('.pending-card');
  assert.ok(card.textContent.includes('npm test -- --runInBand'));
  assert.ok(card.textContent.includes('E:/work/project'));
  assert.ok(card.textContent.includes('Run the requested checks'));
  card.querySelector('.pending-accept').click();
  await until(() => card.textContent.includes('回复已送达桌面'), 'approval delivery receipt');
  const sent = ui.requests.find(call => call.path === `/api/threads/${A}/respond`);
  assert.deepEqual(JSON.parse(sent.body), { requestId: 'approval-1', token: 'approval-token', decision: 'accept' });
  assert.equal(card.querySelector('.pending-accept').disabled, true);
  await until(() => !ui.doc.querySelector('.pending-card'), 'request disappearance');
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 1);
  assert.deepEqual(ui.errors, []);
});

test('a late success receipt locks its original request without changing the newly selected task', async t => {
  const delivery = deferred();
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [approvalRequest] });
    if (call.path === `/api/threads/${B}/control`) return response({ threadId: B, available: true, canStop: false, pendingRequestCount: 0, pendingRequests: [] });
    if (call.path === `/api/threads/${A}/respond`) return delivery.promise;
  });
  await until(() => ui.doc.querySelector('.pending-card'), 'Alpha approval card');
  ui.doc.querySelector('.pending-accept').click();
  await until(() => ui.requests.some(call => call.path === `/api/threads/${A}/respond`), 'Alpha response dispatch');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.querySelector('#threadTitle').textContent === 'Beta', 'Beta selected');
  delivery.resolve(response({ threadId: A, requestId: 'approval-1', delivered: true }));
  await until(() => [...Array(ui.window.sessionStorage.length)].some((_, index) => {
    const key = ui.window.sessionStorage.key(index);
    return key.startsWith('codex-mobile-control-response:') && key.includes(A) && ui.window.sessionStorage.getItem(key) === 'delivered';
  }), 'late receipt persisted against Alpha');
  assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Beta');
  assert.equal(ui.doc.querySelector('.pending-card'), null);
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  await until(() => ui.doc.querySelector('.pending-card'), 'Alpha approval restored');
  assert.equal(ui.doc.querySelector('.pending-accept').disabled, true);
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 1);
  assert.deepEqual(ui.errors, []);
});

test('file approval exposes every change and unsupported interactions have no reply controls', async t => {
  const fileRequest = {
    requestId: 'file-approval-1', token: 'file-token', kind: 'fileApproval', title: 'Review file changes', actionable: true, disabledReason: null,
    reason: 'Apply the requested patch', cwd: 'E:/work/project', files: [{ path: 'src/new-name.js', movePath: 'src/old-name.js', type: 'update', diff: '--- a/src/old-name.js\n+++ b/src/new-name.js\n+const enabled = true;' }]
  };
  const unsupported = { requestId: 'unsupported-1', token: 'unsupported-token', kind: 'unsupported', title: 'Additional permission', actionable: false, disabledReason: 'This permission type cannot be answered from the phone.' };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 2, pendingRequests: [fileRequest, unsupported] });
    if (call.path === `/api/threads/${A}/respond`) return response({ threadId: A, requestId: 'file-approval-1', delivered: true });
  });
  await until(() => ui.doc.querySelectorAll('.pending-card').length === 2, 'file and unsupported cards');
  const cards = ui.doc.querySelectorAll('.pending-card');
  assert.ok(cards[0].textContent.includes('src/new-name.js'));
  assert.ok(cards[0].textContent.includes('src/old-name.js'));
  assert.ok(cards[0].textContent.includes('E:/work/project'));
  assert.ok(cards[0].textContent.includes('Apply the requested patch'));
  assert.ok(cards[0].textContent.includes('+const enabled = true;'));
  cards[0].querySelector('.pending-decline').click();
  await until(() => cards[0].textContent.includes('回复已送达桌面'), 'file decline delivery');
  assert.deepEqual(JSON.parse(ui.requests.find(call => call.path === `/api/threads/${A}/respond`).body), { requestId: 'file-approval-1', token: 'file-token', decision: 'decline' });
  assert.ok(cards[1].textContent.includes('This permission type cannot be answered from the phone.'));
  assert.equal(cards[1].querySelector('.pending-accept'), null);
  assert.equal(cards[1].querySelector('.pending-decline'), null);
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 1);
});

test('available false preserves pending cards and prevents stale submission until a fresh snapshot arrives', async t => {
  let reads = 0;
  const userInput = {
    requestId: 'input-unavailable', token: 'input-unavailable-token', kind: 'userInput', turnId: 'turn-1', title: 'Answer', actionable: true, disabledReason: null,
    questions: [{ id: 'q1', header: 'Answer', question: 'What should Codex do?', options: [], isOther: false, isSecret: false }]
  };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) {
      reads += 1;
      if (reads === 2) return response({ threadId: A, available: false, reason: 'Owner unavailable', pendingRequestCount: 0 });
      return response({ threadId: A, available: true, canStop: false, pendingRequestCount: reads === 1 ? 1 : 0, pendingRequests: reads === 1 ? [userInput] : [] });
    }
  });
  await until(() => ui.doc.querySelector('.pending-card'), 'pending card');
  const card = ui.doc.querySelector('.pending-card');
  const answer = card.querySelector('textarea'); answer.value = 'Keep me'; answer.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  ui.doc.querySelector('#refreshControl').click();
  await until(() => ui.doc.querySelector('#controlSummary').textContent === 'Owner unavailable', 'unavailable snapshot');
  assert.equal(card.isConnected, true);
  assert.equal(answer.value, 'Keep me');
  assert.equal(card.querySelector('.pending-submit').disabled, true);
  card.querySelector('.pending-submit').click();
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 0);
  ui.doc.querySelector('#refreshControl').click();
  await until(() => !ui.doc.querySelector('.pending-card'), 'fresh snapshot removes expired request');
  assert.deepEqual(ui.errors, []);
});

test('a definitive pre-dispatch rejection releases the persisted lock after status refresh', async t => {
  const fileRequest = { requestId: 'file-retry', token: 'file-retry-token', kind: 'fileApproval', actionable: true, title: 'Apply patch', reason: null, cwd: 'E:/work/project', files: [{ path: 'src/a.js', type: 'update', diff: '+change' }] };
  let posts = 0;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [fileRequest] });
    if (call.path === `/api/threads/${A}/respond`) {
      posts += 1;
      return posts === 1 ? response({ code: 'INVALID_REQUEST', error: 'bad input' }, 400) : response({ threadId: A, requestId: 'file-retry', delivered: true });
    }
  });
  await until(() => ui.doc.querySelector('.pending-card'), 'file approval');
  const card = ui.doc.querySelector('.pending-card');
  card.querySelector('.pending-accept').click();
  await until(() => card.textContent.includes('bad input'), 'known pre-dispatch rejection');
  assert.equal(card.querySelector('.pending-accept').disabled, false);
  card.querySelector('.pending-accept').click();
  await until(() => card.textContent.includes('回复已送达桌面'), 'second explicit attempt');
  assert.equal(posts, 2);
});

test('user input preserves question controls across polls and sends options, freeform, and secret answers', async t => {
  let controlReads = 0;
  const nextControl = deferred();
  const questionsRequest = {
    requestId: 'input-1', token: 'input-token', kind: 'asyncUserInput', turnId: 'turn-1', title: 'Clarify the task', actionable: true, disabledReason: null,
    questions: [
      { id: 'choice', header: 'Output', question: 'Which format?', options: [{ label: 'JSON', description: 'Machine readable' }, { label: 'Other', description: 'Specify another format' }], isOther: true, isSecret: false },
      { id: 'summary', header: 'Summary', question: 'Add a short note', options: [], isOther: false, isSecret: false }
    ]
  };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) {
      controlReads += 1;
      if (controlReads === 2) return nextControl.promise;
      return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [questionsRequest] });
    }
    if (call.path === `/api/threads/${A}/respond`) return response({ threadId: A, requestId: 'input-1', delivered: true });
  });
  await until(() => ui.doc.querySelector('.pending-question-form'), 'user input form');
  const card = ui.doc.querySelector('.pending-card');
  assert.ok(card.textContent.includes('Machine readable'));
  const radios = card.querySelectorAll('input[type="radio"]');
  radios[2].click();
  const otherText = card.querySelector('textarea.pending-answer');
  assert.equal(otherText.disabled, false);
  otherText.value = 'YAML'; otherText.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  const shortNote = card.querySelectorAll('textarea.pending-answer')[1];
  shortNote.value = 'Keep this note'; shortNote.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  assert.equal([...Array(ui.window.sessionStorage.length)].some((_, index) => ui.window.sessionStorage.getItem(ui.window.sessionStorage.key(index))?.includes('YAML')), true);
  otherText.focus(); otherText.setSelectionRange(1, 3);
  ui.doc.querySelector('#refreshControl').click();
  otherText.focus(); otherText.setSelectionRange(1, 3);
  nextControl.resolve(response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [questionsRequest] }));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(card.isConnected, true);
  assert.equal(ui.doc.activeElement, otherText);
  assert.equal(otherText.value, 'YAML');
  assert.equal(otherText.selectionStart, 1);
  card.querySelector('.pending-submit').click();
  await until(() => ui.requests.some(call => call.path === `/api/threads/${A}/respond`), 'question response');
  assert.deepEqual(JSON.parse(ui.requests.find(call => call.path === `/api/threads/${A}/respond`).body), {
    requestId: 'input-1', token: 'input-token', answers: { choice: { answers: ['YAML'] }, summary: { answers: ['Keep this note'] } }
  });
  await until(() => card.textContent.includes('回复已送达桌面'), 'question response settled');
  assert.deepEqual(ui.errors, []);
});

test('ambiguous response keeps the entered draft and submit lock when status refresh fails', async t => {
  const userInput = {
    requestId: 'input-unknown', token: 'input-unknown-token', kind: 'userInput', turnId: 'turn-1', title: 'Answer', actionable: true, disabledReason: null,
    questions: [{ id: 'q1', header: 'Answer', question: 'What should Codex do?', options: [], isOther: false, isSecret: false }]
  };
  let statusReads = 0;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) {
      statusReads += 1;
      if (statusReads > 1) return response({ code: 'OWNER_UNAVAILABLE', error: 'unavailable' }, 503);
      return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [userInput] });
    }
    if (call.path === `/api/threads/${A}/respond`) return response({ code: 'DELIVERY_UNKNOWN', error: 'outcome unknown' }, 502);
  });
  await until(() => ui.doc.querySelector('.pending-question-form'), 'question form');
  const card = ui.doc.querySelector('.pending-card');
  const answer = card.querySelector('textarea');
  answer.value = 'Keep this answer'; answer.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  card.querySelector('.pending-submit').click();
  await until(() => card.textContent.includes('不会自动重试'), 'uncertain response and failed status refresh');
  assert.equal(answer.value, 'Keep this answer');
  assert.equal(card.querySelector('.pending-submit').disabled, true);
  card.querySelector('.pending-submit').click();
  assert.equal(ui.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 1);
  const savedSession = Object.fromEntries([...Array(ui.window.sessionStorage.length)].map((_, index) => {
    const key = ui.window.sessionStorage.key(index);
    return [key, ui.window.sessionStorage.getItem(key)];
  }));
  const reloaded = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [userInput] });
  }, { session: savedSession });
  const recovered = reloaded.doc.querySelector('.pending-card');
  assert.ok(recovered);
  assert.equal(recovered.querySelector('textarea').value, 'Keep this answer');
  assert.equal(recovered.querySelector('.pending-submit').disabled, true);
  recovered.querySelector('.pending-submit').click();
  assert.equal(reloaded.requests.filter(call => call.path === `/api/threads/${A}/respond`).length, 0);
  assert.deepEqual(ui.errors, []);
});

test('secret question answers never enter browser storage', async t => {
  const secretRequest = {
    requestId: 'input-secret', token: 'secret-token', kind: 'userInput', turnId: 'turn-1', title: 'Secret answer', actionable: true, disabledReason: null,
    questions: [{ id: 'secret', header: 'Credential', question: 'Provide the token', options: [], isOther: false, isSecret: true }]
  };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, executionControl: true });
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, canStop: false, pendingRequestCount: 1, pendingRequests: [secretRequest] });
  });
  await until(() => ui.doc.querySelector('input[type="password"]'), 'secret input');
  const secret = ui.doc.querySelector('input[type="password"]');
  secret.value = 'do-not-store'; secret.dispatchEvent(new ui.window.Event('input', { bubbles: true }));
  const storage = [...Array(ui.window.sessionStorage.length)].map((_, index) => ui.window.sessionStorage.getItem(ui.window.sessionStorage.key(index))).join('\n');
  assert.ok(!storage.includes('do-not-store'));
});

test('actual UI restores cached content and rejects late reads from another task', async t => {
  let alphaReads = 0;
  const lateBeta = deferred(), freshAlpha = deferred();
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}` && ++alphaReads > 1) return freshAlpha.promise;
    if (call.path === `/api/threads/${B}`) return lateBeta.promise;
  });
  const input = ui.doc.querySelector('#promptInput');
  input.value = 'Alpha draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#transcript').scrollTop = 37;
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.requests.some(call => call.path === `/api/threads/${B}`), 'Beta fetch');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  assert.ok(ui.doc.querySelector('#transcript').textContent.includes('Alpha reply'));
  assert.equal(input.value, 'Alpha draft');
  assert.equal(ui.requests.find(call => call.path === `/api/threads/${B}`).signal.aborted, true);
  lateBeta.resolve(response(snapshot(B, 'Late Beta reply')));
  freshAlpha.resolve(response(snapshot(A, 'Fresh Alpha reply')));
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Fresh Alpha reply'), 'fresh selected content');
  assert.ok(!ui.doc.querySelector('#transcript').textContent.includes('Late Beta reply'));
  assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Alpha');
  assert.equal(ui.doc.querySelector('#transcript').scrollTop, 37, 'cached reading position survives fresh content');
  assert.deepEqual(ui.errors, []);
});

test('actual UI permits active follow-ups and reconciles one optimistic message with the desktop snapshot', async t => {
  let sent = false;
  const receipt = deferred();
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) { sent = true; return receipt.promise; }
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A, 'Alpha reply', 'active');
      if (sent) data.turns[0].items.push({ id: 'actual-input', type: 'userMessage', text: 'Follow up once' });
      return response(data);
    }
  });
  const input = ui.doc.querySelector('#promptInput');
  input.value = 'Follow up once'; input.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.doc.querySelector('#sendButton').disabled, false);
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => sent, 'POST dispatch');
  assert.ok(ui.doc.querySelector('#transcript').textContent.includes('Follow up once'));
  receipt.resolve(response({ accepted: true, threadId: A, requestId: 'request' }));
  await until(() => input.value === '' && ui.doc.querySelector('#transcript').querySelector('[data-turn-id]'), 'receipt and snapshot');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(ui.doc.querySelector('#transcript').textContent.split('Follow up once').length - 1, 1);
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(ui.errors, []);
});

test('actual sidebar controls save project order and disable reordering during search', async t => {
  const ui = await mount(t);
  ui.doc.querySelector('#sortToggle').click();
  const handle = ui.doc.querySelector('.project-order-row[data-order-key="project-one"] > .order-controls .order-handle');
  assert.ok(handle, 'project order keyboard handle');
  handle.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'PUT'), 'order PUT');
  await until(() => ui.savedOrder().revision > 0, 'order saved');
  await until(() => ui.doc.querySelector('#orderState').textContent.includes('已保存'), 'order save settled');
  assert.deepEqual(ui.savedOrder().order.projects.slice(0, 2), ['project-two', 'project-one']);
  await until(() => ui.doc.querySelector('.project-order-row')?.dataset.orderKey === 'project-two', 'visible project order');
  const search = ui.doc.querySelector('#taskSearch'); search.value = 'Alpha'; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.doc.querySelector('#sortToggle').disabled, true);
  assert.deepEqual(ui.errors, []);
});

test('automatic polling follows desktop project and conversation ranks through new chats without saving an order', async t => {
  let desktopRows = rows.map(row => ({ ...row }));
  const D = '00000000-0000-0000-0000-000000000005', E = '00000000-0000-0000-0000-000000000006';
  const ui = await mount(t, call => {
    if (call.path === '/api/threads') return response({ threads: desktopRows });
    if (call.path === `/api/threads/${A}`) return response({ ...snapshot(A), thread: desktopRows.find(row => row.id === A) });
  }, { automaticClock: true });
  const projectKeys = () => [...ui.doc.querySelectorAll('.project-order-row')].map(node => node.dataset.orderKey);
  const threadIds = key => [...ui.doc.querySelectorAll(`.task-row[data-order-key="${key}"]`)].map(node => node.dataset.orderId);
  await until(() => ui.clock.pending > 0, 'automatic poll scheduled');
  await new Promise(resolve => setTimeout(resolve, 15));
  await ui.clock.advance(30000);
  const initialFolder = ui.doc.querySelector('.project-folder');
  await ui.clock.advance(30000);
  assert.equal(ui.doc.querySelector('.project-folder'), initialFolder, 'unchanged desktop metadata retains sidebar nodes');

  const input = ui.doc.querySelector('#promptInput'); input.value = 'Unsent Alpha draft'; input.dispatchEvent(new ui.window.Event('input'));
  const one = ui.doc.querySelector('.project-folder[data-project-key="project-one"]');
  one.open = false; one.dispatchEvent(new ui.window.Event('toggle'));
  desktopRows = [...desktopRows, { id: D, title: 'Delta', projectKey: 'project-one', projectName: 'One', projectOrder: 0, projectThreadOrder: 2, status: 'idle' }];
  await ui.clock.advance(60000);
  assert.deepEqual(threadIds('project-one'), [A, B, D], 'new native conversation appears automatically');
  desktopRows = desktopRows.map(row => ({ ...row, projectOrder: row.projectKey === 'project-two' ? 0 : 1, projectThreadOrder: row.id === A ? 1 : row.id === B ? 0 : row.projectThreadOrder }));
  await ui.clock.advance(60000);
  assert.deepEqual(projectKeys(), ['project-two', 'project-one']);
  assert.deepEqual(threadIds('project-one'), [B, A, D]);
  assert.equal(ui.doc.querySelector('.project-folder[data-project-key="project-one"]').open, false);

  desktopRows = [
    ...desktopRows.map(row => ({ ...row, projectOrder: row.projectKey === 'project-one' ? 0 : 2, projectThreadOrder: row.id === A ? 2 : row.id === D ? 0 : 1 })),
    { id: E, title: 'Epsilon', projectKey: 'project-three', projectName: 'Three', projectOrder: 1, projectThreadOrder: 0, status: 'idle' },
  ];
  await ui.clock.advance(60000);
  assert.deepEqual(projectKeys(), ['project-one', 'project-three', 'project-two']);
  assert.deepEqual(threadIds('project-one'), [D, B, A]);

  desktopRows = desktopRows.map(row => ({ ...row, pinned: row.id === B || row.id === D, pinnedIndex: row.id === D ? 0 : 1 }));
  await ui.clock.advance(60000);
  assert.deepEqual(threadIds('@pinned'), [D, B]);
  desktopRows = desktopRows.map(row => ({ ...row, pinnedIndex: row.id === B ? 0 : 1 }));
  await ui.clock.advance(60000);
  assert.deepEqual(threadIds('@pinned'), [B, D]);
  desktopRows = desktopRows.map(row => ({ ...row, pinned: row.id === D }));
  await ui.clock.advance(60000);
  assert.deepEqual(threadIds('@pinned'), [D]);
  assert.deepEqual(threadIds('project-one'), [B, A]);

  const search = ui.doc.querySelector('#taskSearch'); search.value = 'Alpha'; search.dispatchEvent(new ui.window.Event('input'));
  desktopRows = desktopRows.map(row => ({ ...row, projectOrder: row.projectKey === 'project-two' ? 0 : 1 }));
  await ui.clock.advance(60000);
  assert.equal(search.value, 'Alpha'); assert.deepEqual([...ui.doc.querySelectorAll('.task-item')].map(node => node.textContent), ['Alpha']);
  search.value = ''; search.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.doc.querySelector('.project-folder[data-project-key="project-one"]').open, false);
  assert.equal(input.value, 'Unsent Alpha draft'); assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Alpha');
  assert.equal(ui.window.location.search, `?thread=${A}`);
  assert.equal(ui.doc.querySelector('#resetOrder').disabled, true);
  assert.deepEqual(ui.savedOrder(), { revision: 0, order: { projects: [], threads: {} } });
  assert.equal(ui.requests.some(call => call.method === 'PUT' || call.method === 'POST'), false);
  assert.deepEqual(ui.errors, []);
});

test('automatic desktop updates preserve saved web ordering and append new items without another write', async t => {
  let desktopRows = rows.map(row => ({ ...row }));
  const D = '00000000-0000-0000-0000-000000000005', E = '00000000-0000-0000-0000-000000000006';
  const ui = await mount(t, call => {
    if (call.path === '/api/threads') return response({ threads: desktopRows });
    if (call.path === `/api/threads/${A}`) return response({ ...snapshot(A), thread: desktopRows.find(row => row.id === A) });
  }, { automaticClock: true });
  await until(() => ui.clock.pending > 0, 'automatic poll scheduled');
  ui.doc.querySelector('#sortToggle').click();
  ui.doc.querySelector('.project-order-row[data-order-key="project-one"] > .order-controls .order-handle')
    .dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await until(() => ui.doc.querySelector('#orderState').textContent.includes('已保存'), 'custom order saved');
  ui.doc.querySelector(`.task-row[data-order-id="${A}"] .order-handle`)
    .dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await until(() => ui.savedOrder().order.threads['project-one']?.[0] === B && ui.doc.querySelector('#orderState').textContent.includes('已保存'), 'custom conversation order saved');
  ui.doc.querySelector('#sortToggle').click();
  const writes = ui.requests.filter(call => call.method === 'PUT').length;
  const saved = JSON.parse(JSON.stringify(ui.savedOrder()));
  desktopRows = [
    ...desktopRows.map(row => ({ ...row, projectOrder: row.projectKey === 'project-one' ? 0 : 2, projectThreadOrder: row.id === A ? 0 : 2 })),
    { id: D, title: 'Delta', projectKey: 'project-one', projectName: 'One', projectOrder: 0, projectThreadOrder: 1, status: 'idle' },
    { id: E, title: 'Epsilon', projectKey: 'project-three', projectName: 'Three', projectOrder: 1, projectThreadOrder: 0, status: 'idle' },
  ];
  await ui.clock.advance(60000);
  assert.deepEqual([...ui.doc.querySelectorAll('.project-order-row')].map(node => node.dataset.orderKey), ['project-two', 'project-one', 'project-three']);
  assert.deepEqual([...ui.doc.querySelectorAll('.task-row[data-order-key="project-one"]')].map(node => node.dataset.orderId), [B, A, D]);
  assert.deepEqual(ui.savedOrder(), saved);
  assert.equal(ui.requests.filter(call => call.method === 'PUT').length, writes);
  assert.equal(ui.doc.querySelector('#orderState').textContent, '网页排序 · 已保存');
  ui.doc.querySelector('#resetOrder').click();
  await until(() => ui.savedOrder().order.projects.length === 0 && ui.doc.querySelector('#resetOrder').disabled, 'follow desktop reset saved');
  desktopRows = desktopRows.map(row => ({ ...row, projectOrder: row.projectKey === 'project-two' ? 0 : row.projectKey === 'project-three' ? 1 : 2, projectThreadOrder: row.id === A ? 2 : row.id === B ? 0 : 1 }));
  await ui.clock.advance(60000);
  assert.deepEqual([...ui.doc.querySelectorAll('.project-order-row')].map(node => node.dataset.orderKey), ['project-two', 'project-three', 'project-one']);
  assert.deepEqual([...ui.doc.querySelectorAll('.task-row[data-order-key="project-one"]')].map(node => node.dataset.orderId), [B, D, A]);
  assert.deepEqual(ui.savedOrder().order, { projects: [], threads: {} });
  assert.equal(ui.requests.filter(call => call.method === 'PUT').length, writes + 1, 'only the explicit reset writes again');
  assert.equal(ui.doc.querySelector('#orderState').hidden, true);
  assert.deepEqual(ui.errors, []);
});

for (const cancelled of [false, true]) test(cancelled ? 'cancelling a drag does not save a changed order' : 'actual pointer drag can move a conversation after the final row', async t => {
  const ui = await mount(t);
  ui.doc.querySelector('#sortToggle').click();
  const source = ui.doc.querySelector(`.task-row[data-order-id="${A}"] .order-handle`);
  const target = ui.doc.querySelector(`.task-row[data-order-id="${B}"]`);
  assert.ok(source && target);
  target.getBoundingClientRect = () => ({ top: 40, bottom: 80, height: 40, left: 0, right: 100, width: 100 });
  ui.doc.elementFromPoint = () => target;
  const pointer = (type, y) => {
    const event = new ui.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: y });
    Object.defineProperty(event, 'pointerId', { value: 1 }); return event;
  };
  source.dispatchEvent(pointer('pointerdown', 10));
  ui.doc.dispatchEvent(pointer('pointermove', 75));
  ui.doc.dispatchEvent(pointer(cancelled ? 'pointercancel' : 'pointerup', 75));
  if (cancelled) {
    assert.equal(ui.savedOrder().revision, 0);
    assert.equal(ui.requests.filter(call => call.method === 'PUT').length, 0);
    return;
  }
  await until(() => ui.savedOrder().revision > 0, 'pointer order saved');
  await until(() => ui.doc.querySelector('#orderState').textContent.includes('已保存'), 'pointer save settled');
  assert.deepEqual(ui.savedOrder().order.threads['project-one'], [B, A]);
  assert.deepEqual(ui.errors, []);
});

test('an old order refresh cannot overwrite a newly saved drag order', async t => {
  let orderReads = 0;
  const lateOrder = deferred();
  const ui = await mount(t, call => {
    if (call.path === '/api/sidebar-order' && call.method !== 'PUT' && ++orderReads > 1) return lateOrder.promise;
  });
  ui.doc.querySelector('#sortToggle').click();
  ui.doc.querySelector('#refreshTasks').click();
  await until(() => orderReads > 1, 'old order fetch pending');
  ui.doc.querySelector('.project-order-row[data-order-key="project-one"] > .order-controls .order-handle')
    .dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  await until(() => ui.doc.querySelector('#orderState').textContent.includes('已保存'), 'new order saved');
  lateOrder.resolve(response({ revision: 0, order: { projects: [], threads: {} } }));
  await new Promise(r => setTimeout(r, 15));
  assert.equal(ui.doc.querySelector('.project-order-row').dataset.orderKey, 'project-two');
  assert.deepEqual(ui.errors, []);
});

test('polling latest messages preserves the deepest history cursor', async t => {
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A); data.page = { hasMore: true, nextCursor: 'page-two' }; return response(data);
    }
    if (call.path === `/api/threads/${A}?cursor=page-two`) {
      const data = snapshot(A, 'Older reply'); data.turns[0].id = 'older'; data.turns[0].startedAt = 900;
      data.page = { hasMore: true, nextCursor: 'page-three' }; return response(data);
    }
    if (call.path === `/api/threads/${A}?cursor=page-three`) {
      const data = snapshot(A, 'Oldest reply'); data.turns[0].id = 'oldest'; data.turns[0].startedAt = 800; return response(data);
    }
  });
  ui.doc.querySelector('#olderButton').click();
  assert.equal(ui.doc.querySelector('#olderRow').hidden, false);
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Older reply'), 'older page loaded');
  await until(() => !ui.doc.querySelector('#olderButton').disabled, 'older page settled');
  const reads = () => ui.requests.filter(call => call.path === `/api/threads/${A}`).length;
  const before = reads();
  ui.doc.querySelector('#refreshButton').click();
  await until(() => reads() > before, 'latest refresh');
  await new Promise(r => setTimeout(r, 15));
  ui.doc.querySelector('#olderButton').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Oldest reply'), 'next distinct older page');
  assert.equal(ui.requests.filter(call => call.path.includes('cursor=page-two')).length, 1);
  assert.deepEqual(ui.errors, []);
});

test('older history failure retains the cursor and exposes a manual retry inside the transcript', async t => {
  let attempts = 0;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A); data.page = { hasMore: true, nextCursor: 'older' }; return response(data);
    }
    if (call.path === `/api/threads/${A}?cursor=older`) {
      if (++attempts === 1) return response({ error: 'temporary failure' }, 503);
      const data = snapshot(A, 'Recovered older reply'); data.turns[0].id = 'older'; return response(data);
    }
  });
  assert.equal(ui.doc.querySelector('#olderRow').parentElement.id, 'transcript');
  ui.doc.querySelector('#olderButton').click();
  await until(() => ui.doc.querySelector('#olderButton').textContent.includes('重试'), 'manual retry visible');
  assert.match(ui.doc.querySelector('#transcript').textContent, /Alpha reply/);
  assert.equal(attempts, 1);
  ui.doc.querySelector('#olderButton').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Recovered older reply'), 'retry recovered');
  assert.equal(attempts, 2);
  assert.equal(ui.doc.querySelector('#olderButton').hidden, true);
  assert.equal(ui.doc.querySelector('#historyState').textContent, '已到最早消息');
});

test('polling does not reopen already exhausted history', async t => {
  let reads = 0;
  const ui = await mount(t, call => {
    if (call.path !== `/api/threads/${A}`) return;
    const data = snapshot(A);
    if (++reads > 1) data.page = { hasMore: true, nextCursor: 'already-loaded' };
    return response(data);
  });
  ui.doc.querySelector('#refreshButton').click();
  await until(() => reads > 1, 'refresh received');
  await new Promise(r => setTimeout(r, 15));
  assert.equal(ui.doc.querySelector('#olderButton').hidden, true);
  assert.deepEqual(ui.errors, []);
});

test('a long offline gap keeps its catch-up cursor reachable after automatic loading stops', async t => {
  let latestReads = 0;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A);
      data.page = { hasMore: true, nextCursor: 'old-history' };
      if (++latestReads > 1) {
        data.turns[0].id = 'newest'; data.turns[0].items[0].text = 'New reply';
        data.page.nextCursor = 'gap-1';
      }
      return response(data);
    }
    const gap = call.path.match(/cursor=gap-(\d+)/);
    if (gap) {
      const index = Number(gap[1]);
      const data = snapshot(A, `Gap reply ${index}`);
      data.turns[0].id = `gap-${index}`;
      data.page = { hasMore: true, nextCursor: `gap-${index + 1}` }; return response(data);
    }
  });
  ui.doc.querySelector('#refreshButton').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Gap reply 3'), 'bounded automatic catch-up');
  ui.doc.querySelector('#olderButton').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Gap reply 4'), 'manual gap continuation');
  assert.equal(ui.requests.some(call => call.path.includes('cursor=old-history')), false);
  assert.deepEqual(ui.errors, []);
});

test('a send receipt after switching tasks preserves the selected task draft', async t => {
  const receipt = deferred();
  let sent = false;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) { sent = true; return receipt.promise; }
  });
  const input = ui.doc.querySelector('#promptInput');
  input.value = 'Alpha outgoing'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => sent, 'send dispatched');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Beta reply'), 'selected Beta');
  input.value = 'Beta unsent draft'; input.dispatchEvent(new ui.window.Event('input'));
  receipt.resolve(response({ accepted: true, threadId: A, requestId: 'request' }));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(input.value, 'Beta unsent draft');
  assert.ok(!ui.doc.querySelector('#transcript').textContent.includes('Alpha outgoing'));
  assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Beta');
  assert.deepEqual(ui.errors, []);
});

test('send acceptance does not erase a new draft typed while the request was pending', async t => {
  const receipt = deferred();
  let sent = false;
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${A}/messages`) { sent = true; return receipt.promise; }
  });
  const input = ui.doc.querySelector('#promptInput');
  input.value = 'First outgoing'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => sent, 'send dispatched');
  input.value = 'New unsent draft'; input.dispatchEvent(new ui.window.Event('input'));
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Beta reply'), 'Beta selected');
  receipt.resolve(response({ accepted: true, threadId: A, requestId: 'request' }));
  await new Promise(r => setTimeout(r, 15));
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Alpha').click();
  assert.equal(input.value, 'New unsent draft');
  await until(() => ui.doc.querySelector('#threadLoadState').hidden, 'Alpha refresh settled');
  assert.deepEqual(ui.errors, []);
});

const savedProjects = [{ projectId: 'project-one', label: 'One', path: 'E:/work/one', isGitRepository: true, hostId: 'local' }];
const createCapableStatus = { connected: true, canSend: true, canCreate: true, sendScope: 'all-local', allowedSendThreadId: null, callerThreadId: A, defaultThreadId: A };
const projectsReply = () => response({ canCreate: true, projects: savedProjects });
const draftKey = 'codex-mobile-new-thread-draft';
const pendingKey = 'codex-mobile-new-thread-pending';
const receiptKey = 'codex-mobile-new-thread-receipt';

test('new conversation requires both capabilities and an explicit project or no-project choice', async t => {
  const ui = await mount(t, call => call.path === '/api/status' ? response({ ...createCapableStatus, sendScope: 'single' }) : undefined);
  assert.equal(ui.doc.querySelector('#newThreadButton').disabled, true);
  assert.equal(ui.requests.some(call => call.path === '/api/projects'), false);
});

test('new conversation creates with the first message exactly once and preserves a changed draft', async t => {
  const receipt = { created: true, threadId: '00000000-0000-0000-0000-000000000020', hostId: 'local', projectId: 'project-one', createdAt: '2026-09-26T00:00:00Z' };
  let submitted;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects') return projectsReply();
    if (call.path === '/api/threads' && call.method === 'POST') { submitted = JSON.parse(call.body); return response({ ...receipt, requestId: submitted.requestId }); }
    if (call.path === `/api/threads/${receipt.threadId}`) return response(snapshot(receipt.threadId, 'New conversation reply'));
  });
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#newThreadProject').options.length === 3, 'saved project list');
  assert.equal(ui.doc.querySelector('#newThreadDialog').open, true);
  ui.doc.querySelector('#newThreadProject').value = 'project-one';
  ui.doc.querySelector('#newThreadProject').dispatchEvent(new ui.window.Event('change'));
  const prompt = ui.doc.querySelector('#newThreadPrompt');
  prompt.value = 'Build the requested feature'; prompt.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#newThreadForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => submitted, 'create request');
  prompt.value = 'Keep this later draft'; prompt.dispatchEvent(new ui.window.Event('input'));
  await until(() => ui.doc.querySelector('#creationResult').hidden === false, 'created receipt banner');
  assert.deepEqual({ ...submitted, requestId: R }, { requestId: R, projectId: 'project-one', prompt: 'Build the requested feature' });
  assert.equal(ui.doc.querySelector('#newThreadPrompt').value, 'Keep this later draft');
  assert.equal(ui.doc.querySelector('#newThreadDialog').open, true);
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  assert.equal(ui.requests.some(call => call.path.endsWith('/messages')), false);
  assert.equal(ui.window.sessionStorage.getItem(draftKey) !== null, true);
  assert.deepEqual(ui.errors, []);
});

test('a restored creation attempt checks its receipt without automatically posting again', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === `/api/thread-creations/${R}`) return response({ state: 'unknown' });
  }, { session: { [pendingKey]: JSON.stringify({ requestId: R, payload: { projectId: null, prompt: 'Do this once' }, draftRevision: 4, state: 'unknown' }) } });
  await until(() => ui.requests.some(call => call.path === `/api/thread-creations/${R}`), 'startup receipt check');
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(ui.doc.querySelector('#newThreadButton').disabled, false);
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#checkCreateReceipt').hidden === false, 'recovery controls');
  assert.equal(ui.doc.querySelector('#createSubmit').hidden, true);
  assert.equal(ui.doc.querySelector('#createRetry').hidden, true);
  assert.deepEqual(ui.errors, []);
});

test('manual retry after not_found reuses the saved request id and payload', async t => {
  const saved = { requestId: R, payload: { projectId: null, prompt: 'Same request' }, draftRevision: 2, state: 'unknown' };
  let submitted;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects') return projectsReply();
    if (call.path === `/api/thread-creations/${R}`) return response({ state: 'not_found' });
    if (call.path === '/api/threads' && call.method === 'POST') { submitted = JSON.parse(call.body); return response({ created: true, requestId: submitted.requestId, threadId: '00000000-0000-0000-0000-000000000021', hostId: 'local', projectId: null }); }
  }, { session: { [pendingKey]: JSON.stringify(saved) } });
  await until(() => ui.requests.some(call => call.path === `/api/thread-creations/${R}`), 'not found recovery state');
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#createRetry').hidden === false, 'manual retry action');
  assert.match(ui.doc.querySelector('#createRecoveryState').textContent, /请先核对会话列表/);
  assert.doesNotMatch(ui.doc.querySelector('#createRecoveryState').textContent, /不会创建第二个/);
  ui.doc.querySelector('#createRetry').click();
  await until(() => submitted, 'manual retry dispatched');
  assert.deepEqual({ ...submitted, requestId: R }, { requestId: R, projectId: null, prompt: 'Same request' });
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 1);
  await until(() => ui.requests.filter(call => call.path === '/api/threads').length > 1, 'post-create task refresh');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(ui.errors, []);
});

test('late creation receipt after switching tasks keeps the new selection and offers exact entry', async t => {
  const createResult = deferred();
  const createdId = '00000000-0000-0000-0000-000000000022';
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects') return projectsReply();
    if (call.path === '/api/threads' && call.method === 'POST') {
      const body = JSON.parse(call.body);
      return createResult.promise.then(() => response({ created: true, requestId: body.requestId, threadId: createdId, hostId: 'local', projectId: null }));
    }
    if (call.path === `/api/threads/${createdId}`) return response(snapshot(createdId, 'Created reply'));
  });
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#newThreadProject').options.length === 3, 'saved project list');
  ui.doc.querySelector('#newThreadProject').value = '__none__'; ui.doc.querySelector('#newThreadProject').dispatchEvent(new ui.window.Event('change'));
  const prompt = ui.doc.querySelector('#newThreadPrompt'); prompt.value = 'Create it'; prompt.dispatchEvent(new ui.window.Event('input'));
  ui.doc.querySelector('#newThreadForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => ui.requests.some(call => call.method === 'POST'), 'creation pending');
  [...ui.doc.querySelectorAll('.task-item')].find(row => row.textContent === 'Beta').click();
  await until(() => ui.doc.querySelector('#threadTitle').textContent === 'Beta', 'switch to Beta');
  prompt.value = 'Preserve this edited draft'; prompt.dispatchEvent(new ui.window.Event('input'));
  createResult.resolve(response({ created: true, requestId: R, threadId: createdId, hostId: 'local', projectId: null }));
  await until(() => ui.doc.querySelector('#creationResult').hidden === false, 'late receipt banner');
  assert.equal(ui.doc.querySelector('#threadTitle').textContent, 'Beta');
  assert.equal(prompt.value, 'Preserve this edited draft');
  assert.equal(ui.doc.querySelector('#enterCreatedThread').hidden, false);
  ui.doc.querySelector('#enterCreatedThread').click();
  await until(() => ui.requests.some(call => call.path === `/api/threads/${createdId}`), 'created thread read');
  await until(() => ui.doc.querySelector('#transcript').textContent.includes('Created reply'), 'enter created receipt thread');
  assert.deepEqual(ui.errors, []);
});

test('project-list failure keeps the draft and exposes a manual retry', async t => {
  let projectReads = 0;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects' && projectReads++ === 0) return response({ code: 'TEMPORARY', error: 'Unavailable' }, 503);
    if (call.path === '/api/projects') return projectsReply();
  }, { session: { [draftKey]: JSON.stringify({ projectChoice: '__none__', title: 'Saved title', prompt: 'Saved prompt', revision: 7 }) } });
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#projectLoadState').hidden === false, 'project load failure');
  assert.equal(ui.doc.querySelector('#newThreadName').value, 'Saved title');
  assert.equal(ui.doc.querySelector('#newThreadPrompt').value, 'Saved prompt');
  assert.equal(ui.requests.filter(call => call.path === '/api/projects').length, 1);
  ui.doc.querySelector('#retryProjects').click();
  await until(() => ui.doc.querySelector('#newThreadProject').options.length === 3, 'project retry');
  assert.equal(ui.doc.querySelector('#newThreadName').value, 'Saved title');
  assert.equal(ui.doc.querySelector('#newThreadPrompt').value, 'Saved prompt');
  assert.deepEqual(ui.errors, []);
});

test('only a unique case and slash normalized exact cwd path selects a default project', async t => {
  const mounted = async projects => mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects') return response({ canCreate: true, projects });
    if (call.path === '/api/threads') return response({ threads: rows.map(row => row.id === A ? { ...row, cwd: 'E:\\WORK\\one\\' } : row) });
    if (call.path === `/api/threads/${A}`) {
      const data = snapshot(A); data.thread.cwd = 'E:\\WORK\\one\\'; return response(data);
    }
  }, { session: { [draftKey]: JSON.stringify({ projectChoice: '', title: '', prompt: '', revision: 0 }) } });
  const matching = await mounted(savedProjects);
  matching.doc.querySelector('#newThreadButton').click();
  await until(() => matching.doc.querySelector('#newThreadProject').options.length === 3, 'unique path project');
  assert.equal(matching.doc.querySelector('#newThreadProject').value, 'project-one');

  const duplicatePath = [...savedProjects, { ...savedProjects[0], projectId: 'another-project', label: 'Also One' }];
  const ambiguous = await mounted(duplicatePath);
  ambiguous.doc.querySelector('#newThreadButton').click();
  await until(() => ambiguous.doc.querySelector('#newThreadProject').options.length === 4, 'ambiguous path projects');
  assert.equal(ambiguous.doc.querySelector('#newThreadProject').value, '');
  assert.deepEqual(matching.errors, []);
  assert.deepEqual(ambiguous.errors, []);
});

test('status capability recovery reloads a previously denied project list', async t => {
  let statusReads = 0, projectReads = 0;
  const ui = await mount(t, call => {
    if (call.path === '/api/status') {
      statusReads++;
      return response(statusReads === 2 ? { ...createCapableStatus, canCreate: false } : createCapableStatus);
    }
    if (call.path === '/api/projects') {
      projectReads++;
      return response(projectReads === 1 ? { canCreate: false, projects: [] } : { canCreate: true, projects: savedProjects });
    }
  });
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#newThreadButton').disabled && projectReads === 1, 'project capability denied');
  while (statusReads < 3) {
    ui.doc.querySelector('#refreshButton').click();
    await new Promise(r => setTimeout(r, 20));
  }
  await until(() => projectReads >= 2 && !ui.doc.querySelector('#newThreadButton').disabled, 'capability recovery project reload');
  assert.equal(ui.doc.querySelector('#newThreadProject').options.length, 3);
  assert.deepEqual(ui.errors, []);
});

test('pending marker storage failure prevents creation dispatch', async t => {
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response(createCapableStatus);
    if (call.path === '/api/projects') return projectsReply();
  });
  ui.doc.querySelector('#newThreadButton').click();
  await until(() => ui.doc.querySelector('#newThreadProject').options.length === 3, 'saved project list');
  ui.doc.querySelector('#newThreadProject').value = '__none__'; ui.doc.querySelector('#newThreadProject').dispatchEvent(new ui.window.Event('change'));
  const prompt = ui.doc.querySelector('#newThreadPrompt'); prompt.value = 'Must not dispatch'; prompt.dispatchEvent(new ui.window.Event('input'));
  const original = ui.window.Storage.prototype.setItem;
  ui.window.Storage.prototype.setItem = function (key, value) {
    if (key === pendingKey) throw new ui.window.DOMException('Storage full', 'QuotaExceededError');
    return original.call(this, key, value);
  };
  ui.doc.querySelector('#newThreadForm').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ui.requests.filter(call => call.method === 'POST').length, 0);
  assert.equal(prompt.value, 'Must not dispatch');
  assert.match(ui.doc.querySelector('#createError').textContent, /尚未创建/);
});

const CHILD = '00000000-0000-0000-0000-000000000005';
const childContext = () => ({ threadId: A, available: true, permissions: { current: 'request-approval', supported: true }, git: { available: false, reason: '不属于 Git 仓库' }, agents: { available: true, items: [{ threadId: CHILD, name: '检查子任务', status: 'running', canRead: true }] }, sources: { available: true, items: [] } });
const childSnapshot = (message = 'Child reply', older = false) => ({ thread: { id: CHILD, title: '', delegated: true, status: 'running' }, canSend: false, canManage: false, turns: [{ id: older ? 'child-old' : 'child-live', startedAt: older ? 500 : 1000, status: 'completed', items: [{ id: older ? 'child-old-reply' : 'child-reply', type: 'agentMessage', text: message }] }], page: { hasMore: !older, nextCursor: older ? null : 'child-older' } });

test('viewing and refreshing a child preserves main URL, selection, draft, scroll, sidebar and live question state', async t => {
  let childReads = 0;
  const request = { requestId: 'main-question', token: 'main-token', kind: 'asyncUserInput', turnId: 'main-turn', title: '等待回答', actionable: true, questions: [{ id: 'q', header: '确认', question: '选择一个资源', options: [], isOther: false, isSecret: false }] };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, callerThreadId: A, executionControl: true, permissionOptions: { send: [{ id: 'request-approval' }], create: [] } });
    if (call.path === `/api/threads/${A}/context`) return response(childContext());
    if (call.path === `/api/threads/${A}/control`) return response({ threadId: A, available: true, pendingRequestCount: 1, pendingRequests: [request], historicalQuestions: [] });
    if (call.path === `/api/threads/${CHILD}`) return response(childSnapshot(`Child reply ${++childReads}`));
    if (call.path === `/api/threads/${CHILD}?cursor=child-older`) return response(childSnapshot('Older child reply', true));
  });
  await until(() => ui.doc.querySelector('#pendingRequests').textContent.includes('选择一个资源'), 'main question loaded');
  const input = ui.doc.getElementById('promptInput'); input.value = 'keep main draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('contextToggle').click();
  await until(() => ui.doc.querySelector('[data-context-key="agent:' + CHILD + '"]'), 'child link');
  ui.doc.getElementById('transcript').scrollTop = 73;
  const before = { url: ui.window.location.href, selected: ui.window.localStorage.getItem('codex-mobile-selected-thread'), draft: input.value, scroll: ui.doc.getElementById('transcript').scrollTop, sidebar: ui.doc.getElementById('taskList').innerHTML, pending: ui.doc.getElementById('pendingRequests').innerHTML, main: ui.doc.getElementById('transcript').innerHTML };
  ui.doc.querySelector('[data-context-key="agent:' + CHILD + '"]').click();
  await until(() => ui.doc.getElementById('agentViewerTranscript').textContent.includes('Child reply 1'), 'child viewer loaded');
  assert.equal(ui.doc.querySelectorAll('#agentViewer form, #agentViewer textarea, #agentViewer input, #agentViewer select:not([data-language-selector])').length, 0);
  ui.doc.getElementById('agentViewerOlder').click();
  await until(() => ui.doc.getElementById('agentViewerTranscript').textContent.includes('Older child reply'), 'child older page');
  ui.doc.getElementById('agentViewerRefresh').click();
  await until(() => ui.doc.getElementById('agentViewerTranscript').textContent.includes('Child reply 2'), 'active child refreshed');
  assert.equal(ui.window.location.href, before.url); assert.equal(ui.window.localStorage.getItem('codex-mobile-selected-thread'), before.selected);
  assert.equal(input.value, before.draft); assert.equal(ui.doc.getElementById('transcript').scrollTop, before.scroll);
  assert.equal(ui.doc.getElementById('taskList').innerHTML, before.sidebar); assert.equal(ui.doc.getElementById('pendingRequests').innerHTML, before.pending);
  assert.equal(ui.doc.getElementById('transcript').innerHTML, before.main);
  assert.equal(ui.requests.some(call => call.method && call.method !== 'GET'), false);
  assert.ok(ui.requests.filter(call => call.path.includes(CHILD)).every(call => /^\/api\/threads\/[^/]+(?:\?cursor=.+)?$/.test(call.path)));
  ui.doc.getElementById('agentViewerClose').click(); assert.equal(ui.doc.getElementById('agentViewer').open, false);
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha'); assert.deepEqual(ui.errors, []);
});

test('only confirmed child IDs leave the ordinary sidebar; a legitimate unnamed root remains', async t => {
  const list = [...rows.map(row => row.id === B ? { ...row, title: '未命名对话' } : row), { id: CHILD, title: '未命名对话', status: 'idle' }];
  const ui = await mount(t, call => {
    if (call.path === '/api/threads') return response({ threads: list });
    if (call.path === `/api/threads/${A}/context`) return response(childContext());
    if (call.path === `/api/threads/${CHILD}`) return response(childSnapshot());
  }, { expectedRows: 4 });
  assert.ok(ui.doc.querySelector('.task-row[data-order-id="' + B + '"]'));
  assert.ok(ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"]'));
  ui.doc.getElementById('contextToggle').click();
  await until(() => !ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"]'), 'confirmed child cache removed');
  assert.equal(ui.doc.querySelector('.task-row[data-order-id="' + B + '"] .task-title').textContent, '未命名对话');
  assert.equal(ui.doc.querySelectorAll('.task-item').length, 3);
  assert.deepEqual(JSON.parse(ui.window.sessionStorage.getItem('codex-mobile-subagent-threads')), [CHILD]);
  ui.doc.getElementById('refreshTasks').click();
  await until(() => ui.requests.filter(call => call.path === '/api/threads').length >= 2, 'sidebar refresh');
  assert.equal(ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"]'), null);
  assert.ok(ui.doc.querySelector('.task-row[data-order-id="' + B + '"]'));
  assert.equal(ui.requests.some(call => call.method && call.method !== 'GET'), false);
});

test('an old child-selected URL is classified before replacing the main conversation and opens only the viewer', async t => {
  const ui = await mount(t, call => {
    if (call.path === `/api/threads/${CHILD}`) return response(childSnapshot());
  }, { urlThread: CHILD });
  await until(() => ui.doc.getElementById('agentViewerTranscript').textContent.includes('Child reply'), 'old child URL viewer');
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha');
  assert.equal(new URL(ui.window.location.href).searchParams.get('thread'), A);
  assert.equal(ui.window.localStorage.getItem('codex-mobile-selected-thread'), A);
  assert.equal(ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"]'), null);
  assert.equal(ui.requests.some(call => call.method && call.method !== 'GET'), false);
  assert.deepEqual(ui.errors, []);
});

test('a stale listed child is classified before replacing a non-default parent conversation', async t => {
  const request = { requestId: 'parent-question', token: 'parent-token', kind: 'asyncUserInput', turnId: 'parent-turn', title: '等待回答', actionable: true, questions: [{ id: 'q', header: '确认', question: '保留当前问题', options: [], isOther: false, isSecret: false }] };
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', defaultThreadId: A, callerThreadId: A, executionControl: true });
    if (call.path === '/api/threads') return response({ threads: [...rows, { id: CHILD, title: '未命名对话', status: 'idle' }] });
    if (call.path === `/api/threads/${CHILD}`) return response(childSnapshot());
    const control = call.path.match(/^\/api\/threads\/([^/]+)\/control$/);
    if (control) return response({ threadId: control[1], available: true, pendingRequestCount: control[1] === B ? 1 : 0, pendingRequests: control[1] === B ? [request] : [], historicalQuestions: [] });
  }, { expectedRows: 4 });
  ui.doc.querySelector('.task-row[data-order-id="' + B + '"] .task-item').click();
  await until(() => ui.doc.getElementById('threadTitle').textContent === 'Beta' && ui.doc.getElementById('pendingRequests').textContent.includes('保留当前问题'), 'non-default parent loaded');
  const input = ui.doc.getElementById('promptInput'); input.value = 'Beta draft'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('transcript').scrollTop = 82;
  const before = { url: ui.window.location.href, transcript: ui.doc.getElementById('transcript').innerHTML, pending: ui.doc.getElementById('pendingRequests').innerHTML };
  ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"] .task-item').click();
  await until(() => ui.doc.getElementById('agentViewerTranscript').textContent.includes('Child reply'), 'stale listed child viewer');
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Beta'); assert.equal(ui.window.location.href, before.url);
  assert.equal(ui.window.localStorage.getItem('codex-mobile-selected-thread'), B); assert.equal(input.value, 'Beta draft');
  assert.equal(ui.doc.getElementById('transcript').scrollTop, 82); assert.equal(ui.doc.getElementById('transcript').innerHTML, before.transcript);
  assert.equal(ui.doc.getElementById('pendingRequests').innerHTML, before.pending);
  assert.equal(ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"]'), null);
  assert.equal(ui.requests.some(call => call.method && call.method !== 'GET'), false);
});

test('reselecting the current parent cancels a pending child classification and ignores its late response', async t => {
  const late = deferred();
  const ui = await mount(t, call => {
    if (call.path === '/api/threads') return response({ threads: [...rows, { id: CHILD, title: '未命名对话', status: 'idle' }] });
    if (call.path === `/api/threads/${CHILD}`) return late.promise;
  }, { expectedRows: 4 });
  ui.doc.querySelector('.task-row[data-order-id="' + CHILD + '"] .task-item').click();
  await until(() => ui.requests.some(call => call.path.includes(CHILD)), 'classification started');
  ui.doc.querySelector('.task-row[data-order-id="' + A + '"] .task-item').click();
  assert.equal(ui.requests.find(call => call.path.includes(CHILD)).signal.aborted, true);
  late.resolve(response(childSnapshot('late child'))); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.doc.getElementById('agentViewer').open, false); assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha');
  assert.equal(new URL(ui.window.location.href).searchParams.get('thread'), A);
  assert.equal(ui.doc.getElementById('promptInput').value, ''); assert.deepEqual(ui.errors, []);
});

test('pending candidate classification blocks composer dispatch while the current draft stays editable', async t => {
  const late = deferred();
  const ui = await mount(t, call => call.path === `/api/threads/${B}` ? late.promise : undefined);
  const input = ui.doc.getElementById('promptInput'); input.value = 'keep editable draft'; input.dispatchEvent(new ui.window.Event('input'));
  assert.equal(ui.doc.getElementById('sendButton').disabled, false);
  ui.doc.querySelector('.task-row[data-order-id="' + B + '"] .task-item').click();
  await until(() => ui.requests.some(call => call.path === `/api/threads/${B}`), 'candidate read pending');
  assert.equal(ui.doc.getElementById('sendButton').disabled, true); assert.equal(input.disabled, false);
  input.value = 'edited during read'; input.dispatchEvent(new ui.window.Event('input'));
  ui.doc.getElementById('composer').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true }));
  assert.equal(ui.requests.some(call => call.method === 'POST'), false); assert.equal(input.value, 'edited during read');
  ui.doc.querySelector('.task-row[data-order-id="' + A + '"] .task-item').click();
  await until(() => !ui.doc.getElementById('sendButton').disabled, 'current parent send eligibility restored');
  late.resolve(response(snapshot(B))); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha'); assert.equal(input.value, 'edited during read');
  assert.equal(ui.requests.some(call => call.method === 'POST'), false); assert.deepEqual(ui.errors, []);
});


test('switching web language immediately retains drafts, conversation, scroll, settings and open dialogs', async t => {
  const options = [{ id: 'gpt-6-luna', efforts: ['low', 'high'] }];
  const ui = await mount(t, call => {
    if (call.path === '/api/status') return response({ connected: true, canSend: true, sendScope: 'all-local', callerThreadId: A, defaultThreadId: A, modelOptions: { send: options, create: options } });
  }, { language: 'en-US' });
  const change = (id, value) => { const node = ui.doc.getElementById(id); node.value = value; node.dispatchEvent(new ui.window.Event('change', { bubbles: true })); };
  assert.equal(ui.doc.documentElement.lang, 'en');
  assert.equal(ui.doc.getElementById('promptInput').placeholder, 'Send a message…');
  const prompt = ui.doc.getElementById('promptInput'); prompt.value = '用户草稿：已完成'; prompt.dispatchEvent(new ui.window.Event('input'));
  const transcript = ui.doc.getElementById('transcript'), original = transcript.querySelector('.turn'); transcript.scrollTop = 123;
  ui.doc.getElementById('modelSettingsButton').click(); change('messageModel', 'gpt-6-luna'); change('messageThinking', 'high');
  const beforeRequests = ui.requests.length, beforeStorage = ui.window.sessionStorage.getItem(`codex-mobile-draft:${A}`);
  for (const language of ['zh-CN', 'en', 'zh-CN']) {
    change('languageSelect', language);
    assert.equal(ui.doc.getElementById('modelSettingsDialog').open, true);
    assert.equal(prompt.value, '用户草稿：已完成');
    assert.equal(ui.doc.getElementById('messageModel').value, 'gpt-6-luna');
    assert.equal(ui.doc.getElementById('messageThinking').value, 'high');
    assert.equal(transcript.querySelector('.turn'), original); assert.equal(transcript.scrollTop, 123);
    assert.equal(ui.doc.getElementById('threadTitle').textContent, 'Alpha');
    assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-draft:${A}`), beforeStorage);
    assert.equal(ui.requests.length, beforeRequests, 'language switches must not make business requests');
  }
  assert.equal(ui.doc.getElementById('modelSettingsTitle').textContent, '下一轮设置');
  assert.equal(ui.window.localStorage.getItem('codex-mobile-language'), 'zh-CN');
  assert.deepEqual(ui.errors, []);
});
