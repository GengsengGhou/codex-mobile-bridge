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
const output=resolve(process.argv[3]||join(source,'work/verification/desktop-v020'));
const fixture=await mkdtemp(join(tmpdir(),'codex-bilingual-ui-'));
await mkdir(output,{recursive:true});
const evidence={surface:'Actual installed .NET EXE and WebView2; isolated synthetic backend',realInstallationModified:false,physicalWindowsInputTested:false,backendCallsOnLanguageChange:[],cases:{},screenshots:[]};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(check,message,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check())return;}catch{}await sleep(100);}throw Error(message);}
let child,socket,sequence=0;const pending=new Map();
function call(method,params={}){const id=++sequence;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});}
async function evaluate(expression){const result=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;}
const click=id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const fields=()=>evaluate(`Object.fromEntries(['server','deviceName','pairingCode'].map(id=>[id,document.getElementById(id).value]))`);
async function screenshot(name){const data=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});const path=join(output,name+'.png');await writeFile(path,Buffer.from(data.data,'base64'));evidence.screenshots.push(path);}
async function start(){const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));child=spawn(join(fixture,'CodexMobileConnector.exe'),['--install-root',fixture,'--qa-debug-port',String(port),'--qa-language-evidence',join(fixture,'native-language.json')],{windowsHide:true,stdio:'ignore'});let target;await waitFor(async()=>{const items=await fetch(`http://127.0.0.1:${port}/json`).then(r=>r.json());target=items.find(x=>x.url==='https://connector.invalid/ui/index.html');return !!target;},'WebView did not start');socket=new WebSocket(target.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.once('open',r);socket.once('error',j)});socket.on('message',bytes=>{const m=JSON.parse(bytes);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)});await call('Runtime.enable');await call('Page.enable');await waitFor(()=>evaluate(`!!document.getElementById('deviceName').value`),'UI not ready');}
async function stop(){socket?.close();child?.kill();if(child&&child.exitCode===null)await new Promise(r=>child.once('exit',r));}
async function language(value){await evaluate(`document.getElementById('language').value=${JSON.stringify(value)};document.getElementById('language').dispatchEvent(new Event('change'))`);await waitFor(()=>evaluate(`document.documentElement.lang===${JSON.stringify(value)}`),'Language did not apply');}
try {
  const installed=spawnSync(setup,['--install-root',fixture,'--install','--language','en'],{windowsHide:true,timeout:120000});assert.equal(installed.status,0,installed.error?.message);
  assert.deepEqual(JSON.parse(await readFile(join(fixture,'.local/desktop-language.json'),'utf8')),{language:'en'});
  await copyFile(join(source,'deploy/windows/native-qa-status.mjs'),join(fixture,'scripts/connector-gui.mjs'));
  await writeFile(join(fixture,'scripts/state.txt'),'slow-initialize');await start();
  assert.equal(await evaluate(`document.documentElement.lang`),'en');
  await waitFor(async()=>{try{return (await readFile(join(fixture,'scripts/requests.jsonl'),'utf8')).includes('"action":"initialize"')}catch{return false}},'Backend initialization did not begin');
  await evaluate(`document.getElementById('server').value='https://draft.example';document.getElementById('server').dispatchEvent(new Event('input'));document.getElementById('deviceName').value='服务器';document.getElementById('deviceName').dispatchEvent(new Event('input'));document.getElementById('pairingCode').value='x'.repeat(43);document.getElementById('server').focus();document.getElementById('server').setSelectionRange(8,13)`);
  const drafts=await fields();const requestsBefore=(await readFile(join(fixture,'scripts/requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  await language('zh-CN');assert.deepEqual(await fields(),drafts);assert.equal(await evaluate(`document.getElementById('pairProgress').textContent`),'正在准备连接…');
  assert.deepEqual(await evaluate(`({id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})`),{id:'server',start:8,end:13});
  await language('en');assert.deepEqual(await fields(),drafts);assert.equal(await evaluate(`document.getElementById('pairProgress').textContent`),'Preparing connection…');
  assert.deepEqual(await evaluate(`({id:document.activeElement.id,start:document.activeElement.selectionStart,end:document.activeElement.selectionEnd})`),{id:'server',start:8,end:13});
  const requestsAfter=(await readFile(join(fixture,'scripts/requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);evidence.backendCallsOnLanguageChange=requestsAfter.slice(requestsBefore.length);assert.deepEqual(evidence.backendCallsOnLanguageChange,[]);
  evidence.cases.initialization={installerChoicePersisted:true,changedDuringInitialization:true,inputDraftsPairCodeFocusAndSelectionPreserved:true,noControlReconnectCalls:true};
  await writeFile(join(fixture,'scripts/state.txt'),'unpaired');await waitFor(()=>evaluate(`!document.getElementById('pairButton').disabled`),'Initialize never finished');await screenshot('desktop-pairing-en');
  await language('zh-CN');await screenshot('desktop-pairing-zh');
  await language('en');await evaluate(`document.getElementById('server').value='http://insecure.example'`);await click('openSetup');await waitFor(()=>evaluate(`document.getElementById('feedback').textContent.startsWith('Enter an HTTPS')`),'English native validation error missing');
  await language('zh-CN');assert.equal(await evaluate(`document.getElementById('feedback').textContent`),'请输入 HTTPS 服务器地址，不包含路径、账号或参数。');
  await language('en');assert.equal(await evaluate(`document.getElementById('feedback').textContent`),'Enter an HTTPS server address without a path, account, or parameters.');assert.equal(await evaluate(`document.getElementById('server').value`),'http://insecure.example');
  evidence.cases.dynamicErrors={nativeErrorBilingual:true,existingErrorSurvivesLanguageChange:true,errorTranslationPreservesDraft:true};
  await writeFile(join(fixture,'scripts/fixture.json'),JSON.stringify({paired:true,deviceName:'服务器',origin:'https://server.example',paused:true}));await writeFile(join(fixture,'scripts/state.txt'),'paused');await click('refreshStatus');await waitFor(()=>evaluate(`!document.getElementById('connectionView').hidden`),'Paired view missing');
  for(const locale of ['en','zh-CN']){await language(locale);const native=JSON.parse(await readFile(join(fixture,'native-language.json'),'utf8'));assert.equal(native.language,locale);assert.equal(native.title,'Codex Mobile Bridge');assert.ok(native.trayTooltip.startsWith('Codex Mobile Bridge'));assert.equal(native.trayLabels[1],locale==='en'?'Show window':'显示窗口');assert.equal(native.trayLabels.at(-1),locale==='en'?'Quit':'退出');assert.equal(await evaluate(`document.getElementById('computerValue').textContent`),'服务器');assert.equal(await evaluate(`document.getElementById('connectionHeading').textContent`),locale==='en'?'Disconnected':'连接已断开');await click('settingsButton');await screenshot('desktop-settings-'+locale);for(const width of [420,460,620]){await call('Emulation.setDeviceMetricsOverride',{width,height:720,deviceScaleFactor:1,mobile:false});assert.equal(await evaluate(`document.documentElement.scrollWidth<=innerWidth`),true);}await click('backSettings');}
  evidence.cases.collisionAndLayout={userNameEqualToUiPhrasePreserved:true,pausedStatusBothLanguages:true,widths:[420,460,620],horizontalOverflow:false};
  await evaluate(`window.qaLocaleInvalid=null;chrome.webview.addEventListener('message',e=>{if(e.data.id===91001)window.qaLocaleInvalid=e.data});chrome.webview.postMessage({id:91001,action:'set-language',payload:{language:'fr'}})`);await waitFor(()=>evaluate(`window.qaLocaleInvalid?.ok===false`),'Native accepted invalid locale');assert.equal(JSON.parse(await readFile(join(fixture,'.local/desktop-language.json'),'utf8')).language,'zh-CN');
  await language('en');await stop();await start();assert.equal(await evaluate(`document.documentElement.lang`),'en');assert.equal(await evaluate(`document.title`),'Codex Mobile Bridge');evidence.cases.restart={savedInstalledChoiceHonored:true,invalidLocaleRejectedWithoutMutation:true,englishProductTitle:true};
  evidence.passed=true;await writeFile(join(output,'bilingual-webview-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await stop();await sleep(500);spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(fixture,'deploy/uninstall-connector.ps1'),'-Root',fixture],{windowsHide:true,timeout:30000});await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
