import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const base = new URL('../deploy/windows/ui/', import.meta.url);
const html = await readFile(new URL('index.html', base), 'utf8');
const scripts = await Promise.all(['desktop-locale.js', 'connector.js'].map(async name => readFile(new URL(name, base), 'utf8')));
const tick = () => new Promise(resolve => setImmediate(resolve));
const initial = { paired: true, controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [],
  devices: [{ id: 'device-self', name: 'Fixture PC', online: true }, { id: 'device-b', name: 'Office PC', online: true }, { id: 'device-c', name: 'Home PC', online: false }],
  projects: [{ id: 'project-a', cwd: 'C:/work/a', name: 'Project A' }, { id: 'project-b', cwd: 'C:/work/b', name: 'Project B' }],
  featureAvailable: true, registration: { status: 'ready' } };

function mount(t, language = 'zh-CN') {
  const dom = new JSDOM(html, { url: 'https://connector.invalid/ui/index.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const calls = []; let receive;
  dom.window.chrome = { webview: { postMessage: command => calls.push(command), addEventListener: (name, handler) => { receive = handler; } } };
  for (const source of scripts) dom.window.eval(source);
  t.after(() => dom.window.close());
  const $ = id => dom.window.document.getElementById(id);
  const send = data => receive({ data });
  const answer = (request, result, ok = true) => send({ type: 'result', id: request.id, ok, ...(ok ? { result } : { error: result }) });
  answer(calls[0], { language, deviceName: 'Fixture PC', root: 'C:/fixture', version: '2.0.0', webviewVersion: '154' });
  send({ type: 'status', status: { paired: true, deviceId: 'device-self', deviceName: 'Fixture PC', hubConnected: true, bridgeConnected: true, autoStart: false } });
  return { $, calls, answer, window: dom.window };
}

test('collaboration settings load on open, preserve dirty selection, validate receive scope, save exact fields, and refresh', async t => {
  const ui = mount(t); await tick();
  ui.$('settingsButton').click();
  let read = ui.calls.at(-1);
  assert.equal(read.action, 'get-collaboration-state');
  assert.deepEqual(JSON.parse(JSON.stringify(read.payload)), {});
  ui.answer(read, { collaboration: initial }); await tick();
  assert.equal(ui.$('controlEnabled').checked, false);
  assert.equal(ui.$('receiveEnabled').checked, false);
  const deviceBoxes = ui.$('collaborationDevices').querySelectorAll('input');
  const projectBoxes = ui.$('collaborationProjects').querySelectorAll('input');
  assert.equal(deviceBoxes.length, 2); assert.equal(deviceBoxes[0].value, 'device-b'); assert.equal(projectBoxes.length, 2);
  deviceBoxes[0].checked = true; deviceBoxes[0].dispatchEvent(new ui.window.Event('change'));
  ui.$('receiveEnabled').checked = true; ui.$('receiveEnabled').dispatchEvent(new ui.window.Event('change'));
  const savedDeviceSelection = ui.$('collaborationDevices').querySelectorAll('input')[0].checked;
  ui.$('backSettings').click(); ui.$('settingsButton').click();
  read = ui.calls.at(-1); assert.equal(read.action, 'get-collaboration-state');
  ui.answer(read, { collaboration: { ...initial, allowedDeviceIds: ['device-c'], receiveEnabled: false } }); await tick();
  assert.equal(ui.$('collaborationDevices').querySelectorAll('input')[0].checked, savedDeviceSelection);
  assert.equal(ui.$('receiveEnabled').checked, true);

  ui.$('saveCollaboration').click();
  assert.match(ui.$('collaborationMessage').textContent, /至少选择一台电脑和一个本机项目/);
  assert.equal(ui.calls.filter(call => call.action === 'save-collaboration').length, 0);

  ui.$('collaborationProjects').querySelectorAll('input')[1].checked = true;
  ui.$('collaborationProjects').querySelectorAll('input')[1].dispatchEvent(new ui.window.Event('change'));
  ui.$('saveCollaboration').click();
  const save = ui.calls.at(-1);
  assert.equal(save.action, 'save-collaboration');
  assert.deepEqual(JSON.parse(JSON.stringify(save.payload)), {
    controlEnabled: false, receiveEnabled: true,
    allowedDeviceIds: ['device-b'], allowedProjectRoots: ['C:/work/b']
  });
  const refreshed = { ...initial, receiveEnabled: true, allowedDeviceIds: ['device-b'], allowedProjectRoots: ['C:/work/b'] };
  ui.answer(save, { collaboration: refreshed }); await tick();
  assert.equal(ui.calls.at(-1).action, 'get-collaboration-state');
  ui.answer(ui.calls.at(-1), { collaboration: refreshed }); await tick();
  assert.equal(ui.$('collaborationMessage').textContent, '电脑协作设置已保存。');
});

test('collaboration settings are bilingual and unavailable/recovery state stays visible', async t => {
  const ui = mount(t, 'en'); await tick(); ui.$('settingsButton').click();
  ui.answer(ui.calls.at(-1), { collaboration: { ...initial, paired: true, featureAvailable: false, registration: { status: 'recovering', message: 'Recovering' } } }); await tick();
  assert.equal(ui.$('collaborationSummary').textContent, 'Paired. Collaboration registration is recovering; refresh shortly.');
  assert.equal(ui.$('controlEnabled').disabled, true);
  assert.equal(ui.$('saveCollaboration').disabled, true);
  assert.equal([...ui.$('settingsView').querySelectorAll('h2')].some(heading => heading.textContent === 'Computer collaboration'), true);
});

test('offline collaboration state allows independent revocation, stale allowlists, and reverting drafts', async t => {
  const ui = mount(t, 'en'); await tick(); ui.$('settingsButton').click();
  const existing = { ...initial, controlEnabled: true, receiveEnabled: true, allowedDeviceIds: ['00000000-0000-4000-8000-000000000001'], allowedProjectRoots: ['C:/old-project'], devices: [], projects: [], featureAvailable: false, error: '服务器尚未支持电脑协作，请由管理员更新服务器后重试。', registration: { status: 'disabled' } };
  ui.answer(ui.calls.at(-1), { collaboration: existing }); await tick();
  assert.equal(ui.$('collaborationSummary').textContent, 'This server does not support computer collaboration yet. Ask an administrator to update it and try again.');
  ui.$('controlEnabled').checked = false; ui.$('controlEnabled').dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.$('saveCollaboration').disabled, false);
  ui.$('saveCollaboration').click();
  const save = ui.calls.at(-1);
  assert.equal(save.action, 'save-collaboration');
  assert.equal(save.payload.controlEnabled, false); assert.equal(save.payload.receiveEnabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(save.payload.allowedDeviceIds)), existing.allowedDeviceIds);
  assert.deepEqual(JSON.parse(JSON.stringify(save.payload.allowedProjectRoots)), existing.allowedProjectRoots);
  const saved = { ...existing, controlEnabled: false };
  ui.answer(save, { collaboration: saved }); await tick();
  const refresh = ui.calls.at(-1); assert.equal(refresh.action, 'get-collaboration-state');
  ui.answer(refresh, { collaboration: saved }); await tick();
  ui.$('receiveEnabled').checked = false; ui.$('receiveEnabled').dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.$('receiveEnabled').disabled, false);
  ui.$('receiveEnabled').checked = true; ui.$('receiveEnabled').dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.$('saveCollaboration').disabled, true);
});

test('registration errors leave settings retryable after the local conflict is resolved', async t => {
  const ui = mount(t); await tick(); ui.$('settingsButton').click();
  const conflicted = { ...initial, featureAvailable: true, registration: { status: 'error', message: '电脑协作配置与现有 Codex 配置冲突。请保留现有配置，在 Codex 设置中检查同名连接后重试。' } };
  ui.answer(ui.calls.at(-1), { collaboration: conflicted }); await tick();
  assert.equal(ui.$('controlEnabled').disabled, false);
  ui.$('controlEnabled').checked = true; ui.$('controlEnabled').dispatchEvent(new ui.window.Event('change'));
  assert.equal(ui.$('saveCollaboration').disabled, false);
  ui.$('saveCollaboration').click();
  const save = ui.calls.at(-1);
  assert.equal(save.action, 'save-collaboration'); assert.equal(save.payload.controlEnabled, true);
});
