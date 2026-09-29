import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import assert from 'node:assert/strict';
const source=fileURLToPath(new URL('..',import.meta.url));
const setup=process.argv[2] || join(source,'dist/CodexMobileConnector-Setup.exe');
const fixture=await mkdtemp(join(tmpdir(),'codex-gui-status-'));
const install=spawnSync(setup,['--install-root',fixture,'--install'],{windowsHide:true,timeout:120000});assert.equal(install.status,0,install.error?.message);
await mkdir(join(fixture,'.local'),{recursive:true});
const exe=join(fixture,'CodexMobileConnector.exe');
const evidence={createdAt:new Date().toISOString(),isolatedActualExe:true,startupRegistrations:'not modified',businessMessagesSent:0,cases:{}};
const bridge=http.createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Set-Cookie':`bridge_session=${'a'.repeat(64)}; HttpOnly`});res.end('<title>Codex 手机桥接</title>');}
  else{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({connected:true,mode:'desktop-pipe',canSend:false,callerThreadId:'11111111-1111-4111-8111-111111111111'}));}
});
await new Promise(r=>bridge.listen(0,'127.0.0.1',r));
async function check(name){const output=join(fixture,'.local',`${name}-status.json`);const child=spawn(exe,['--install-root',fixture,'--qa-status',output],{windowsHide:true,stdio:'ignore'});const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Isolated GUI status timed out'));},35000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',status=>{clearTimeout(timer);resolve(status);});});assert.equal(code,0);const state=JSON.parse(await readFile(output,'utf8'));assert.equal(state.windowStatus,state.trayStatus);assert.equal(state.trayTooltip,state.trayStatus.slice(0,63));assert.notEqual(state.trayStatus,'正在检查连接');evidence.cases[name]=state;return state;}
try{
  const literal=value=>"'"+value.replaceAll("'","''")+"'";
  const requestProbe=`$assembly=[Reflection.Assembly]::LoadFile(${literal(exe)});$method=$assembly.GetType('ConnectorBootstrap').GetMethod('RequestJson');$request=@{action='pair';name='测试电脑'+[char]0xD83D+[char]0xDE00};$encoded=$method.Invoke($null,[object[]]@($request));@{encoded=$encoded;ascii=($encoded -notmatch '[^\\x00-\\x7f]')}|ConvertTo-Json -Compress`;
  const requestResult=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(requestProbe,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(requestResult.status,0,requestResult.stderr);const encodedRequest=JSON.parse(requestResult.stdout);assert.equal(encodedRequest.ascii,true);assert.equal(JSON.parse(encodedRequest.encoded).name,'测试电脑😀');evidence.unicodeRequestRoundTrip=true;
  const unpaired=await check('unpaired');assert.equal(unpaired.paired,false);assert.equal(unpaired.statusReadSucceeded,true);assert.equal(unpaired.trayStatus,'尚未配对');assert.equal(unpaired.retryAvailable,false);assert.equal(unpaired.connectMenuEnabled,false);
  await writeFile(join(fixture,'.local/connector-control.json'),'{broken');
  const failed=await check('read-error');assert.equal(failed.statusReadSucceeded,false);assert.equal(failed.trayStatus,'连接状态读取失败');assert.equal(failed.retryAvailable,true);assert.equal(failed.connectMenuEnabled,false);
  await writeFile(join(fixture,'.local/connector-control.json'),JSON.stringify({version:1,paused:false,autoStart:false,revision:'fixture',disconnectVerified:false}));
  await writeFile(join(fixture,'.local/hub-connector.json'),JSON.stringify({version:1,hubOrigin:'https://fixture.invalid',deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'f'.repeat(43),bridgePort:bridge.address().port}));
  await writeFile(join(fixture,'.local/hub-connector-state.json'),JSON.stringify({state:'online',pid:1234,updatedAt:new Date().toISOString()}));
  const online=await check('online');assert.equal(online.paired,true);assert.equal(online.statusReadSucceeded,true);assert.equal(online.trayStatus,'已连接');assert.equal(online.retryAvailable,false);assert.equal(online.connectMenuEnabled,true);
  evidence.passed=true;
}finally{
  await new Promise(r=>bridge.close(r));
  const uninstall=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(fixture,'deploy/uninstall-connector.ps1'),'-Root',fixture],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(uninstall.status,0,uninstall.stderr);
}
await writeFile(join(source,'work/codex-probe/connector-status-regression-evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence,null,2));
