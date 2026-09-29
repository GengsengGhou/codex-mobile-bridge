import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guiCommand as realGuiCommand } from '../scripts/connector-gui.mjs';
import { pairConnector, parsePairingInformation } from '../scripts/setup-connector.mjs';
import { createConnectorControl } from '../scripts/connector-control.mjs';
import { registerDeferredConnectorLogin } from '../scripts/connector-login.mjs';

test('native host restricts page resources and host commands while passive reads have their own guard',async()=>{
  const source=await readFile(new URL('../deploy/windows/WebViewConnector.cs',import.meta.url),'utf8');
  assert.match(source,/e.Source!=Page/);assert.match(source,/AreHostObjectsAllowed=false/);
  assert.match(source,/CoreWebView2HostResourceAccessKind.DenyCors/);
  const refresh=source.slice(source.indexOf('async Task RefreshStatus()'),source.indexOf('void Fields('));
  assert.match(refresh,/statusReadInFlight/);assert.match(refresh,/epoch!=actionEpoch/);
  assert.doesNotMatch(refresh,/SetBusy\(|Enabled=|\.Text=/);
  const wake=source.slice(source.indexOf('public void Wake()'),source.indexOf('public bool RecordUninstallIntent'));
  assert.doesNotMatch(wake,/Mutate\(|action="connect"/);
  assert.ok((await readFile(new URL('../deploy/windows/icons/LICENSE',import.meta.url),'utf8')).includes('Permission to use'));
});
const control = {
  read: async()=>({version:2,paused:false,pauseScope:'none',autoStart:false,autoStartSelected:false,revision:'fixture',settingsRevision:'settings'}),
  resume:async()=>({paused:false,pauseScope:'none',revision:'fixture'}), mayRun:async()=>true,
  completePairing:async()=>({superseded:false,intent:{paused:false,pauseScope:'none',autoStart:true,revision:'fixture'}}),
};
const guiCommand = (command,deps={}) => realGuiCommand(command,{control,...deps});
test('unpaired GUI status succeeds without probing a bridge or launching a controller',async()=>{
  let probed=false,launched=false;
  const status=await guiCommand({action:'status'},{read:async()=>null,probe:async()=>{probed=true;},watch:async()=>{launched=true;}});
  assert.equal(status.paired,false);assert.equal(status.bridgeConnected,false);assert.equal(status.state,'waiting');assert.equal(probed,false);assert.equal(launched,false);
});
test('GUI status preserves a control read failure instead of reporting checking or online',async()=>{
  await assert.rejects(guiCommand({action:'status'},{control:{read:async()=>{throw Error('intent fixture unreadable');}},read:async()=>null}),/intent fixture unreadable/);
});
test('GUI status reads fresh hub evidence after the Codex probe and keeps hub and local availability independent',async()=>{
  const calls=[];
  const status=await guiCommand({action:'status'},{read:async()=>({hubOrigin:'https://example.com',bridgePort:4317}),probe:async()=>{calls.push('probe');return null;},readState:async()=>{calls.push('state');return {state:'online',updatedAt:new Date().toISOString()};}});
  assert.deepEqual(calls,['probe','state']);assert.equal(status.bridgeConnected,false);assert.equal(status.hubConnected,true);assert.equal(status.hubState,'online');assert.equal(status.state,'waiting');
  for(const updatedAt of ['2000-01-01T00:00:00Z','2099-01-01T00:00:00Z','invalid']) {
    const stale=await guiCommand({action:'status'},{read:async()=>({bridgePort:4317}),probe:async()=>({connected:true}),readState:async()=>({state:'online',updatedAt})});
    assert.equal(stale.hubConnected,false);assert.equal(stale.hubState,'waiting');assert.equal(stale.bridgeConnected,true);
  }
});

test('pairing information validates strictly and validation result never exposes the code',async()=>{
  const code='p'.repeat(43), expiresAt=new Date(Date.now()+600000).toISOString();
  const information=JSON.stringify({type:'codex-mobile-pairing',version:1,server:'https://hub.example',code,name:'Work PC',expiresAt});
  const parsed=parsePairingInformation(information); assert.equal(parsed.server,'https://hub.example'); assert.equal(parsed.code,code);
  const validated=await guiCommand({action:'validate-pairing',information}); assert.deepEqual(validated,{origin:'https://hub.example',name:'Work PC',expiresAt}); assert.equal(JSON.stringify(validated).includes(code),false);
  for(const invalid of [
    '{"code":"'+code+'',
    JSON.stringify({type:'codex-mobile-pairing',version:1,server:'https://user:secret@hub.example',code,name:'PC',expiresAt}),
    JSON.stringify({type:'codex-mobile-pairing',version:1,server:'https://hub.example/path',code,name:'PC',expiresAt}),
    JSON.stringify({type:'codex-mobile-pairing',version:1,server:'https://hub.example/?x=1',code,name:'PC',expiresAt}),
    JSON.stringify({type:'codex-mobile-pairing',version:2,server:'https://hub.example',code,name:'PC',expiresAt}),
    JSON.stringify({type:'codex-mobile-pairing',version:1,server:'https://hub.example',code,name:'PC',expiresAt:'2000-01-01T00:00:00.000Z'}),
    'x'.repeat(4097),
  ]) { await assert.rejects(guiCommand({action:'validate-pairing',information:invalid}),error=>!error.message.includes(code)); }
});
test('invalid pairing information is rejected before reading or changing connector intent/config',async()=>{
  let read=false, paired=false, configured=false;
  const result=await guiCommand({action:'pair',information:'{"code":"private-code'}, {
    control:{read:async()=>{read=true;return {revision:'x',settingsRevision:'x'};},configure:async()=>{configured=true;},completePairing:async()=>{configured=true;}},
    read:async()=>{read=true;return null;},pair:async()=>{paired=true;}
  }).then(()=>null,error=>error);
  assert.ok(result instanceof Error); assert.equal(read,false); assert.equal(paired,false); assert.equal(configured,false); assert.equal(result.message.includes('private-code'),false);
});

test('first GUI pairing registers deferred login and starts persistent watcher before Codex exists', async () => {
  const calls=[];
  const paired=await guiCommand({ action:'pair', origin:'https://example.com', code:'x'.repeat(43), name:'PC' }, {
    read:async()=>null, choosePort:async()=>4321,
    pair:async opts=>{ calls.push('pair'); assert.equal(opts.bridgePort,4321); assert.equal(opts.pairingCode,'x'.repeat(43)); return {deviceId:'fixture'}; },
    registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,true);calls.push('register');},watch:async()=>calls.push('watcher')
  });
  assert.equal(paired.state,'waiting'); assert.deepEqual(calls,['pair','register','watcher']);
  await guiCommand({action:'connect'}, {read:async()=>({bridgePort:4321}),registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,undefined);calls.push('register');},watch:async()=>calls.push('watcher')});
  assert.deepEqual(calls,['pair','register','watcher','register','watcher']);
});
test('failed login registration does not launch an unmanaged watcher',async()=>{
  let launched=false;
  await assert.rejects(guiCommand({action:'connect'},{read:async()=>({bridgePort:4321}),registerDeferred:async()=>{throw Error('Registration failed');},watch:async()=>{launched=true;}}),/Registration failed/);
  assert.equal(launched,false);
});
test('replacement requires deliberate choice and rejected fixture pairing preserves previous credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-gui-fixture-'));
  const configPath=join(dir,'pair.json'); const original=JSON.stringify({version:1,hubOrigin:'https://old.example',bridgePort:4321,deviceId:'old',deviceToken:'secret-fixture'});
  await writeFile(configPath,original);
  const server=createServer((req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Pairing code expired'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    await assert.rejects(guiCommand({action:'pair',origin:'https://new.example',code:'x'.repeat(43)},{configPath}),/已有设备配对/);
    let stopped=false;
    await assert.rejects(guiCommand({action:'pair',replace:true,origin:`http://127.0.0.1:${server.address().port}`,code:'x'.repeat(43),name:'Fixture'},{configPath,allowInsecureLocal:true,pair:opts=>pairConnector({...opts,allowInsecureLocal:true}),stopPrevious:async()=>{stopped=true;}}),/配对失败/);
    assert.equal(await readFile(configPath,'utf8'),original); assert.equal(stopped,false);
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('successful fixture pairing writes credentials privately and status never returns token',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-gui-success-')); const configPath=join(dir,'pair.json');
  const token='t'.repeat(43), id='11111111-1111-4111-8111-111111111111';
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({deviceId:id,deviceToken:token}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const result=await guiCommand({action:'pair',origin:`http://127.0.0.1:${server.address().port}`,code:'c'.repeat(43),name:'Fixture'}, {configPath,allowInsecureLocal:true,choosePort:async()=>4321,pair:opts=>pairConnector({...opts,allowInsecureLocal:true}),registerDeferred:async()=>{},watch:async()=>{}});
    assert.equal(result.deviceId,id); assert.equal(JSON.stringify(result).includes(token),false);
    assert.equal(JSON.parse(await readFile(configPath,'utf8')).deviceToken,token);
    const status=await guiCommand({action:'status'},{configPath,probe:async()=>null}); assert.equal(status.deviceId,id); assert.equal(status.bridgeConnected,false); assert.equal(status.state,'waiting'); assert.equal(JSON.stringify(status).includes(token),false);
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('pairing returns explicit partial success after credential persistence when background setup fails',async()=>{
  let watched=false;
  const result=await guiCommand({action:'pair',origin:'https://example.com',code:'s'.repeat(43),name:'Fixture'},{
    read:async()=>null,choosePort:async()=>4321,pair:async()=>({deviceId:'fixture-device',hubOrigin:'https://example.com'}),
    registerDeferred:async()=>{throw Error('private internal detail');},watch:async()=>{watched=true;}
  });
  assert.equal(result.paired,true);assert.equal(result.partialSuccess,true);assert.equal(result.state,'partial');assert.equal(result.paused,false);assert.equal(result.recoveryCompleted,false);assert.match(result.warning,/请勿重复使用/);assert.equal(JSON.stringify(result).includes('private internal detail'),false);assert.equal(JSON.stringify(result).includes('s'.repeat(43)),false);assert.equal(watched,false);
});
test('first-pair registration failure keeps default intent and Connect retry repairs it without reenrollment',async t=>{
  const root=await mkdtemp(join(tmpdir(),'codex-pending-registration-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'.local');await mkdir(local,{recursive:true});const configPath=join(local,'hub-connector.json');
  let attempts=0,enabled=false,pairs=0,allowedBootstrap=false,watchers=0;
  const registration={read:async()=>({enabled}),set:async value=>{attempts++;if(attempts===1)throw Error('fixture startup registration failure');enabled=value;return {enabled};}};
  const lifecycle=createConnectorControl({root,registration,session:async()=>'fixture-login'});
  await lifecycle.initialize();
  const first=await realGuiCommand({action:'pair',origin:'https://example.com',code:'k'.repeat(43),name:'Fixture'}, {
    root,control:lifecycle,configPath,read:async()=>null,choosePort:async()=>4321,
    pair:async()=>{pairs++;await writeFile(configPath,JSON.stringify({version:1,hubOrigin:'https://example.com',bridgePort:4321,deviceId:'fixture',deviceToken:'x'.repeat(43)}));return {deviceId:'fixture'};},
    registerDeferred:async()=>{throw Error('must wait for explicit retry');},watch:async()=>{throw Error('must not start watcher');}
  });
  assert.equal(first.partialSuccess,true);assert.equal(first.recoveryCompleted,false);
  const stored=await lifecycle.read();assert.equal(stored.autoStart,true);assert.equal(stored.startupPending,true);assert.equal(stored.bootstrapPending,true);
  const reopened=await createConnectorControl({root,registration,session:async()=>'fixture-login'}).initialize();assert.equal(reopened.autoStart,true);
  const retry=await realGuiCommand({action:'connect'},{root,control:lifecycle,configPath,read:async()=>JSON.parse(await readFile(configPath,'utf8')),
    registerDeferred:async options=>{allowedBootstrap=options.allowBootstrap;return {};},watch:async()=>{watchers++;return {pid:17};}});
  assert.equal(retry.recoveryCompleted,true);assert.equal(allowedBootstrap,true);assert.equal(pairs,1);assert.equal(watchers,1);assert.equal(enabled,true);assert.equal(attempts,2);
  const final=await lifecycle.read();assert.equal(final.autoStart,true);assert.equal(final.startupPending,false);assert.equal(final.bootstrapPending,false);
});
test('enrollment finishing during persistent disconnect records pending bootstrap for later explicit Connect',async t=>{
  const root=await mkdtemp(join(tmpdir(),'codex-pair-pause-race-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const local=join(root,'.local');await mkdir(local,{recursive:true});await mkdir(join(root,'scripts'),{recursive:true});
  await writeFile(join(root,'scripts/connector-login.ps1'),'# fixture');
  const configPath=join(local,'hub-connector.json'),deviceId='11111111-1111-4111-8111-111111111111';
  const config={version:1,hubOrigin:'https://example.com',bridgePort:4321,deviceId,deviceToken:'t'.repeat(43)};
  let enabled=false,pairCalls=0,deferredCalls=0,watchers=0,releasePair,signalPair;
  const pairGate=new Promise(resolvePair=>{releasePair=resolvePair;});const pairEntered=new Promise(resolveEntered=>{signalPair=resolveEntered;});
  const registration={read:async()=>({enabled,conflict:false}),set:async value=>{enabled=value;return {enabled,conflict:false};},enable:async()=>{enabled=true;return {enabled:true,conflict:false};}};
  const control=createConnectorControl({root,registration,session:async()=>'fixture-login',stop:async()=>({stopped:true})});
  await control.initialize();
  const pairing=realGuiCommand({action:'pair',origin:'https://example.com',code:'r'.repeat(43),name:'Fixture'}, {
    root,control,configPath,read:async()=>null,choosePort:async()=>4321,
    pair:async()=>{pairCalls++;signalPair();await pairGate;await writeFile(configPath,JSON.stringify(config));return {deviceId};},
    registerDeferred:async()=>{throw Error('must wait while disconnected');},watch:async()=>{throw Error('must not start while disconnected');}
  });
  await pairEntered;await control.pause('persistent');releasePair();
  const result=await pairing;assert.equal(result.persistentPaused,true);assert.equal(result.recoveryCompleted,false);
  const staged=await control.read();assert.equal(staged.paused,true);assert.equal(staged.bootstrapPending,true);assert.equal(staged.startupPending,true);assert.equal(staged.autoStart,true);
  await assert.rejects(readFile(join(local,'connector-login.json')),{code:'ENOENT'});
  const retry=await realGuiCommand({action:'connect'},{root,control,configPath,read:async()=>JSON.parse(await readFile(configPath,'utf8')),
    registerDeferred:async options=>{deferredCalls++;assert.equal(options.allowBootstrap,true);return registerDeferredConnectorLogin({...options,platform:'win32',registration});},
    watch:async()=>{watchers++;return {pid:23};}});
  assert.equal(retry.recoveryCompleted,true);assert.equal(pairCalls,1);assert.equal(deferredCalls,1);assert.equal(watchers,1);assert.equal(enabled,true);
  const login=JSON.parse(await readFile(join(local,'connector-login.json'),'utf8'));assert.equal(login.bootstrap,true);
  assert.equal((await control.read()).bootstrapPending,false);
});
