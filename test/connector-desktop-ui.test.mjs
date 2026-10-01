import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
const html=await readFile(new URL('../deploy/windows/ui/index.html',import.meta.url),'utf8');
// Mirror the page's declared defer order: locale catalog must precede the desktop controller.
const scripts=await Promise.all([...html.matchAll(/<script\s+src="([^"]+)"\s+defer><\/script>/g)].map(async ([,source])=>({source,code:await readFile(new URL('../deploy/windows/ui/'+source,import.meta.url),'utf8')})));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function mount(t,{language='zh-CN',deviceName='Fixture PC'}={}) {
  const dom=new JSDOM(html,{url:'https://connector.invalid/ui/index.html',runScripts:'outside-only',pretendToBeVisual:true});
  const calls=[];let receive;
  dom.window.chrome={webview:{postMessage:command=>calls.push(command),addEventListener:(name,handler)=>{receive=handler;}}};
  for(const script of scripts)dom.window.eval(script.code);t.after(()=>dom.window.close());
  const $=id=>dom.window.document.getElementById(id);
  const send=data=>receive({data});
  const answer=(command,result={},ok=true)=>send({type:'result',id:command.id,ok,...(ok?{result}:{error:result})});
  const input=(id,text)=>{$(id).value=text;$(id).dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  answer(calls[0],{language,deviceName,root:'C:\\fixture',version:'0.2.0',webviewVersion:'154'});
  return {$,calls,send,answer,input,window:dom.window};
}
const online={paired:true,origin:'https://old.example',deviceName:'Old PC',hubConnected:true,hubState:'online',bridgeConnected:true,state:'online',paused:false,autoStart:true};
test('editable onboarding is immediate and polling/failures preserve focus, selection and all drafts',async t=>{
  const ui=mount(t);await tick();
  assert.equal(ui.$('pairingView').hidden,false);
  ui.input('server','new.example');ui.input('deviceName','My PC');ui.input('pairingCode','c'.repeat(43));
  ui.$('server').focus();ui.$('server').setSelectionRange(3,6);
  for(const data of [{type:'status',status:{...online,paired:false}},{type:'status',error:'Slow/offline fixture'},{type:'busy',value:true},{type:'busy',value:false}])ui.send(data);
  assert.equal(ui.window.document.activeElement,ui.$('server'));assert.equal(ui.$('server').selectionStart,3);assert.equal(ui.$('server').selectionEnd,6);
  assert.equal(ui.$('server').value,'new.example');assert.equal(ui.$('deviceName').value,'My PC');assert.equal(ui.$('pairingCode').value,'c'.repeat(43));
  for(const id of ['server','deviceName','pairingCode'])assert.equal(ui.$(id).disabled,false);
  assert.equal(ui.$('pairingView').hidden,false);
});
test('declared page scripts honor the installed English preference and retain English product branding',async t=>{
  assert.deepEqual(scripts.map(script=>script.source),['desktop-locale.js','connector.js']);
  const ui=mount(t,{language:'en',deviceName:'服务器'});await tick();
  assert.equal(ui.window.document.documentElement.lang,'en');assert.equal(ui.window.document.title,'Codex Mobile Bridge');
  assert.equal(ui.window.document.querySelector('.brand strong').textContent,'Codex Mobile Bridge');
  assert.equal(ui.$('pairingHeading').textContent,'Pair this computer');assert.equal(ui.$('settingsButton').getAttribute('aria-label'),'Settings');
  assert.equal(ui.$('language').value,'en');assert.equal(ui.$('deviceName').value,'服务器');
  ui.send({type:'status',status:{...online,deviceName:'服务器'}});
  assert.equal(ui.$('computerValue').textContent,'服务器');assert.equal(ui.$('connectionHeading').textContent,'Connected');
});
test('language switching preserves initialization, drafts, focus, errors and user-name collisions without connection commands',async t=>{
  const ui=mount(t,{language:'en'});await tick();
  ui.input('server','https://draft.example');ui.input('deviceName','服务器');ui.input('pairingCode','s'.repeat(43));
  ui.$('server').focus();ui.$('server').setSelectionRange(8,13);ui.send({type:'busy',value:true,reason:'initialize'});
  const change=async language=>{ui.$('language').value=language;ui.$('language').dispatchEvent(new ui.window.Event('change'));const request=ui.calls.at(-1);assert.equal(request.action,'set-language');assert.deepEqual(JSON.parse(JSON.stringify(request.payload)),{language});ui.answer(request,{language});await tick();};
  const unchanged=()=>{assert.equal(ui.$('server').value,'https://draft.example');assert.equal(ui.$('deviceName').value,'服务器');assert.equal(ui.$('pairingCode').value,'s'.repeat(43));assert.equal(ui.window.document.activeElement,ui.$('server'));assert.equal(ui.$('server').selectionStart,8);assert.equal(ui.$('server').selectionEnd,13);};
  await change('zh-CN');unchanged();assert.equal(ui.$('pairProgress').textContent,'正在准备连接…');assert.equal(ui.$('pairButton').disabled,true);
  await change('en');unchanged();assert.equal(ui.$('pairProgress').textContent,'Preparing connection…');assert.equal(ui.$('pairButton').disabled,true);
  ui.send({type:'busy',value:false,reason:'initialize'});ui.$('openSetup').click();ui.answer(ui.calls.at(-1),'Enter an HTTPS server address without a path, account, or parameters.',false);await tick();
  await change('zh-CN');unchanged();assert.equal(ui.$('feedback').textContent,'请输入 HTTPS 服务器地址，不包含路径、账号或参数。');
  await change('en');unchanged();assert.equal(ui.$('feedback').textContent,'Enter an HTTPS server address without a path, account, or parameters.');
  ui.send({type:'status',status:{...online,deviceName:'服务器'}});await change('zh-CN');assert.equal(ui.$('computerValue').textContent,'服务器');assert.equal(ui.$('connectionHeading').textContent,'已连接');
  await change('en');ui.send({type:'status',status:{...online,deviceName:'服务器',paused:true}});assert.equal(ui.$('connectionHeading').textContent,'Disconnected');assert.equal(ui.$('computerValue').textContent,'服务器');
  assert.deepEqual([...new Set(ui.calls.map(call=>call.action))],['ready','set-language','open-web']);
});
test('failed language persistence restores the select and keeps the existing locale and drafts',async t=>{
  const ui=mount(t,{language:'en'});await tick();ui.input('deviceName','已连接');ui.input('pairingCode','f'.repeat(43));
  ui.$('language').value='zh-CN';ui.$('language').dispatchEvent(new ui.window.Event('change'));ui.answer(ui.calls.at(-1),'Fixture preference write denied',false);await tick();
  assert.equal(ui.window.document.documentElement.lang,'en');assert.equal(ui.$('language').value,'en');assert.equal(ui.$('pairingHeading').textContent,'Pair this computer');
  assert.equal(ui.$('deviceName').value,'已连接');assert.equal(ui.$('pairingCode').value,'f'.repeat(43));assert.equal(ui.$('feedback').textContent,'Fixture preference write denied');
  assert.deepEqual(ui.calls.map(call=>call.action),['ready','set-language']);
});
test('bare hostname opens setup in system browser and Enter/duplicate submission consumes at most one code',async t=>{
  const ui=mount(t);await tick();ui.input('server','new.example:8443');ui.$('openSetup').click();
  assert.deepEqual(JSON.parse(JSON.stringify(ui.calls.at(-1).payload)),{origin:'https://new.example:8443',setup:true});ui.answer(ui.calls.at(-1));await tick();
  ui.input('deviceName','My PC');ui.input('pairingCode','p'.repeat(43));
  const submit=()=>ui.$('pairingForm').dispatchEvent(new ui.window.Event('submit',{bubbles:true,cancelable:true}));
  submit();submit();assert.equal(ui.calls.filter(call=>call.action==='pair').length,1);assert.equal(ui.$('pairButton').disabled,true);
  ui.send({type:'busy',value:false});submit();assert.equal(ui.calls.filter(call=>call.action==='pair').length,1);
  ui.answer(ui.calls.at(-1),'Expired code',false);await tick();assert.equal(ui.$('pairButton').disabled,false);assert.equal(ui.$('pairingCode').value,'p'.repeat(43));assert.match(ui.$('feedback').textContent,/Expired/);
});
test('replacement cancel/settings/polls retain inputs and unreadable status removes online indicators',async t=>{
  const ui=mount(t);await tick();ui.send({type:'status',status:online});
  ui.$('settingsButton').click();ui.$('changeServer').click();ui.input('server','https://new.example');ui.input('deviceName','Replacement PC');ui.input('pairingCode','r'.repeat(43));
  ui.send({type:'status',status:online});ui.$('cancelPairing').click();assert.equal(ui.$('connectionView').hidden,false);
  ui.$('settingsButton').click();ui.$('changeServer').click();assert.equal(ui.$('server').value,'https://new.example');assert.equal(ui.$('deviceName').value,'Replacement PC');assert.equal(ui.$('pairingCode').value,'r'.repeat(43));
  ui.$('cancelPairing').click();ui.send({type:'status',status:online,error:'Cannot read'});
  assert.equal(ui.$('connectionHeading').textContent,'连接状态读取失败');assert.equal(ui.$('stateMark').dataset.state,'error');assert.equal(ui.$('serverStatus').dataset.online,'false');assert.equal(ui.$('codexStatus').dataset.online,'false');
});
test('validated full JSON import fills visible fields without automatic enrollment',async t=>{
  const ui=mount(t);await tick();ui.$('pasteInformation').click();const request=ui.calls.at(-1);
  assert.equal(request.action,'paste-information');ui.answer(request,{origin:'https://import.example',name:'Imported PC',code:'j'.repeat(43)});await tick();
  assert.equal(ui.$('server').value,'https://import.example');assert.equal(ui.$('deviceName').value,'Imported PC');assert.equal(ui.$('pairingCode').value,'j'.repeat(43));assert.equal(ui.calls.some(call=>call.action==='pair'),false);
});
test('partial enrollment retry remains connect-only until explicit recovery succeeds',async t=>{
  const ui=mount(t);await tick();ui.send({type:'status',status:{...online,hubConnected:false,bridgeConnected:false},warning:'Pending background registration'});
  ui.$('retryButton').click();assert.equal(ui.calls.at(-1).action,'connect');ui.answer(ui.calls.at(-1),'Try again',false);await tick();assert.equal(ui.$('retryButton').hidden,false);
  ui.$('retryButton').click();ui.answer(ui.calls.at(-1),{recoveryCompleted:false,paused:true});await tick();assert.match(ui.$('feedback').textContent,/Pending/);
  ui.$('retryButton').click();ui.answer(ui.calls.at(-1),{recoveryCompleted:true,paused:false});await tick();assert.equal(ui.$('feedback').hidden,true);assert.equal(ui.calls.filter(call=>call.action==='pair').length,0);assert.equal(ui.calls.filter(call=>call.action==='disconnect').length,0);
});
