import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, cp, symlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { readPrivate, writePrivate } from '../scripts/collaboration-common.mjs';
import { disableCollaborationForUninstall } from '../scripts/collaboration-lifecycle.mjs';
import { restoreConnectorLogin } from '../scripts/connector-login.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const base = resolve(repository, 'work/collaboration-pairing-diagnosis');
const id = '11111111-1111-4111-8111-111111111111';
const config = { version: 1, hubOrigin:'https://fixture.invalid',deviceId:id,deviceToken:'a'.repeat(43),bridgePort:4339 };
const policy = { version:1,hubOrigin:config.hubOrigin,deviceId:id,controlEnabled:false,receiveEnabled:false,requiresAuthorization:true,allowedDeviceIds:[],allowedProjectRoots:[] };
async function fixture(t) {
  await mkdir(base,{recursive:true});
  const root = await mkdtemp(resolve(base,'lifecycle-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writePrivate(resolve(root,'.local/hub-connector.json'),config);
  await writePrivate(resolve(root,'.local/computer-collaboration.json'),policy);
  return root;
}
function childRpc(t,root) {
  const moduleUrl = new URL('../scripts/collaboration-mcp.mjs',import.meta.url).href;
  const child = spawn(process.execPath,['--input-type=module','-e',`import {serveMcp} from ${JSON.stringify(moduleUrl)};serveMcp({root:${JSON.stringify(root)}});`],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const exited = new Promise(yes=>child.once('exit',(code,signal)=>yes({code,signal})));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;});
  const waiters = new Map();let buffer='',serial=0;
  child.stdout.on('data',bytes=>{buffer+=bytes;while(buffer.includes('\n')){const at=buffer.indexOf('\n');const response=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);waiters.get(response.id)?.(response);}});
  const rpc = (method,params={})=>new Promise((yes,no)=>{const requestId=++serial;const timer=setTimeout(()=>{waiters.delete(requestId);no(Error('Fixture MCP timeout'));},4000);waiters.set(requestId,response=>{clearTimeout(timer);waiters.delete(requestId);yes(response);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})+'\n');});
  return {child,exited,rpc};
}
async function eventually(fn) {
  const deadline=Date.now()+5000;
  while(!await fn()){assert.ok(Date.now()<deadline,'Isolated state transition timed out');await new Promise(yes=>setTimeout(yes,25));}
}

test('authorization-required MCP stays alive and rejects tools without dispatch, then accepts an explicit new policy', async t=>{
  const root=await fixture(t), {rpc,child}=childRpc(t,root);
  await rpc('initialize');
  await new Promise(yes=>setTimeout(yes,1200));
  assert.equal(child.exitCode,null);
  for(const [name,args] of [['collaboration_devices',{}],['collaboration_create',{deviceId:'22222222-2222-4222-8222-222222222222',projectId:'fixture',prompt:'Not dispatched'}]]) {
    const response=await rpc('tools/call',{name,arguments:args});
    assert.equal(response.result.isError,true);
    const error=JSON.parse(response.result.content[0].text);
    assert.equal(error.code,'COLLABORATION_BINDING_CHANGED');assert.match(error.error,/重新选择电脑和项目/);
  }
  assert.equal((await readdir(resolve(root,'.local'))).includes('collaboration-outbox'),false);
  await writePrivate(resolve(root,'.local/computer-collaboration.json'),{...policy,requiresAuthorization:false,controlEnabled:true});
  await new Promise(yes=>setTimeout(yes,1100));
  assert.deepEqual((await rpc('ping')).result,{});
  await writePrivate(resolve(root,'.local/computer-collaboration.json'),{...policy,requiresAuthorization:false});
  await eventually(()=>child.exitCode!==null);
  assert.equal(child.exitCode,0);
});

test('authorization-required exception does not keep MCP alive during explicit pause, upgrade, or uninstall', async t=>{
  for(const action of ['pause','upgrade','uninstall'])await t.test(action,async childTest=>{
    const root=await fixture(childTest), {rpc,child}=childRpc(childTest,root);
    await rpc('initialize');
    if(action==='pause')await writePrivate(resolve(root,'.local/connector-control.json'),{version:2,paused:true,pauseScope:'persistent',pausedSession:null,autoStart:false,autoStartSelected:true,revision:'paused-fixture',settingsRevision:'fixture',disconnectVerified:true});
    if(action==='upgrade')await writePrivate(root+'.upgrade-journal.json',{fixture:true});
    if(action==='uninstall')await disableCollaborationForUninstall({root,register:async()=>({status:'disabled'})});
    await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
    if(action==='upgrade')await rm(root+'.upgrade-journal.json');
  });
});

test('watcher does not retain an old-identity or unbound heartbeat as a healthy current connector', async t=>{
  const root=await fixture(t);
  await writePrivate(resolve(root,'.local/runtime.json'),{callerThreadId:id,allowedSendThreadId:id,enableSend:true,sendScope:'all-local',port:4339});
  for(const identity of [{hubOrigin:'https://previous.invalid',deviceId:id},{}]) {
    await writePrivate(resolve(root,'.local/hub-connector-state.json'),{...identity,state:'online',updatedAt:new Date().toISOString()});
    const controller=new AbortController();let launches=0;
    await restoreConnectorLogin({root,monitor:true,signal:controller.signal,probe:async()=>({connected:true}),output:{log(){}},launch:async()=>{launches++;return{pid:123};},sleep:async()=>controller.abort()});
    assert.equal(launches,1);
  }
});

test('slow settings registration preserves MCP transport, blocks dispatch, and recovers without restarting', async t=>{
  const root=await fixture(t);let requests=0;
  const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({version:1,sourceDeviceId:id,devices:[]}));});
  await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
  t.after(async()=>{server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const bound={...config,hubOrigin:`http://127.0.0.1:${server.address().port}`,allowInsecureLocal:true};
  await writePrivate(resolve(root,'.local/hub-connector.json'),bound);
  // Exercise recovery of an interrupted prior save as well as a normal slow save.
  await writePrivate(resolve(root,'.local/computer-collaboration.json'),{...policy,hubOrigin:bound.hubOrigin,requiresAuthorization:false,controlEnabled:false,controlPending:true});
  const {rpc,child}=childRpc(t,root);await rpc('initialize');
  let release,entered;
  const gate=new Promise(yes=>{release=yes;}),registrationEntered=new Promise(yes=>{entered=yes;});
  const command={action:'save-collaboration',controlEnabled:true,receiveEnabled:false,allowedDeviceIds:[],allowedProjectRoots:[]};
  const deps={root,bridge:async()=>({projects:[]}),register:async()=>{entered();await gate;return{status:'ready',reloadRequired:false};}};
  const saving=collaborationSettings(command,deps);
  await registrationEntered;
  await new Promise(yes=>setTimeout(yes,1200));
  assert.equal(child.exitCode,null);assert.deepEqual((await rpc('ping')).result,{});
  const before=requests;
  for(const [name,args] of [['collaboration_devices',{}],['collaboration_create',{deviceId:'22222222-2222-4222-8222-222222222222',projectId:'fixture',prompt:'Not dispatched'}]]) {
    const response=await rpc('tools/call',{name,arguments:args});assert.equal(response.result.isError,true);
    assert.equal(JSON.parse(response.result.content[0].text).code,'COLLABORATION_SETTINGS_PENDING');
  }
  assert.equal(requests,before);assert.equal((await readdir(resolve(root,'.local'))).includes('collaboration-outbox'),false);
  release();const saved=await saving;
  assert.equal(saved.collaboration.controlEnabled,true);assert.equal(Object.hasOwn(saved.collaboration,'controlPending'),false);assert.equal(saved.collaboration.registration.status,'ready');
  await new Promise(yes=>setTimeout(yes,1100));
  const recovered=await rpc('tools/call',{name:'collaboration_devices',arguments:{}});assert.notEqual(recovered.result.isError,true);assert.deepEqual(JSON.parse(recovered.result.content[0].text).devices,[]);
  assert.ok(requests>before);assert.equal(child.exitCode,null);
  await collaborationSettings({...command,controlEnabled:false},{...deps,register:async()=>({status:'disabled'})});
  await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
});

test('failed registration keeps MCP actionable until explicit disable, even if cleanup also conflicts', async t=>{
  const root=await fixture(t);
  await writePrivate(resolve(root,'.local/computer-collaboration.json'),{...policy,requiresAuthorization:false,controlEnabled:true});
  const {rpc,child}=childRpc(t,root);await rpc('initialize');
  await assert.rejects(collaborationSettings({action:'save-collaboration',controlEnabled:true,receiveEnabled:false,allowedDeviceIds:[],allowedProjectRoots:[]},{root,fetchImpl:async()=>new Response(JSON.stringify({version:1,sourceDeviceId:id,devices:[]}),{headers:{'content-type':'application/json'}}),bridge:async()=>({projects:[]}),register:async()=>{await new Promise(yes=>setTimeout(yes,1200));throw Object.assign(Error('Fixture owned MCP entry has changed; check connector settings.'),{code:'MCP_REGISTRATION_CONFLICT'});}}),error=>error.code==='MCP_REGISTRATION_CONFLICT');
  await new Promise(yes=>setTimeout(yes,1100));assert.equal(child.exitCode,null);
  const response=await rpc('tools/call',{name:'collaboration_devices',arguments:{}});assert.equal(response.result.isError,true);
  const error=JSON.parse(response.result.content[0].text);assert.equal(error.code,'MCP_REGISTRATION_CONFLICT');assert.match(error.error,/owned MCP entry/);assert.notEqual(error.code,'COLLABORATION_BINDING_CHANGED');
  assert.equal((await readPrivate(resolve(root,'.local/computer-collaboration.json'))).controlEnabled,false);
  await assert.rejects(collaborationSettings({action:'save-collaboration',controlEnabled:false,receiveEnabled:false,allowedDeviceIds:[],allowedProjectRoots:[]},{root,register:async()=>{await new Promise(yes=>setTimeout(yes,1200));throw Object.assign(Error('Fixture cleanup conflict'),{code:'MCP_REGISTRATION_CONFLICT'});}}),error=>error.code==='MCP_REGISTRATION_CONFLICT');
  await eventually(()=>child.exitCode!==null);assert.equal(child.exitCode,0);
});

test('actual daemon publishes its captured identity and exits when pairing is replaced on disk', async t=>{
  const root=await fixture(t);
  for(const directory of ['scripts','src','hub'])await cp(resolve(repository,directory),resolve(root,directory),{recursive:true});
  await symlink(resolve(repository,'node_modules'),resolve(root,'node_modules'),'junction');
  const server=createServer((_request,response)=>{response.writeHead(200,{'set-cookie':'bridge_session='+'a'.repeat(64)+'; Path=/'});response.end('fixture');});
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(request,socket,head)=>wss.handleUpgrade(request,socket,head,ws=>wss.emit('connection',ws,request)));
  await new Promise(yes=>server.listen(0,'127.0.0.1',yes));
  t.after(async()=>{for(const ws of wss.clients)ws.terminate();await new Promise(yes=>wss.close(yes));server.closeAllConnections();await new Promise(yes=>server.close(yes));});
  const bound={...config,hubOrigin:`http://127.0.0.1:${server.address().port}`,bridgePort:server.address().port,allowInsecureLocal:true};
  const configPath=resolve(root,'.local/hub-connector.json'),statePath=resolve(root,'.local/hub-connector-state.json');
  await writePrivate(configPath,bound);
  const child=spawn(process.execPath,[resolve(root,'scripts/start-connector.mjs')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  const exited=new Promise(yes=>child.once('exit',code=>yes(code)));
  t.after(async()=>{if(child.exitCode===null)child.kill();await exited;});
  await eventually(async()=>{try{return (await readPrivate(statePath))?.connected===true;}catch{return false;}});
  const heartbeat=await readPrivate(statePath);assert.equal(heartbeat.hubOrigin,bound.hubOrigin);assert.equal(heartbeat.deviceId,bound.deviceId);assert.equal(Object.hasOwn(heartbeat,'deviceToken'),false);
  await writePrivate(configPath,{...bound,deviceId:'22222222-2222-4222-8222-222222222222',deviceToken:'b'.repeat(43)});
  await eventually(()=>child.exitCode!==null);assert.equal(await exited,0);
  const stopped=JSON.parse(await readFile(statePath,'utf8'));assert.equal(stopped.state,'stopped');assert.equal(stopped.deviceId,bound.deviceId);
});
