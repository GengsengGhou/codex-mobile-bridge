import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

const source=fileURLToPath(new URL('../..',import.meta.url));
const setup=resolve(process.argv[2]||join(source,'dist/CodexMobileConnector-Setup.exe'));
const output=resolve(process.argv[3]||join(source,'work/webview-ui'));
const fixture=await mkdtemp(join(tmpdir(),'codex-webview-ui-'));
await mkdir(output,{recursive:true});
const evidence={createdAt:new Date().toISOString(),surface:'actual installed Windows EXE with Microsoft WebView2',input:'isolated CDP browser-engine key and text events',physicalWindowsKeyboardTested:false,realLoginEntriesModified:false,businessMessagesSent:0,cases:{},screenshots:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,message,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{}await sleep(100);}throw Error(message);}
const portServer=net.createServer();await new Promise(resolve=>portServer.listen(0,'127.0.0.1',resolve));const port=portServer.address().port;await new Promise(resolve=>portServer.close(resolve));
let child,socket;let sequence=0;const pending=new Map();
function call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method));},30000);pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params}));});}
const evaluate=async expression=>{const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
async function type(id,text){await evaluate(`document.getElementById(${JSON.stringify(id)}).focus();document.getElementById(${JSON.stringify(id)}).select()`);await call('Input.insertText',{text});}
const values=()=>evaluate(`Object.fromEntries(['server','deviceName','pairingCode'].map(id=>{const e=document.getElementById(id);return [id,{value:e.value,disabled:e.disabled}]}))`);
async function screenshot(name){const path=join(output,name+'.png');const capture=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(path,Buffer.from(capture.data,'base64'));evidence.screenshots.push(path);}
async function state(name){await writeFile(join(fixture,'scripts/state.txt'),name+'\n');await evaluate(`document.getElementById('refreshStatus').click()`);}
try {
  const installed=spawnSync(setup,['--install-root',fixture,'--install'],{windowsHide:true,timeout:120000});assert.equal(installed.status,0,installed.error?.message);
  await copyFile(join(source,'deploy/windows/native-qa-status.mjs'),join(fixture,'scripts/connector-gui.mjs'));
  await writeFile(join(fixture,'scripts/state.txt'),'slow-initialize\n');
  const openRecord=join(fixture,'open-evidence.txt');
  const displayRecord=join(fixture,'display-evidence.json');
  child=spawn(join(fixture,'CodexMobileConnector.exe'),['--install-root',fixture,'--qa-debug-port',String(port),'--qa-open-evidence',openRecord,'--qa-display-evidence',displayRecord],{windowsHide:true,stdio:'ignore'});
  let target;
  await waitFor(async()=>{const targets=await fetch(`http://127.0.0.1:${port}/json`).then(response=>response.json());target=targets.find(item=>item.url==='https://connector.invalid/ui/index.html');return !!target;},'WebView2 local page not available');
  socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  socket.on('message',bytes=>{const message=JSON.parse(bytes.toString());if(!message.id)return;const request=pending.get(message.id);if(!request)return;pending.delete(message.id);clearTimeout(request.timeout);message.error?request.reject(Error(message.error.message)):request.resolve(message.result);});
  await call('Runtime.enable');await call('Page.enable');
  await waitFor(()=>evaluate(`!!document.getElementById('deviceName').value`),'Frontend did not initialize');
  const display=JSON.parse(await readFile(displayRecord,'utf8'));const webDisplay=await evaluate(`({devicePixelRatio,cssWidth:innerWidth,cssHeight:innerHeight})`);
  assert.equal(display.perMonitorV2,true);assert.equal(display.trayVisible,false);assert.equal(display.passwordAutosaveEnabled,false);assert.equal(display.generalAutofillEnabled,false);assert.equal(webDisplay.devicePixelRatio,display.windowDpi/96);assert.ok(Math.abs(display.browserWidth-webDisplay.cssWidth*webDisplay.devicePixelRatio)<3);evidence.cases.monitorDpi={...display,...webDisplay,bitmapVirtualization:false,osDisplayDpiChanged:false};
  assert.equal(await evaluate(`document.getElementById('pairingView').hidden`),false);
  await waitFor(async()=>{try{return (await readFile(join(fixture,'scripts/requests.jsonl'),'utf8')).includes('"action":"initialize"');}catch{return false;}},'Slow initialize fixture did not start');
  assert.equal(await evaluate(`document.getElementById('pairButton').disabled`),true);
  assert.equal(await evaluate(`document.getElementById('openSetup').disabled`),false);
  await evaluate(`window.qaRejected=null;chrome.webview.addEventListener('message',event=>{if(event.data.id===9999)window.qaRejected=event.data});chrome.webview.postMessage({id:9999,action:'pair',payload:{origin:'https://preview.example',name:'Early fixture',code:'x'.repeat(43)}})`);
  await waitFor(()=>evaluate(`window.qaRejected?.ok===false`),'Native host did not reject a mutation before initialization');
  await writeFile(join(fixture,'scripts/state.txt'),'slow-unpaired\n');
  await type('server','preview.example:8443');await type('deviceName','Keyboard Fixture PC');await type('pairingCode','x'.repeat(43));
  await evaluate(`document.getElementById('server').focus();document.getElementById('server').setSelectionRange(7,14)`);
  const before=await values();await waitFor(()=>evaluate(`!document.getElementById('pairButton').disabled`),'Intent initialization never completed');
  evidence.cases.slowInitialization={delayMs:8000,nativeMutationRejectedBeforeIntentInitialization:true,fieldsEditable:true,browserHandoffUsable:true,blockedMutationDidNotEnroll:true};await sleep(9500);
  assert.deepEqual(await values(),before);
  assert.deepEqual(await evaluate(`({id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})`),{id:'server',start:7,end:14});
  const images=await evaluate(`Array.from(document.images).filter(image=>image.getBoundingClientRect().width>0).map(image=>({src:image.getAttribute('src'),loaded:image.naturalWidth>0}))`);assert.equal(images.every(image=>image.loaded),true);
  evidence.cases.slowPolling={durationMs:9500,statusDelayMs:8000,draftsPreserved:true,focusAndSelectionPreserved:true,allInputsEnabled:true,allVisibleLocalImagesRendered:true};
  await evaluate(`window.qaInvalid={};chrome.webview.addEventListener('message',event=>{if(event.data.id>=10000)window.qaInvalid[event.data.id]=event.data});chrome.webview.postMessage({id:10000,action:'execute',payload:{path:'fixture'}});chrome.webview.postMessage({id:10001,action:'connect',payload:{extra:true}});chrome.webview.postMessage({id:10002,action:'open-web',payload:{origin:'http://preview.example',setup:true}})`);
  await waitFor(()=>evaluate(`[10000,10001,10002].every(id=>window.qaInvalid[id]?.ok===false)`),'Native host did not reject invalid commands');
  await call('Page.navigate',{url:'https://external.example.invalid/'});assert.equal(await evaluate('location.href'),'https://connector.invalid/ui/index.html');evidence.cases.commandBoundary={unknownCommandsRejected:true,unexpectedFieldsRejected:true,insecureBrowserHandoffRejected:true,externalEmbeddedNavigationBlocked:true};
  await screenshot('onboarding-desktop');
  await click('openSetup');await waitFor(async()=>{try{return (await readFile(openRecord,'utf8')).includes('https://preview.example:8443/?setup=connector');}catch{return false;}},'Setup origin was not normalized');
  evidence.cases.browserHandoff={bareHostnameNormalized:true,httpsOriginValidated:true,setupContextAdded:true,fixtureDidNotOpenExternalBrowser:true};
  await state('error');await waitFor(()=>evaluate(`!document.getElementById('feedback').hidden`),'Status error not rendered');assert.deepEqual(await values(),before);assert.equal(await evaluate(`document.getElementById('pairingView').hidden`),false);await screenshot('onboarding-read-error');
  evidence.cases.readFailure={onboardingRemainsVisible:true,draftsPreserved:true};
  await state('slow-unpaired');await type('pairingCode','p'.repeat(43));await evaluate(`document.getElementById('pairingCode').focus()`);
  for(let n=0;n<2;n++){await call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r',unmodifiedText:'\r'});await call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});}
  await waitFor(()=>evaluate(`document.getElementById('pairButton').disabled`),'Pair submission did not begin');
  await waitFor(()=>evaluate(`!document.getElementById('connectionView').hidden`),'Pair result did not transition to connection manager');
  const requests=(await readFile(join(fixture,'scripts/requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(requests.filter(item=>item.action==='pair').length,1);
  assert.equal(await evaluate(`document.getElementById('pairingCode').value`),'');evidence.cases.pairEnter={browserEngineEnterSubmitted:true,duplicateSubmissionBlocked:true,pairRequests:1,successfulPairClearsCode:true};
  await state('online');await waitFor(()=>evaluate(`document.getElementById('connectionHeading').textContent==='已连接'`),'Online manager not rendered');await screenshot('connected-desktop');
  await state('hub-only');await waitFor(()=>evaluate(`document.getElementById('codexStatus').textContent==='未就绪'`),'Independent Codex status did not render');assert.equal(await evaluate(`document.getElementById('serverStatus').textContent`),'已连接');evidence.cases.independentStatus={hubOnlineCodexUnavailableDistinguished:true};
  await click('settingsButton');await screenshot('settings-desktop');await click('changeServer');await type('server','https://new.example');await type('deviceName','Replacement draft');await type('pairingCode','r'.repeat(43));const replacement=await values();await sleep(3500);await click('cancelPairing');await click('settingsButton');await click('changeServer');assert.deepEqual(await values(),replacement);evidence.cases.replacementCancel={pollsPreserveDraft:true,cancelAndReopenPreserveDraft:true};
  await screenshot('replacement-desktop');await click('cancelPairing');await state('error');await waitFor(()=>evaluate(`document.getElementById('connectionHeading').textContent==='连接状态读取失败'`),'Failed status still looks online');assert.equal(await evaluate(`document.getElementById('stateMark').dataset.state`),'error');evidence.cases.failedStatusAfterOnline={onlineHeadlineCleared:true};
  await state('online');await waitFor(()=>evaluate(`document.getElementById('connectionHeading').textContent==='已连接'`),'Online restore failed');await click('settingsButton');await state('settings-failure');
  await evaluate(`document.getElementById('autoStart').click()`);await waitFor(()=>evaluate(`document.getElementById('feedback').textContent.includes('无法保存')`),'Setting save failure was not shown');assert.equal(await evaluate(`document.getElementById('autoStart').checked`),true);
  await click('autoStart');await waitFor(()=>evaluate(`!document.getElementById('autoStart').disabled&&!document.getElementById('autoStart').checked`),'Settings retry did not save');evidence.cases.settingsSave={slowFailureVisible:true,failedValueRolledBack:true,retrySaved:false===await evaluate(`document.getElementById('autoStart').checked`)};
  for(const [width,height,scale] of [[460,620,1],[420,680,1.5],[620,660,2]]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:scale,mobile:false});
    assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);await screenshot(`settings-${width}-${scale}`);
  }
  evidence.cases.responsiveLayout={cssWidths:[460,420,620],simulatedDeviceScaleFactors:[1,1.5,2],horizontalOverflow:false,osDisplayDpiChanged:false};
  evidence.passed=true;
  await writeFile(join(output,'webview-ui-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
} finally {
  socket?.close();child?.kill();if(child&&child.exitCode===null)await new Promise(resolve=>child.once('exit',resolve));await sleep(1000);
  const uninstaller=join(fixture,'deploy/uninstall-connector.ps1');
  spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',uninstaller,'-Root',fixture],{windowsHide:true,timeout:30000});
  await rm(fixture,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
