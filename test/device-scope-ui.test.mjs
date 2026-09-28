import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApi, createDeviceContext, loadDeviceContext, deviceIdFromPath } from "../public/connection.js";
import { createUploads } from "../public/uploads.js";
const A = "00000000-0000-0000-0000-000000000001", B = "00000000-0000-0000-0000-000000000002", THREAD = "00000000-0000-0000-0000-000000000003";
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
function scope(window, id, user = "account-a", fetchImpl = async () => json({}), online = true) { return createDeviceContext({ pathname: `/devices/${id}/`, context: { user: { id: user }, device: { id, name: id, online } }, window, fetchImpl }); }
test("same thread drafts, selected thread, creation receipts and recovery metadata isolate by device and account", () => {
  const { window } = new JSDOM("", { url: "https://hub.test" });
  const a = scope(window, A), b = scope(window, B), otherAccount = scope(window, A, "account-b");
  const keys = [`codex-mobile-draft:${THREAD}`, `codex-mobile-permission:${THREAD}`, `codex-mobile-control-open:${THREAD}`, `codex-mobile-control-seen:${THREAD}`, `codex-mobile-history-dismissed:${THREAD}`, "codex-mobile-new-thread-receipt", "codex-mobile-selected-thread", `codex-mobile-uploads:${THREAD}`, "codex-mobile-open-projects"];
  for (const key of keys) { a.sessionStorage.setItem(key, "a-private"); b.sessionStorage.setItem(key, "b-private"); assert.equal(a.sessionStorage.getItem(key), "a-private"); assert.equal(otherAccount.sessionStorage.getItem(key), null); }
  a.localStorage.setItem(keys[2], THREAD); assert.equal(b.localStorage.getItem(keys[2]), null);
  assert.equal(a.sessionStorage.length, keys.length); assert.ok(a.sessionStorage.key(0).startsWith("codex-mobile-"));
  a.sessionStorage.removeItem(keys[0]); assert.equal(b.sessionStorage.getItem(keys[0]), "b-private"); window.close();
});
test("context is authenticated before storage access and invalid device path fails closed", async () => {
  const { window } = new JSDOM("", { url: `https://hub.test/devices/${A}/` });
  Object.defineProperty(window, "sessionStorage", { get: () => { throw new Error("storage must not read before auth"); } });
  await assert.rejects(loadDeviceContext({ window, fetchImpl: async () => json({}, 401) }), { status: 401 });
  assert.throws(() => deviceIdFromPath("/devices/invalid/"));
  assert.throws(() => createDeviceContext({ pathname: `/devices/${A}/`, context: { user: { id: "a" }, device: { id: B } }, window })); window.close();
});

test('busy relay responses keep device online and real 304 roundtrips restore explicit offline state', async () => {
  const { window } = new JSDOM('', { url: 'https://hub.test' });
  let statusReads = 0, mutations = 0;
  const device = scope(window, A, 'account-a', async (path, options) => {
    if (options.method === 'POST') { mutations += 1; return json({ accepted: true }); }
    if (path.endsWith('/api/status')) {
      if (++statusReads === 1) return new Response('{"connected":true}', { headers: { ETag: '"online"' } });
      return new Response(null, { status: 304 });
    }
    return json({ code: path.endsWith('/api/offline') ? 'DEVICE_OFFLINE' : 'HUB_BUSY' }, 503);
  });
  const api = createApi({ fetchImpl: device.fetch, onSnapshot: device.acceptSnapshot });
  await api('/api/status');
  await assert.rejects(api('/api/threads'), { status: 503 });
  assert.equal(device.context.device.online, true);
  await assert.rejects(api('/api/offline'), { code: 'DEVICE_OFFLINE' });
  assert.equal(device.context.device.online, false);
  assert.equal((await api('/api/status')).connected, true);
  assert.equal(device.context.device.online, true);
  await api('/api/action', { method: 'POST', body: '{}' });
  assert.equal(mutations, 1); window.close();
});

test('cached snapshot callbacks and late 304s cannot override a newer device-offline response', async () => {
  const { window } = new JSDOM('', { url: 'https://hub.test' });
  let release, reads = 0;
  const device = scope(window, A, 'account-a', async path => {
    if (path.endsWith('/api/status')) {
      if (++reads === 1) return new Response('{"connected":true}', { headers: { ETag: '"online"' } });
      return new Promise(resolve => { release = () => resolve(new Response(null, { status: 304 })); });
    }
    return json({ code: 'DEVICE_OFFLINE' }, 503);
  });
  const api = createApi({ fetchImpl: device.fetch, onSnapshot: device.acceptSnapshot });
  await api('/api/status');
  const late = api('/api/status');
  await assert.rejects(api('/api/offline'), { code: 'DEVICE_OFFLINE' });
  release(); await late;
  assert.equal(device.context.device.online, false);
  device.acceptSnapshot('/api/status', { connected: true });
  assert.equal(device.context.device.online, false);
  window.close();
});

test('late offline responses cannot override newer successful relay reads or desktop disconnection', async () => {
  const { window } = new JSDOM('', { url: 'https://hub.test' });
  let release;
  const device = scope(window, A, 'account-a', path => path.endsWith('/api/offline')
    ? new Promise(resolve => { release = () => resolve(json({ code: 'DEVICE_OFFLINE' }, 503)); })
    : Promise.resolve(json({ connected: false })), false);
  const late = device.fetch('/api/offline');
  await device.fetch('/api/status');
  release(); await late;
  assert.equal(device.context.device.online, true);
  device.acceptSnapshot('/api/status', { connected: false });
  assert.equal(device.context.device.online, true);
  window.close();
});

test('busy, unsupported and timeout errors have readable messages without mutating connection state', async () => {
  const { window } = new JSDOM('', { url: 'https://hub.test' });
  for (const [code, status] of [['DEVICE_BUSY', 503], ['BRIDGE_BUSY', 503], ['BRIDGE_ROUTE_UNSUPPORTED', 502], ['RELAY_TIMEOUT', 504]]) {
    const device = scope(window, A, 'account-a', async () => json({ code, error: code }, status));
    const api = createApi({ fetchImpl: device.fetch, onSnapshot: device.acceptSnapshot });
    await assert.rejects(api('/api/threads'), error => error.code === code && /[\u4e00-\u9fff]/.test(error.message));
    assert.equal(device.context.device.online, true);
  }
  window.close();
});
test("scoped requests stay on immutable device and expired/offline sessions cannot mutate", async () => {
  const { window } = new JSDOM("", { url: "https://hub.test" }); const calls = []; let signals = 0;
  window.addEventListener("bridge-login-required", () => signals++);
  const a = scope(window, A, "a", async (path, options) => { calls.push([path, options]); return json({ code: "LOGIN_REQUIRED" }, 401); });
  await a.fetch("/api/threads"); assert.equal(calls[0][0], `/devices/${A}/api/threads`); assert.equal(signals, 1);
  await assert.rejects(a.fetch("/api/action", { method: "POST" }), { code: "LOGIN_REQUIRED" }); assert.equal(calls.length, 1);
  const offline = scope(window, B, "b", async () => { throw new Error("should not send"); }, false);
  // A fresh page has its own login lifecycle.
  await assert.rejects(offline.fetch("/api/action", { method: "POST" }), { code: "DEVICE_OFFLINE" });
  await assert.rejects(a.fetch("/api/../../api/hub/me")); window.close();
});
test("late upload receipt remains in original device queue and storage", async () => {
  const dom = new JSDOM('<input id="attachmentPicker"><button id="attachButton"></button><ul id="attachmentList"></ul><div id="attachmentError"></div>', { url: "https://hub.test" });
  Object.defineProperty(dom.window, "crypto", { value: webcrypto }); let finish;
  const a = scope(dom.window, A, "account", (path, options) => new Promise(resolve => { finish = () => { const url = new URL(path, "https://hub.test"), uploadId = url.pathname.split("/").at(-1); resolve(json({ uploaded: true, uploadId, threadId: THREAD, name: "note.txt", size: 2, sha256: url.searchParams.get("sha256"), path: `mobile-uploads/${uploadId}/note.txt`, absolutePath: `E:/work/mobile-uploads/${uploadId}/note.txt` })); }; }));
  const b = scope(dom.window, B);
  const uploads = createUploads({ document: dom.window.document, window: dom.window, storage: a.sessionStorage, fetchImpl: a.fetch, getThread: () => ({ id: THREAD, cwd: "E:/work" }) });
  uploads.setThread(THREAD); await uploads.add([{ name: "note.txt", size: 2, arrayBuffer: async () => new Uint8Array([1, 2]).buffer }]); finish();
  for (let count = 0; count < 30 && uploads.getItems(THREAD)[0]?.state !== "ready"; count++) await tick();
  assert.equal(uploads.getItems(THREAD)[0].state, "ready"); assert.equal(b.sessionStorage.getItem(`codex-mobile-uploads:${THREAD}`), null); assert.ok(a.sessionStorage.getItem(`codex-mobile-uploads:${THREAD}`)); dom.window.close();
});

test("actual mobile app restores only selected device drafts and scopes files and recovery requests", async t => {
  const shared = new JSDOM("", { url: "https://hub.test" }); t.after(() => shared.window.close());
  scope(shared.window, A).sessionStorage.setItem(`codex-mobile-draft:${THREAD}`, "device A draft");
  scope(shared.window, B).sessionStorage.setItem(`codex-mobile-draft:${THREAD}`, "device B draft");
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  for (const id of [A, B]) {
    const dom = new JSDOM(html, { url: `https://hub.test/devices/${id}/`, runScripts: "outside-only", pretendToBeVisual: true }); t.after(() => dom.window.close());
    const { window } = dom, calls = [], intervals = [];
    for (const key of ["localStorage", "sessionStorage"]) Object.defineProperty(window, key, { value: shared.window[key] });
    window.matchMedia = () => ({ matches: false }); window.setInterval = callback => { intervals.push(callback); return intervals.length; };
    window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; window.HTMLDialogElement.prototype.show = function () { this.open = true; }; window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    const device = { id, name: id === A ? "Device A" : "Device B", online: true };
    window.fetch = async (path, options = {}) => {
      calls.push(path); assert.ok(path.startsWith(`/devices/${id}/`), path);
      const route = path.slice(`/devices/${id}`.length);
      if (route === "/context" || route === "/api/access") return json({ user: { id: "account-a" }, device, mode: "hub" });
      if (route === "/api/status") return json({ connected: true, canSend: true, sendScope: "all-local", defaultThreadId: THREAD });
      if (route === "/api/threads") return json({ threads: [{ id: THREAD, title: "Same thread", status: "idle" }] });
      if (route === `/api/threads/${THREAD}`) return json({ thread: { id: THREAD, title: "Same thread", cwd: "E:/work", status: "idle" }, canSend: true, turns: [], page: { hasMore: false } });
      if (route === "/api/sidebar-order") return json({ revision: 0, order: { projects: [], threads: {} } });
      if (route.includes("/files?")) return json({ path: "", parentPath: null, entries: [] });
      return json({ error: "Unavailable", code: "UNSUPPORTED" }, 404);
    };
    let source = await readFile(new URL("../public/app.js", import.meta.url), "utf8"); window.__modules = {};
    for (const match of source.matchAll(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm)) {
      const module = { ...await import(new URL("../public/" + match[2].slice(2), import.meta.url)) };
      if (module.appendMarkdown) { const append = module.appendMarkdown; module.appendMarkdown = (parent, value) => append(parent, value, window.document); }
      window.__modules[match[2]] = module;
    }
    source = source.replace(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm, (_, names, path) => `const {${names.replace(/\s+as\s+/g, ":")}} = globalThis.__modules[${JSON.stringify(path)}];`); window.eval(source);
    for (let count = 0; count < 80 && !window.document.getElementById("promptInput").value; count++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(window.document.getElementById("promptInput").value, id === A ? "device A draft" : "device B draft");
    assert.ok(window.document.querySelector(".brand-block").textContent.includes(device.name));
    window.document.getElementById("filesButton").click(); window.document.getElementById("recoveryButton").click(); await tick();
    assert.ok(calls.some(path => path.includes("/files?"))); assert.ok(calls.some(path => path.endsWith("/api/recovery")));
    assert.equal(window.document.querySelector('link[href="./access.css"]').href, `https://hub.test/devices/${id}/access.css`);
  }
});

test('actual device page synchronizes offline controls and recovers from bodyless status roundtrips', async t => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: `https://hub.test/devices/${A}/?thread=${THREAD}`, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom, doc = window.document, requests = [];
  window.matchMedia = () => ({ matches: false });
  window.setInterval = () => 1;
  window.HTMLElement.prototype.scrollTo = function ({ top }) { this.scrollTop = top; };
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.show = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  let contextOffline = true, statusReads = 0, desktopConnected = true, statusGate = null;
  const status = () => ({ connected: desktopConnected, canSend: true, sendScope: 'all-local', defaultThreadId: THREAD, executionControl: true, error: desktopConnected ? null : { code: 'DESKTOP_UNAVAILABLE', message: 'Unavailable' } });
  window.fetch = async (path, options = {}) => {
    requests.push({ path, ...options });
    const route = path.slice(`/devices/${A}`.length);
    if (route === '/context' || route === '/api/access') return json({ user: { id: 'account-a' }, device: { id: A, name: 'Fixture PC', online: true }, mode: 'hub' });
    if (route === '/api/status') {
      statusReads += 1;
      if (statusGate) await statusGate;
      if (desktopConnected && options.headers?.['If-None-Match']) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(status()), { headers: { ETag: desktopConnected ? '"online"' : '"desktop-offline"' } });
    }
    if (route === '/api/threads') return json({ threads: [{ id: THREAD, title: 'Fixture task', status: 'idle' }] });
    if (route === `/api/threads/${THREAD}`) return json({ thread: { id: THREAD, title: 'Fixture task', status: 'idle' }, canSend: true, turns: [], page: { hasMore: false } });
    if (route === `/api/threads/${THREAD}/context`) return contextOffline ? json({ code: 'DEVICE_OFFLINE', error: 'DEVICE_OFFLINE' }, 503) : json({ threadId: THREAD, available: false });
    if (route === `/api/threads/${THREAD}/control`) return json({ threadId: THREAD, available: true, canStop: false, pendingRequests: [] });
    if (route === '/api/sidebar-order') return json({ revision: 0, order: { projects: [], threads: {} } });
    return json({ code: 'NOT_FOUND' }, 404);
  };
  let source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8'); window.__modules = {};
  for (const match of source.matchAll(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm)) {
    const module = { ...await import(new URL('../public/' + match[2].slice(2), import.meta.url)) };
    if (module.appendMarkdown) { const append = module.appendMarkdown; module.appendMarkdown = (parent, value) => append(parent, value, window.document); }
    window.__modules[match[2]] = module;
  }
  source = source.replace(/^import \{([^}]+)\} from "(\.\/[^"\n]+)";$/gm, (_, names, path) => `const {${names.replace(/\s+as\s+/g, ':')}} = globalThis.__modules[${JSON.stringify(path)}];`); window.eval(source);
  const until = async predicate => { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Device page state timeout'); };
  await until(() => doc.getElementById('threadTitle').textContent === 'Fixture task');
  const input = doc.getElementById('promptInput'); input.value = 'Unsent draft'; input.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('sendButton').disabled, false);
  let releaseStatus;
  statusGate = new Promise(resolve => { releaseStatus = resolve; });
  const priorStatusReads = statusReads;
  doc.getElementById('refreshButton').click();
  await until(() => statusReads > priorStatusReads);
  doc.getElementById('contextToggle').click();
  await until(() => doc.getElementById('connectionText').textContent === '设备离线');
  assert.equal(doc.getElementById('connection').dataset.state, 'disconnected');
  assert.equal(doc.getElementById('sendButton').disabled, true);
  assert.equal(input.value, 'Unsent draft');
  statusGate = null; releaseStatus();
  await tick(); await tick();
  assert.equal(doc.getElementById('connectionText').textContent, '设备离线');
  assert.equal(doc.getElementById('sendButton').disabled, true);
  contextOffline = false;
  doc.getElementById('refreshButton').click();
  await until(() => doc.getElementById('connectionText').textContent === '电脑已连接');
  assert.ok(statusReads >= 2);
  assert.equal(doc.getElementById('sendButton').disabled, false);
  desktopConnected = false;
  doc.getElementById('refreshButton').click();
  await until(() => doc.getElementById('connectionText').textContent === '等待 Codex');
  assert.equal(doc.getElementById('sendButton').disabled, true);
  doc.getElementById('retryThreadButton').click();
  await tick(); await tick();
  assert.equal(doc.getElementById('connectionText').textContent, '等待 Codex');
  assert.equal(requests.some(request => request.method && request.method !== 'GET'), false);
});
