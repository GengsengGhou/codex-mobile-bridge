import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnectorControl, readConnectorControl, connectorMayRun, createCompanionRegistration, stopOwnedConnectorProcesses } from '../scripts/connector-control.mjs';
import { guiCommand } from '../scripts/connector-gui.mjs';

async function fixture(t, options={}) {
  const root=await mkdtemp(join(tmpdir(),'connector-control-')); t.after(()=>rm(root,{recursive:true,force:true}));
  let login='first', enabled=options.enabled===true;
  const registration={read:async()=>({enabled}),set:async value=>{enabled=value;return {enabled};}};
  const control=createConnectorControl({root,registration,session:async()=>login,stop:options.stop|| (async()=>({stopped:true}))});
  return {root,control,setLogin:value=>{login=value;}};
}
test('fresh GUI is manual; migration retains owned auto; login uses authentication identity',async t=>{
  const f=await fixture(t); assert.equal((await f.control.initialize()).autoStart,false);
  await f.control.resume('manual'); await f.control.configure(true); await f.control.pause();
  assert.equal((await f.control.resume('startup')).paused,true);
  f.setLogin('second'); assert.equal((await f.control.resume('startup')).paused,false);
  await f.control.pause(); assert.equal((await f.control.resume('manual')).paused,false);
  const old=await fixture(t,{enabled:true}); assert.equal((await old.control.initialize()).autoStart,true);
});
test('pause is durable before owned stop, failure remains paused/unverified',async t=>{
  let f;
  f=await fixture(t,{stop:async({root})=>{assert.equal((await readConnectorControl(root)).paused,true);throw Error('fixture stop failure');}});
  await f.control.initialize(); await assert.rejects(f.control.pause(),/fixture stop failure/);
  const state=await f.control.read(); assert.equal(state.paused,true);assert.equal(state.disconnectVerified,false);
  assert.equal(await connectorMayRun(f.root),false);assert.match(state.lastError,/fixture stop failure/);
});
test('corrupt intent fails closed and manual repair does not create runtime authorization',async t=>{
  const f=await fixture(t); await mkdir(join(f.root,'.local')); await writeFile(join(f.root,'.local/connector-control.json'),'{broken');
  await assert.rejects(connectorMayRun(f.root),/禁止自动连接/); await assert.rejects(f.control.resume('startup'),/禁止自动连接/);
  assert.equal((await f.control.resume('manual')).paused,false);
  await assert.rejects(readFile(join(f.root,'.local/connector-login.json')),/ENOENT/);
});
test('late successful pair preserves credentials and bootstrap marker while respecting pause',async t=>{
  const f=await fixture(t); await f.control.initialize();
  let release; const waiting=new Promise(r=>{release=r;}); let entered;const started=new Promise(r=>{entered=r;});let registered=false,watched=false,saved=false;
  const pair=guiCommand({action:'pair',origin:'https://example.com',code:'x'.repeat(43),name:'Fixture'},{root:f.root,control:f.control,read:async()=>null,choosePort:async()=>4317,pair:async()=>{entered();await waiting;saved=true;return {deviceId:'fixture'};},registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,true);assert.equal(opts.registerStartup,false);registered=true;},watch:async()=>{watched=true;}});
  await started;await f.control.pause();release();const result=await pair;
  assert.equal(result.paused,true);assert.equal(saved,true);assert.equal(registered,true);assert.equal(watched,false);
});
test('connect completion after pause cannot launch a watcher; autostart toggle does not resume',async t=>{
  const f=await fixture(t);await f.control.initialize();let release;const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);let launched=false;
  const connecting=guiCommand({action:'connect'},{root:f.root,control:f.control,read:async()=>({bridgePort:4317}),registerDeferred:async()=>{entered();await gate;},watch:async()=>{launched=true;}});
  await ready;await f.control.pause();await f.control.configure(true);release();assert.equal((await connecting).paused,true);assert.equal(launched,false);
  assert.equal((await f.control.read()).paused,true);
});
test('kernel mutex is recoverable after a killed request and serializes concurrent actions',async t=>{
  const f=await fixture(t);
  if(process.platform==='win32') {
    const worker=spawn(process.execPath,['--input-type=module','-e',`import {createConnectorControl} from ${JSON.stringify(new URL('../scripts/connector-control.mjs',import.meta.url).href)};await createConnectorControl({root:${JSON.stringify(f.root)},registration:{read:async()=>{console.log('held');await new Promise(()=>{});},set:async()=>{}},session:async()=> 'fixture'}).initialize();`],{windowsHide:true});
    worker.stderr.resume(); await new Promise((resolve,reject)=>{worker.stdout.once('data',resolve);worker.once('error',reject);worker.once('exit',code=>reject(Error('worker exited '+code)));});
    const exited=new Promise(r=>worker.once('exit',r));worker.kill();await exited;
  }
  assert.equal((await f.control.initialize()).autoStart,false);
  await Promise.all([f.control.configure(true),f.control.pause()]);
  const state=await f.control.read();assert.equal(state.autoStart,true);assert.equal(state.paused,true);assert.equal(state.disconnectVerified,true);
});
test('startup migration and stop commands require exact installation ownership',async()=>{
  const scripts=[];const execute=async(_file,args)=>{scripts.push(Buffer.from(args.at(-1),'base64').toString('utf16le'));return {stdout:'{"enabled":true,"stopped":true}'};};
  const root='C:/fixture/connector';const registration=createCompanionRegistration({root,execute,registryKey:'HKCU:\\fixture-only'});await registration.read();await registration.set(false);await stopOwnedConnectorProcesses({root,nodePath:'C:/fixture/node.exe',execute});
  assert.match(scripts[1],/CommandLine|\$ownedLegacy/);assert.match(scripts[1],/Principal.UserId/);assert.match(scripts[1],/--tray/);
  assert.match(scripts[2],/ExecutablePath -ceq \$node/);assert.match(scripts[2],/connector-login\.mjs/);assert.match(scripts[2],/start-connector\.mjs/);assert.doesNotMatch(scripts[2],/scripts[\\/]start\.mjs|windows-supervisor/);
});
test('failed startup mutation cannot save or display successful preferences',async t=>{
  const root=await mkdtemp(join(tmpdir(),'connector-registration-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  let reject=true;
  const control=createConnectorControl({root,registration:{read:async()=>({enabled:true}),set:async enabled=>{if(reject)throw Error('fixture registry conflict');return {enabled};}},session:async()=> 'fixture'});
  await assert.rejects(control.initialize(),/fixture registry conflict/);assert.equal((await control.read()).autoStart,null);
  reject=false;assert.equal((await control.initialize()).autoStart,true);reject=true;
  await assert.rejects(control.configure(false),/fixture registry conflict/);assert.equal((await control.read()).autoStart,true);
});
test('legacy uninstall preserves identity but removed startup evidence leaves a manual default',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'.local'));
  await writeFile(join(f.root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath:process.execPath}));
  await writeFile(join(f.root,'.local/hub-connector.json'),JSON.stringify({version:1,hubOrigin:'https://example.com',deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'f'.repeat(43),bridgePort:4317}));
  assert.equal((await f.control.initialize()).autoStart,false);await assert.rejects(readFile(join(f.root,'.local/runtime.json')),/ENOENT/);
});
