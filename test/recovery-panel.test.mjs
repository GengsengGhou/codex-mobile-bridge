import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createRecoveryPanel } from '../public/recovery.js';

const state = (extra = {}) => ({ supported: true, autoStart: false, autoRestart: true, supervisorRunning: true, state: 'running', restartCount: 0, lastRestartAt: null, lastError: null, ...extra });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(api) {
  const dom = new JSDOM('<html><head></head><body><div class="drawer-foot"></div></body></html>');
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  const doc = dom.window.document;
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const controller = createRecoveryPanel({ document: doc, api });
  return { doc, controller, open: () => doc.getElementById('recoveryButton').click(), start: doc.getElementById('recovery-autoStart'), restart: doc.getElementById('recovery-autoRestart') };
}
test('opening is read only; toggles send a single explicit setting', async () => {
  const calls = [];
  const ui = setup(async (path, options) => { calls.push({ path, options }); return state(options ? { autoStart: true } : {}); });
  ui.open(); await tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].options, undefined);
  ui.start.click(); await tick();
  assert.deepEqual(calls[1], { path: '/api/recovery', options: { method: 'PUT', body: '{"autoStart":true}' } });
  assert.equal(ui.start.checked, true);
});
test('unsupported platform keeps switches read only', async () => {
  let calls = 0;
  const ui = setup(async () => { calls++; return state({ supported: false }); });
  ui.open(); await tick(); ui.start.click(); await tick();
  assert.equal(calls, 1); assert.equal(ui.start.disabled, true); assert.equal(ui.restart.disabled, true);
  assert.match(ui.doc.body.textContent, /当前平台只可查看状态/);
});
test('lost PUT response reconciles via GET and never repeats mutation', async () => {
  let resolveRead;
  const calls = [];
  const ui = setup(async (_path, options) => {
    calls.push(options?.method || 'GET');
    if (options) throw new Error('lost response');
    if (calls.length === 1) return state();
    return await new Promise(resolve => { resolveRead = resolve; });
  });
  ui.open(); await tick(); ui.start.click(); await tick();
  assert.equal(ui.start.disabled, true); assert.equal(ui.start.indeterminate, true);
  ui.controller.close(); ui.open(); ui.start.click(); await tick();
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
  resolveRead(state({ autoStart: true })); await tick();
  assert.equal(ui.start.checked, true); assert.equal(ui.start.disabled, false);
});
test('failed reconciliation shows unknown state until intentional refresh', async () => {
  let calls = 0;
  const ui = setup(async () => { calls++; if (calls === 1 || calls === 4) return state(); throw new Error('offline'); });
  ui.open(); await tick(); ui.start.click(); await tick();
  assert.equal(calls, 3); assert.equal(ui.start.disabled, true); assert.equal(ui.start.indeterminate, true);
  assert.match(ui.doc.querySelector('.recovery-status').textContent, /尚未确认/);
  assert.doesNotMatch(ui.doc.querySelector('.recovery-status').textContent, /运行中/);
  ui.doc.querySelector('.recovery-panel > button').click(); await tick();
  assert.equal(calls, 4); assert.equal(ui.start.disabled, false);
});
test('definite OS rejection remains visible after status confirms unchanged setting', async () => {
  const calls = [];
  const ui = setup(async (_path, options) => {
    calls.push(options?.method || 'GET');
    if (options) throw new Error('Windows 启动注册项属于其他程序，无法修改');
    return state();
  });
  ui.open(); await tick(); ui.start.click(); await tick();
  assert.deepEqual(calls, ['GET', 'PUT', 'GET']);
  assert.equal(ui.start.checked, false); assert.equal(ui.start.disabled, false);
  assert.match(ui.doc.querySelector('[role="status"]').textContent, /设置未生效：Windows 启动注册项属于其他程序，无法修改/);
  assert.match(ui.doc.body.textContent, /电脑保持唤醒/);
  assert.match(ui.doc.body.textContent, /Codex 桌面端正在运行/);
});
test('a stale read after close cannot overwrite the reopened status', async () => {
  let resolveOld, calls = 0;
  const ui = setup(async () => { calls++; if (calls === 1) return await new Promise(resolve => { resolveOld = resolve; }); return state({ autoStart: false, lastError: '<script>bad</script>' }); });
  ui.open(); ui.controller.close(); ui.open();
  assert.equal(ui.start.disabled, true);
  resolveOld(state({ autoStart: true })); await tick(); await tick();
  assert.equal(calls, 2); assert.equal(ui.start.checked, false);
  assert.equal(ui.doc.querySelector('script'), null); assert.match(ui.doc.body.textContent, /<script>bad<\/script>/);
});
test('cancel during a read discards its result and reopen requests fresh state', async () => {
  let resolveOld, calls = 0;
  const ui = setup(async () => { calls++; if (calls === 1) return await new Promise(resolve => { resolveOld = resolve; }); return state(); });
  ui.open();
  const panel = ui.doc.getElementById('recoveryPanel'); panel.dispatchEvent(new ui.doc.defaultView.Event('cancel')); panel.close();
  resolveOld(state({ autoStart: true })); await tick();
  ui.open(); await tick(); assert.equal(calls, 2); assert.equal(ui.start.checked, false);
});
