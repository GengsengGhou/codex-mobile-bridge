import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import assert from 'node:assert/strict';
import { createConnectorControl, stopOwnedConnectorProcesses } from '../scripts/connector-control.mjs';
import { launchWindowsBridge } from '../scripts/windows-launch.mjs';
const source=fileURLToPath(new URL('..',import.meta.url));
const setup=resolve(process.argv[2] || join(source,'dist/CodexMobileConnector-Setup.exe'));
const root=await mkdtemp(join(tmpdir(),'codex-tray-acceptance-'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const install=spawnSync(setup,['--install-root',root,'--install'],{windowsHide:true,timeout:120000});assert.equal(install.status,0,install.error?.message);
const nodePath=join(root,'runtime/node.exe'), exe=join(root,'CodexMobileConnector.exe');
const registration={read:async()=>({enabled:false}),set:async enabled=>({enabled})};
const control=createConnectorControl({root,registration,stop:opts=>stopOwnedConnectorProcesses({...opts,nodePath})});
await control.initialize();
const key=join(root,'.local/fixture.key'),cert=join(root,'.local/fixture.pem');
const opensslConfig=join(root,'.local/openssl.cnf');await writeFile(opensslConfig,'[req]\ndistinguished_name=dn\n[dn]\n');
const certificate=spawnSync('openssl',['req','-config',opensslConfig,'-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1,DNS:localhost'],{windowsHide:true,encoding:'utf8',timeout:20000});assert.equal(certificate.status,0,certificate.stderr);
const bridge=http.createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Set-Cookie':'bridge_session=abcdef0123456789; HttpOnly'});res.end('<title>Codex 手机桥接</title>');}
  else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({connected:true,canSend:false,callerThreadId:'11111111-1111-4111-8111-111111111111',allowedSendThreadId:'11111111-1111-4111-8111-111111111111',sendScope:'disabled'}));}
});
const hub=https.createServer({key:await readFile(key),cert:await readFile(cert)});
const sockets=new WebSocketServer({server:hub});
await new Promise(r=>bridge.listen(0,'127.0.0.1',r));await new Promise(r=>hub.listen(0,'127.0.0.1',r));
const pair={version:1,hubOrigin:`https://127.0.0.1:${hub.address().port}`,deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'f'.repeat(43),bridgePort:bridge.address().port};
await writeFile(join(root,'.local/hub-connector.json'),JSON.stringify(pair));
await writeFile(join(root,'.local/runtime.json'),JSON.stringify({callerThreadId:pair.deviceId,allowedSendThreadId:pair.deviceId,enableSend:false,sendScope:'single',port:pair.bridgePort}));
await writeFile(join(root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath}));
const saved=await readFile(join(root,'.local/runtime.json'),'utf8');
let connector, unrelated, form;
const evidence={startupRegistrations:'not modified',livePairing:'not modified',nativeTrayClicksTested:false};
async function waitFor(predicate,message,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await predicate())return;await sleep(100);}throw Error(message);}
const gui=action=>{const result=spawnSync(nodePath,[join(root,'scripts/connector-gui.mjs')],{input:JSON.stringify({action}),windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(result.status,0,result.stdout||result.stderr);return JSON.parse(result.stdout);};
try {
  await control.resume('manual');
  let connection, closed=false;
  sockets.once('connection',socket=>{connection=socket;socket.once('close',()=>closed=true);});
  connector=spawn(nodePath,[join(root,'scripts/start-connector.mjs')],{windowsHide:true,env:{...process.env,NODE_EXTRA_CA_CERTS:cert},stdio:'ignore'});
  await waitFor(()=>!!connection,'Fixture WSS did not connect');
  unrelated=spawn(nodePath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
  const watcher=await launchWindowsBridge({root,nodePath,supervisorPath:join(root,'scripts/connector-login.mjs'),env:{},instanceName:'connector-login',logName:'connector-login'});
  await sleep(2500);
  const stopped=gui('disconnect');assert.equal(stopped.disconnectVerified,true);await waitFor(()=>closed,'WSS remained open after disconnect');
  assert.equal(unrelated.exitCode,null);assert.equal(bridge.listening,true);assert.deepEqual(JSON.parse(await readFile(join(root,'.local/runtime.json'),'utf8')),JSON.parse(saved));
  evidence.actualWssOpenedAndClosed=true;evidence.ownedWatcherStopped=true;evidence.unrelatedNodeSurvived=true;evidence.bridgeAndRuntimePreserved=true;evidence.watcherWrapperPid=watcher.pid;
  await control.configure(true);
  const legacy=spawnSync(nodePath,[join(root,'scripts/connector-login.mjs'),'--startup'],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(legacy.status,0,legacy.stderr);
  await sleep(11000);assert.equal(sockets.clients.size,0);assert.equal((await control.read()).paused,true);evidence.sameLogonLegacyStartupRemainsPaused=true;
  await control.configure(false);
  const path=join(root,'.local/form-lifecycle.json');
  form=spawn(exe,['--install-root',root,'--qa-lifecycle',path],{windowsHide:true,stdio:'ignore'});
  await waitFor(async()=>{try{await readFile(path);return true;}catch{return false;}},'Actual EXE lifecycle evidence unavailable',25000);
  const lifecycle=JSON.parse(await readFile(path,'utf8'));assert.equal(lifecycle.error,undefined);
  for(const [name,value] of Object.entries(lifecycle)){if(name!=='nativeTrayClicksTested')assert.equal(value,true,name);}
  evidence.actualExeLifecycle=lifecycle;
  await waitFor(()=>form.exitCode!==null,'Explicit Quit did not close EXE');evidence.actualExplicitQuitClosed=true;
  await writeFile(join(source,'docs/verification/connector-tray-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  form?.kill();connector?.kill();unrelated?.kill();await control.pause();
  for(const socket of sockets.clients)socket.terminate();await new Promise(r=>sockets.close(r));await new Promise(r=>hub.close(r));await new Promise(r=>bridge.close(r));
  const uninstall=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'deploy/uninstall-connector.ps1'),'-Root',root],{windowsHide:true,encoding:'utf8',timeout:30000});assert.equal(uninstall.status,0,uninstall.stderr);
  await rm(root,{recursive:true,force:true});
}
