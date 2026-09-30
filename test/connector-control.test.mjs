import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createConnectorControl, readConnectorControl, connectorMayRun, createCompanionRegistration, stopOwnedConnectorProcesses } from '../scripts/connector-control.mjs';
import { guiCommand } from '../scripts/connector-gui.mjs';
import { registerConnectorLogonTask } from '../scripts/connector-login.mjs';

const executeFile = promisify(execFile);
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
async function powershell(script) {
  const { stdout } = await executeFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop'\n${script}`, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 });
  return stdout.trim();
}

async function fixture(t, options={}) {
  const root=await mkdtemp(join(tmpdir(),'connector-control-')); t.after(()=>rm(root,{recursive:true,force:true}));
  if(options.paired) { await mkdir(join(root,'.local'),{recursive:true}); await writeFile(join(root,'.local/hub-connector.json'),'{}'); }
  let login='first', enabled=options.enabled===true;
  const registration=options.registration||{read:async()=>({enabled}),set:async value=>{enabled=value;return {enabled};}};
  const control=createConnectorControl({root,registration,session:async()=>login,stop:options.stop|| (async()=>({stopped:true}))});
  return {root,control,setLogin:value=>{login=value;}};
}
test('unpaired GUI defers login registration; paired migration retains owned auto and login identity',async t=>{
  const f=await fixture(t); assert.equal((await f.control.initialize()).autoStart,false);
  assert.equal((await f.control.read()).autoStartSelected,false);
  await f.control.resume('manual'); await f.control.configure(true); await f.control.pause();
  assert.equal((await f.control.resume('startup')).paused,true);
  f.setLogin('second'); assert.equal((await f.control.resume('startup')).paused,false);
  await f.control.pause('persistent'); f.setLogin('third'); assert.equal((await f.control.resume('startup')).pauseScope,'persistent'); assert.equal((await f.control.read()).paused,true);
  assert.equal((await f.control.resume('manual')).paused,false);
  const old=await fixture(t,{enabled:true,paired:true}); assert.equal((await old.control.initialize()).autoStart,true);
});
test('session exit cannot downgrade a persistent disconnect; manual connect clears it',async t=>{
  const f=await fixture(t,{enabled:true,paired:true}); await f.control.initialize();
  await f.control.resume('manual'); await f.control.pause('persistent');
  await f.control.pause('session');
  assert.equal((await f.control.read()).pauseScope,'persistent');
  f.setLogin('second'); assert.equal((await f.control.resume('startup')).paused,true);
  assert.equal((await f.control.resume('manual')).paused,false);
});
test('reopening a paired installation restores the selected Windows login preference',async t=>{
  let registered=false, writes=0;
  const registration={read:async()=>({enabled:registered}),set:async value=>{registered=value;writes++;return {enabled:registered};}};
  const f=await fixture(t,{paired:true,registration});
  await f.control.initialize();
  await f.control.configure(true);
  assert.equal(registered,true);
  registered=false;
  await f.control.initialize();
  assert.equal(registered,true);
  assert.equal(writes,2);
  await f.control.configure(false);
  registered=true;
  await f.control.initialize();
  assert.equal(registered,false);
  assert.equal(writes,4);
  assert.equal((await f.control.read()).autoStart,false);
});
test('successful first pairing selects login startup unless the user chose a preference before pairing',async t=>{
  const f=await fixture(t); const initial=await f.control.initialize();
  await mkdir(join(f.root,'.local'),{recursive:true}); await writeFile(join(f.root,'.local/hub-connector.json'),'{}');
  const completed=await f.control.completePairing(initial.revision,initial.settingsRevision,{newPair:true});
  assert.equal(completed.intent.autoStart,true); assert.equal(completed.intent.autoStartSelected,true);
  const optedOut=await fixture(t); const before=await optedOut.control.initialize(); await optedOut.control.configure(false);
  await mkdir(join(optedOut.root,'.local'),{recursive:true}); await writeFile(join(optedOut.root,'.local/hub-connector.json'),'{}');
  const retained=await optedOut.control.completePairing(before.revision,before.settingsRevision,{newPair:true});
  assert.equal(retained.intent.autoStart,false); assert.equal(retained.intent.autoStartSelected,true);
});
test('failed first-pair startup registration persists the default choice and retry completes only pending effects',async t=>{
  let calls=0,enabled=false;
  const registration={read:async()=>({enabled}),set:async value=>{calls++;if(calls===1)throw Error('fixture startup registration failure');enabled=value;return {enabled};}};
  const f=await fixture(t,{registration});const before=await f.control.initialize();
  await mkdir(join(f.root,'.local'),{recursive:true});await writeFile(join(f.root,'.local/hub-connector.json'),'{}');
  await assert.rejects(f.control.completePairing(before.revision,before.settingsRevision,{newPair:true}),/startup registration failure/);
  const saved=await f.control.read();assert.equal(saved.autoStart,true);assert.equal(saved.autoStartSelected,true);assert.equal(saved.startupPending,true);assert.equal(saved.bootstrapPending,true);
  const reopened=await createConnectorControl({root:f.root,registration,session:async()=>'first'}).initialize();
  assert.equal(reopened.autoStart,true);assert.equal(reopened.startupPending,true);
  const recovered=await f.control.resume('manual');
  const final=await f.control.finishStartupRegistration(recovered.revision);
  const bootstrap=await f.control.finishBootstrapEnrollment(final.revision);
  assert.equal(bootstrap.autoStart,true);assert.equal(bootstrap.startupPending,false);assert.equal(bootstrap.bootstrapPending,false);assert.equal(enabled,true);assert.equal(calls,2);
});
test('explicitly disabled first-pair recovery remains disabled through registration failure and retry',async t=>{
  let calls=0,enabled=false;
  const registration={read:async()=>({enabled}),set:async value=>{calls++;if(calls===1)throw Error('fixture startup registration failure');enabled=value;return {enabled};}};
  const f=await fixture(t,{registration});const before=await f.control.initialize();await f.control.configure(false);
  await mkdir(join(f.root,'.local'),{recursive:true});await writeFile(join(f.root,'.local/hub-connector.json'),'{}');
  await assert.rejects(f.control.completePairing(before.revision,before.settingsRevision,{newPair:true}),/startup registration failure/);
  const saved=await f.control.read();assert.equal(saved.autoStart,false);assert.equal(saved.autoStartSelected,true);assert.equal(saved.startupPending,true);
  const reopened=await createConnectorControl({root:f.root,registration,session:async()=>'first'}).initialize();assert.equal(reopened.autoStart,false);
  const recovered=await f.control.resume('manual');const final=await f.control.finishStartupRegistration(recovered.revision);
  assert.equal(final.autoStart,false);assert.equal(final.startupPending,false);assert.equal(enabled,false);assert.equal(calls,2);
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
test('late successful pair preserves credentials while respecting pause and deferring bootstrap authorization',async t=>{
  const f=await fixture(t); await f.control.initialize();
  let release; const waiting=new Promise(r=>{release=r;}); let entered;const started=new Promise(r=>{entered=r;});let registered=false,watched=false,saved=false;
  const pair=guiCommand({action:'pair',origin:'https://example.com',code:'x'.repeat(43),name:'Fixture'},{root:f.root,control:f.control,read:async()=>null,choosePort:async()=>4317,pair:async()=>{entered();await waiting;saved=true;return {deviceId:'fixture'};},registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,true);assert.equal(opts.registerStartup,false);registered=true;},watch:async()=>{watched=true;}});
  await started;await f.control.pause('persistent');release();const result=await pair;
  assert.equal(result.paused,true);assert.equal(result.persistentPaused,true);assert.equal(result.recoveryCompleted,false);assert.equal(saved,true);assert.equal(registered,false);assert.equal(watched,false);
});
test('autostart preference changes during pair are retained without cancelling the current session connection',async t=>{
  const f=await fixture(t);const initial=await f.control.initialize();
  let release;const waiting=new Promise(r=>{release=r;});let entered;const started=new Promise(r=>{entered=r;});let watched=false;
  const pairing=guiCommand({action:'pair',origin:'https://example.com',code:'x'.repeat(43),name:'Fixture'},{root:f.root,control:f.control,read:async()=>null,choosePort:async()=>4317,pair:async()=>{entered();await waiting;await mkdir(join(f.root,'.local'),{recursive:true});await writeFile(join(f.root,'.local/hub-connector.json'),'{}');return {deviceId:'fixture'};},registerDeferred:async()=>{},watch:async()=>{watched=true;return {pid:42};}});
  await started;await f.control.configure(false);release();const result=await pairing;
  assert.equal(result.autoStart,false);assert.equal(result.paused,false);assert.equal(result.recoveryCompleted,true);assert.equal(watched,true);
  const intent=await f.control.read();assert.equal(intent.autoStart,false);assert.equal(intent.autoStartSelected,true);assert.equal(intent.paused,false);assert.equal(intent.revision===initial.revision,false);
});
test('connect completion after pause cannot launch a watcher; autostart toggle does not resume',async t=>{
  const f=await fixture(t);await f.control.initialize();let release;const gate=new Promise(r=>release=r);let entered;const ready=new Promise(r=>entered=r);let launched=false;
  const connecting=guiCommand({action:'connect'},{root:f.root,control:f.control,read:async()=>({bridgePort:4317}),registerDeferred:async()=>{entered();await gate;},watch:async()=>{launched=true;}});
  await ready;await f.control.pause();await f.control.configure(true);release();assert.equal((await connecting).paused,true);assert.equal(launched,false);
  assert.equal((await f.control.read()).paused,true);
});
test('kernel mutex is recoverable after a killed request and serializes concurrent actions',async t=>{
  const f=await fixture(t,{paired:true});
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
test('normalized Windows task principal is removed by migration and uninstall', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector-task-owner-'));
  const task = await registerConnectorLogonTask({ root });
  const taskName = task.name;
  const taskArguments = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${join(root, 'scripts', 'connector-login.ps1')}"`;
  const taskPresent = async () => (await powershell(`$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $found=$false; foreach($entry in $service.GetFolder('\\').GetTasks(0)){if($entry.Name -ceq ${literal(taskName)}){$found=$true}}; if($found){'present'}else{'absent'}`)) === 'present';
  try {
    const registration = createCompanionRegistration({ root });
    assert.equal((await registration.read()).enabled, true);
    assert.equal((await registration.set(false)).enabled, false);
    assert.equal(await taskPresent(), false);
    await registerConnectorLogonTask({ root });
    await writeFile(join(root, 'installed.json'), JSON.stringify({ root, version: 1 }));
    await powershell(`& ${literal(fileURLToPath(new URL('../deploy/uninstall-connector.ps1', import.meta.url)))} -Root ${literal(root)}`);
    assert.equal(await taskPresent(), false);
  } finally {
    await powershell(`$service=New-Object -ComObject 'Schedule.Service'; $service.Connect(); $folder=$service.GetFolder('\\'); foreach($entry in $folder.GetTasks(0)){if($entry.Name -ceq ${literal(taskName)} -and $entry.Definition.Actions.Count -eq 1 -and $entry.Definition.Actions.Item(1).Arguments -ceq ${literal(taskArguments)}){$folder.DeleteTask(${literal(taskName)},0)}}`);
    await rm(root, { recursive: true, force: true });
  }
});
test('failed startup preference change cannot save or display a successful choice',async t=>{
  const root=await mkdtemp(join(tmpdir(),'connector-registration-failure-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'.local'),{recursive:true});await writeFile(join(root,'.local/hub-connector.json'),'{}');
  let reject=true;
  const control=createConnectorControl({root,registration:{read:async()=>({enabled:true}),set:async enabled=>{if(reject)throw Error('fixture registry conflict');return {enabled};}},session:async()=> 'fixture'});
  assert.equal((await control.initialize()).autoStart,true);assert.equal((await control.read()).autoStartSelected,true);reject=true;
  await assert.rejects(control.configure(false),/fixture registry conflict/);assert.equal((await control.read()).autoStart,true);
});
test('legacy uninstall preserves identity but removed startup evidence leaves a manual default',async t=>{
  const f=await fixture(t);await mkdir(join(f.root,'.local'));
  await writeFile(join(f.root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath:process.execPath}));
  await writeFile(join(f.root,'.local/hub-connector.json'),JSON.stringify({version:1,hubOrigin:'https://example.com',deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'f'.repeat(43),bridgePort:4317}));
  assert.equal((await f.control.initialize()).autoStart,false);await assert.rejects(readFile(join(f.root,'.local/runtime.json')),/ENOENT/);
});
