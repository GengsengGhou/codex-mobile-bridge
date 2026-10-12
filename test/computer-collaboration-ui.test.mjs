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
  return { $, calls, answer, send, window: dom.window };
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

test('a changed pairing clears dirty grants and shows bilingual reauthorization steps', async t => {
  const ui = mount(t, 'en'); await tick(); ui.$('settingsButton').click();
  ui.answer(ui.calls.at(-1), { collaboration: { ...initial, hubOrigin:'https://old.example',deviceId:'old-self' } }); await tick();
  for (const id of ['controlEnabled','receiveEnabled']) { ui.$(id).checked=true; ui.$(id).dispatchEvent(new ui.window.Event('change')); }
  for (const container of ['collaborationDevices','collaborationProjects']) { const box=ui.$(container).querySelector('input');box.checked=true;box.dispatchEvent(new ui.window.Event('change')); }
  ui.$('backSettings').click(); ui.$('settingsButton').click();
  ui.answer(ui.calls.at(-1), { collaboration: { ...initial, hubOrigin:'https://new.example',deviceId:'new-self',requiresAuthorization:true,registration:{status:'authorization-required',message:'配对已改变，旧电脑协作授权已失效。请刷新电脑协作设置，重新选择电脑和项目并保存；目标电脑也需授权新的设备身份。'} } }); await tick();
  assert.equal(ui.$('controlEnabled').checked,false); assert.equal(ui.$('receiveEnabled').checked,false);
  assert.ok([...ui.$('collaborationDevices').querySelectorAll('input'),...ui.$('collaborationProjects').querySelectorAll('input')].every(box=>!box.checked));
  assert.match(ui.$('collaborationSummary').textContent,/Pairing changed.*choose computers and projects again/);
  assert.equal(ui.calls.filter(call=>call.action==='save-collaboration').length,0);
});

test('project reload and save errors retain dirty choices and replace an old ready summary', async t => {
  const ui=mount(t,'en');await tick();ui.$('settingsButton').click();
  const ready={...initial,hubOrigin:'https://fixture.invalid',deviceId:'device-self',projectsAvailable:true,devicesAvailable:true,registration:{status:'registered',message:'电脑协作已就绪。请在 Codex 中重新加载连接。'}};
  ui.answer(ui.calls.at(-1),{collaboration:ready});await tick();
  for(const container of ['collaborationDevices','collaborationProjects']){const box=ui.$(container).querySelector('input');box.checked=true;box.dispatchEvent(new ui.window.Event('change'));}
  ui.$('receiveEnabled').checked=true;ui.$('receiveEnabled').dispatchEvent(new ui.window.Event('change'));
  ui.$('saveCollaboration').click();const request=ui.calls.at(-1);assert.equal(request.action,'save-collaboration');
  ui.answer(request,'本机项目列表暂时无法读取，尚未保存授权。已保留原设置；请打开 Codex，刷新电脑协作设置后重试。',false);await tick();
  assert.match(ui.$('collaborationSummary').textContent,/authorization was not saved/);assert.doesNotMatch(ui.$('collaborationSummary').textContent,/is ready/);
  ui.$('backSettings').click();ui.$('settingsButton').click();ui.answer(ui.calls.at(-1),{collaboration:{...ready,projects:[],projectsAvailable:false,error:'本机 Codex 尚未就绪，请打开 Codex 后重试。'}});await tick();
  assert.equal(ui.$('receiveEnabled').checked,true);assert.equal(ui.$('collaborationProjects').querySelector('input').checked,true);assert.equal(ui.$('collaborationDevices').querySelector('input').checked,true);
  assert.equal(ui.calls.filter(call=>call.action==='save-collaboration').length,1);
});

test('fresh lists prune only missing draft identities and never select their same-name replacement', async t=>{
  const ui=mount(t);await tick();ui.$('settingsButton').click();
  const ready={...initial,deviceId:'device-self',hubOrigin:'https://fixture.invalid',devicesAvailable:true,projectsAvailable:true};
  ui.answer(ui.calls.at(-1),{collaboration:ready});await tick();
  const old=ui.$('collaborationDevices').querySelector('input');old.checked=true;old.dispatchEvent(new ui.window.Event('change'));
  ui.$('backSettings').click();ui.$('settingsButton').click();
  ui.answer(ui.calls.at(-1),{collaboration:{...ready,devices:[{id:'device-replaced',name:'Office PC',online:true}]}});await tick();
  assert.equal(ui.$('collaborationDevices').querySelector('input').checked,false);assert.match(ui.$('collaborationSummary').textContent,/所选电脑或项目已改变/);assert.equal(ui.calls.filter(call=>call.action==='save-collaboration').length,0);
});

test('status binding changes invalidate grants immediately and discard delayed old reads', async t => {
  const ui = mount(t, 'en'); await tick();
  const origin = 'https://fixture.invalid', oldId = '11111111-1111-4111-8111-111111111111', newId = '22222222-2222-4222-8222-222222222222';
  const old = { ...initial, hubOrigin: origin, deviceId: oldId, controlEnabled: true, receiveEnabled: true, allowedDeviceIds: ['device-b'], allowedProjectRoots: ['C:/work/a'], registration: { status: 'registered' } };
  ui.send({ type: 'status', status: { paired: true, origin, deviceId: oldId } });
  ui.$('settingsButton').click(); ui.answer(ui.calls.at(-1), { collaboration: old }); await tick();
  assert.match(ui.$('collaborationSummary').textContent, /has not been verified.*Transport closed/);
  ui.$('backSettings').click(); ui.$('settingsButton').click(); const delayed = ui.calls.at(-1);
  ui.send({ type: 'status', status: { paired: true, origin, deviceId: newId } });
  const current = ui.calls.at(-1); assert.notEqual(current.id, delayed.id);
  assert.equal(ui.$('controlEnabled').checked, false); assert.equal(ui.$('receiveEnabled').checked, false); assert.equal(ui.$('saveCollaboration').disabled, true);
  ui.$('saveCollaboration').click(); assert.equal(ui.calls.filter(call => call.action === 'save-collaboration').length, 0);
  ui.answer(delayed, { collaboration: old }); await tick();
  assert.equal(ui.$('saveCollaboration').disabled, true); assert.equal(ui.$('receiveEnabled').checked, false);
  ui.answer(current, { collaboration: { ...initial, hubOrigin: origin, deviceId: newId, requiresAuthorization: true, registration: { status: 'authorization-required' } } }); await tick();
  assert.equal(ui.$('controlEnabled').checked, false); assert.equal(ui.$('receiveEnabled').checked, false);
  assert.ok([...ui.$('collaborationDevices').querySelectorAll('input'), ...ui.$('collaborationProjects').querySelectorAll('input')].every(box => !box.checked));
  ui.$('controlEnabled').checked = true; ui.$('controlEnabled').dispatchEvent(new ui.window.Event('change'));
  ui.$('saveCollaboration').click(); const save = ui.calls.at(-1);
  assert.equal(save.payload.expectedHubOrigin, origin); assert.equal(save.payload.expectedDeviceId, newId);
  assert.equal(save.payload.controlEnabled, true); assert.equal(save.payload.receiveEnabled, false);
});

test('an old save reply cannot restore grants or report success after another pairing', async t => {
  const ui = mount(t); await tick();
  const old = { ...initial, hubOrigin: 'https://fixture.invalid', deviceId: '11111111-1111-4111-8111-111111111111' };
  ui.send({ type: 'status', status: { paired: true, origin: old.hubOrigin, deviceId: old.deviceId } });
  ui.$('settingsButton').click(); ui.answer(ui.calls.at(-1), { collaboration: old }); await tick();
  ui.$('controlEnabled').checked = true; ui.$('controlEnabled').dispatchEvent(new ui.window.Event('change')); ui.$('saveCollaboration').click(); const save = ui.calls.at(-1);
  ui.send({ type: 'status', status: { paired: true, origin: old.hubOrigin, deviceId: '22222222-2222-4222-8222-222222222222' } });
  const read = ui.calls.at(-1);
  ui.answer(save, { collaboration: { ...old, controlEnabled: true } }); await tick();
  assert.equal(ui.calls.at(-1).id, read.id); assert.equal(ui.$('controlEnabled').checked, false); assert.equal(ui.$('saveCollaboration').disabled, true);
  assert.doesNotMatch(ui.$('collaborationMessage').textContent, /已保存/);
});
test('saving collaboration and resetting pairing cannot overlap in the desktop page', async t => {
  const ui = mount(t); await tick(); ui.$('settingsButton').click(); ui.answer(ui.calls.at(-1), { collaboration: initial }); await tick();
  ui.$('saveCollaboration').click(); const save = ui.calls.at(-1); assert.equal(save.action, 'save-collaboration');
  assert.equal(ui.$('resetCollaborationPairing').disabled, true); ui.$('resetCollaborationPairing').click(); assert.equal(ui.calls.at(-1).id, save.id);
  ui.answer(save, 'fixture save error', false); await tick(); assert.equal(ui.$('resetCollaborationPairing').disabled, false);
  ui.$('resetCollaborationPairing').click(); const reset = ui.calls.at(-1); assert.equal(reset.action, 'reset-collaboration-pairing');
  assert.equal(ui.$('saveCollaboration').disabled, true); ui.$('saveCollaboration').click(); assert.equal(ui.calls.at(-1).id, reset.id);
});
