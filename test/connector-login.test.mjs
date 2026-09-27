import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { registerConnectorLogin, registerDeferredConnectorLogin, launchConnectorLoginWatcher, restoreConnectorLogin, connectorLoginCommand, registerConnectorLogonTask } from '../scripts/connector-login.mjs';
import { selectOrdinaryLocalThread } from '../scripts/bootstrap-bridge.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const config = { version: 1, hubOrigin: 'https://hub.example.com', deviceId: id, deviceToken: 't'.repeat(43), bridgePort: 4339 };
const runtime = { callerThreadId: id, allowedSendThreadId: id, enableSend: true, sendScope: 'all-local', port: 4339 };
async function fixture(t, { withRuntime = true, withConnector = true } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'codex-login-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, '.local')); await mkdir(resolve(root, 'scripts'));
  await writeFile(resolve(root, 'scripts/connector-login.ps1'), '# test wrapper');
  if (withRuntime) await writeFile(resolve(root, '.local/runtime.json'), JSON.stringify(runtime));
  if (withConnector) await writeFile(resolve(root, '.local/hub-connector.json'), JSON.stringify(config));
  return root;
}

test('login starts the saved bridge before Codex readiness and launches connector only after recovery', async t => {
  const root = await fixture(t), steps = []; let probes = 0;
  const result = await restoreConnectorLogin({ root, output: { log() {} },
    probe: async () => { steps.push('probe'); return ++probes >= 3 ? { connected: true } : null; },
    verify: async () => { steps.push('verify'); return false; }, choosePort: async port => { steps.push('port'); return port; },
    start: async ({ loadConfig }) => { steps.push('start'); assert.deepEqual(await loadConfig(), runtime); return { started: true }; },
    sleep: async ms => { steps.push('wait'); assert.equal(ms, 10000); },
    launch: async options => { steps.push('connector'); assert.equal(options.instanceName, 'hub-connector'); assert.deepEqual(options.env, {}); return { pid: 123 }; },
  });
  assert.deepEqual(steps, ['probe', 'verify', 'port', 'start', 'probe', 'wait', 'probe', 'connector']);
  assert.deepEqual(result, { submitted: true, bridgePort: 4339, bridgeStarted: true, pid: 123 });
});

test('login reuses a healthy bridge without starting another listener or pairing', async t => {
  const root = await fixture(t); let launches = 0;
  const result = await restoreConnectorLogin({ root, probe: async () => ({ connected: true }),
    start: () => { throw new Error('must not start another bridge'); },
    launch: async () => { launches++; return { pid: 234 }; },
  });
  assert.equal(result.bridgeStarted, false); assert.equal(launches, 1);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/hub-connector.json'), 'utf8')), config);
});

test('unknown saved-port occupant prevents bridge and connector launch without changing runtime', async t => {
  const root = await fixture(t), controller = new AbortController(); let starts = 0, launches = 0;
  const result = await restoreConnectorLogin({ root, signal: controller.signal, output: { log() {} },
    probe: async () => null, verify: async () => false, choosePort: async () => 4440,
    start: async () => { starts++; }, launch: async () => { launches++; }, sleep: async () => controller.abort(),
  });
  assert.equal(result.cancelled, true); assert.equal(starts, 0); assert.equal(launches, 0);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/runtime.json'), 'utf8')), runtime);
});

test('startup registration refuses another command occupying its owned value', async t => {
  const root = await fixture(t); let writes = 0;
  await assert.rejects(registerConnectorLogin({ root, platform: 'win32', registration: { read: async () => ({ conflict: true }), enable: async () => { writes++; } } }), /其他命令/);
  assert.equal(writes, 0); await assert.rejects(readFile(resolve(root, '.local/connector-login.json')), { code: 'ENOENT' });
});

test('registration saves only runtime path and preserves existing scope and pairing credentials', async t => {
  const root = await fixture(t);
  const result = await registerConnectorLogin({ root, platform: 'win32', registration: { name: 'owned-test', read: async () => ({ conflict: false }), enable: async () => ({ enabled: true, conflict: false }) } });
  assert.equal(result.enabled, true);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/connector-login.json'), 'utf8')), { version: 1, nodePath: process.execPath });
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/runtime.json'), 'utf8')), runtime);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/hub-connector.json'), 'utf8')), config);
  assert.doesNotMatch(connectorLoginCommand(root), /deviceToken|hub-connector.json/);
});

test('registration remembers verified reused bridge settings when this install has no runtime file', async t => {
  const root = await fixture(t, { withRuntime: false });
  await registerConnectorLogin({ root, platform: 'win32',
    probe: async port => { assert.equal(port, 4339); return { callerThreadId: id, allowedSendThreadId: id, sendScope: 'single', connected: true }; },
    registration: { read: async () => ({ conflict: false }), enable: async () => ({ enabled: true, conflict: false }) },
  });
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/runtime.json'), 'utf8')), { ...runtime, sendScope: 'single' });
});

test('missing saved pairing fails without registration or unattended first setup', async t => {
  const root = await fixture(t, { withConnector: false }); let touched = false;
  await assert.rejects(registerConnectorLogin({ root, platform: 'win32', registration: { read: async () => { touched = true; } } }), { code: 'ENOENT' });
  await assert.rejects(restoreConnectorLogin({ root, probe: async () => { touched = true; } }), { code: 'ENOENT' });
  assert.equal(touched, false);
});

test('persistent login recovery retries failed launch, retains offline live connector, and restarts stale connector', async t => {
  const root = await fixture(t), controller = new AbortController();
  let launches = 0, waits = 0;
  const result = await restoreConnectorLogin({ root, monitor: true, signal: controller.signal,
    output: { log() {} }, probe: async () => ({ connected: true }), now: () => 10000,
    readState: async () => waits === 2 ? { state: 'offline', updatedAt: new Date(9500).toISOString() } : { state: 'online', updatedAt: new Date(0).toISOString() },
    launch: async () => { launches++; if (launches === 1) throw new Error('Transient WMI failure'); return { pid: 123 }; },
    sleep: async () => { if (++waits === 4) controller.abort(); },
  });
  assert.equal(result.cancelled, true);
  assert.equal(launches, 3);
});

test('persistent login recovery restores a bridge that exits after connector launch', async t => {
  const root = await fixture(t), controller = new AbortController();
  let waits = 0, starts = 0;
  await restoreConnectorLogin({ root, monitor: true, signal: controller.signal,
    output: { log() {} }, probe: async () => waits === 1 && starts === 0 ? null : { connected: true },
    verify: async () => false, choosePort: async port => port,
    start: async () => { starts++; return { started: true }; },
    readState: async () => ({}), launch: async () => ({ pid: 123 }),
    sleep: async () => { if (++waits === 2) controller.abort(); },
  });
  assert.equal(starts, 1);
});

test('logon task uses the current interactive user, retries at logon, and rejects foreign actions', async () => {
  let script;
  const result = await registerConnectorLogonTask({ root: "C:\\bridge's test", execute: async (_exe, args) => {
    script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    return { stdout: JSON.stringify({ enabled: true, name: 'test-task' }) };
  } });
  assert.equal(result.enabled, true);
  assert.match(script, /WindowsIdentity.*GetCurrent/);
  assert.match(script, /Principal.LogonType=3/);
  assert.match(script, /Principal.RunLevel=0/);
  assert.match(script, /Triggers.Create\(9\)/);
  assert.match(script, /ExecutionTimeLimit='PT0S'/);
  assert.match(script, /Actions.Count|actions.Count/);
  assert.match(script, /Arguments -cne \$arguments/);
  assert.match(script, /bridge''s test/);
});

test('explicit first pairing registers before Codex and logon watcher finishes bootstrap without a GUI', async t => {
  const root = await fixture(t, { withRuntime: false });
  let registrations = 0, attempts = 0, launches = 0, waits = 0;
  const registration = { read: async () => ({ conflict: false }), enable: async () => { registrations++; return { enabled: true }; } };
  const registered = await registerDeferredConnectorLogin({ root, platform: 'win32', allowBootstrap: true, registration });
  assert.equal(registered.pendingBootstrap, true); assert.equal(registrations, 1);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/connector-login.json'), 'utf8')), {version:1,nodePath:process.execPath,bootstrap:true});
  await assert.rejects(readFile(resolve(root, '.local/runtime.json')), {code:'ENOENT'});
  const controller = new AbortController();
  // This is a fresh logon invocation after the GUI has exited, using only saved files.
  await restoreConnectorLogin({ root, monitor:true, signal:controller.signal, output:{log(){}}, now:()=>10000,
    probe:async()=> attempts >= 3 ? {connected:true} : null, choosePort:async port=>port,
    bootstrap:async options=>{
      assert.equal(options.port,4339); assert.equal(options.selectThread,selectOrdinaryLocalThread);
      attempts++;
      if(attempts===1) throw Error('Codex is closed');
      if(attempts===2) throw Error('No ordinary local conversation yet');
      await writeFile(resolve(root,'.local/runtime.json'),JSON.stringify(runtime)); return {connected:true,port:4339};
    },
    finishBootstrap:options=>registerConnectorLogin({...options,platform:'win32',registration}),
    launch:async options=>{launches++;assert.equal(options.instanceName,'hub-connector');return {pid:123};},
    readState:async()=> launches ? {state:'online',updatedAt:new Date(10000).toISOString()} : {},
    sleep:async()=>{if(++waits===5)controller.abort();},
  });
  assert.equal(attempts,3); assert.equal(launches,1); assert.equal(registrations,2);
  assert.deepEqual(JSON.parse(await readFile(resolve(root,'.local/connector-login.json'),'utf8')),{version:1,nodePath:process.execPath});
  assert.deepEqual(JSON.parse(await readFile(resolve(root,'.local/runtime.json'),'utf8')),runtime);
  await rm(resolve(root,'.local/runtime.json'));
  await assert.rejects(restoreConnectorLogin({root,bootstrap:async()=>{throw Error('Must not select a second identity');}}),/首次桥接身份/);
});

test('old installation missing runtime cannot authorize a new caller through retry or login',async t=>{
  const root=await fixture(t,{withRuntime:false}); let touched=false;
  await assert.rejects(registerDeferredConnectorLogin({root,platform:'win32',registration:{read:async()=>{touched=true;}}}),/首次桥接身份/);
  await assert.rejects(restoreConnectorLogin({root,bootstrap:async()=>{touched=true;}}),/首次桥接身份/);
  assert.equal(touched,false);
  await writeFile(resolve(root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath:'C:/unknown-node.exe',bootstrap:true}));
  await assert.rejects(restoreConnectorLogin({root,bootstrap:async()=>{touched=true;}}),/首次桥接身份/);
  assert.equal(touched,false);
});

test('pending bootstrap never replaces a corrupt or mismatched saved runtime',async t=>{
  const root=await fixture(t); let bootstrapped=false;
  await writeFile(resolve(root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath:process.execPath,bootstrap:true}));
  await writeFile(resolve(root,'.local/runtime.json'),'corrupt-fixture');
  await assert.rejects(restoreConnectorLogin({root,bootstrap:async()=>{bootstrapped=true;}}));
  assert.equal(await readFile(resolve(root,'.local/runtime.json'),'utf8'),'corrupt-fixture');
  await writeFile(resolve(root,'.local/runtime.json'),JSON.stringify({...runtime,port:4444,sendScope:'single'}));
  await assert.rejects(registerDeferredConnectorLogin({root,platform:'win32',allowBootstrap:true}),/端口/);
  assert.equal(JSON.parse(await readFile(resolve(root,'.local/runtime.json'),'utf8')).sendScope,'single');
  assert.equal(bootstrapped,false);
});

test('GUI recovery registration preserves an existing narrowed send scope and never authorizes first bootstrap',async t=>{
  const root=await fixture(t);
  const narrowed={...runtime,sendScope:'single'};
  await writeFile(resolve(root,'.local/runtime.json'),JSON.stringify(narrowed));
  const result=await registerDeferredConnectorLogin({root,platform:'win32',registration:{read:async()=>({conflict:false}),enable:async()=>({enabled:true})}});
  assert.equal(result.pendingBootstrap,false);
  assert.deepEqual(JSON.parse(await readFile(resolve(root,'.local/runtime.json'),'utf8')),narrowed);
  assert.deepEqual(JSON.parse(await readFile(resolve(root,'.local/connector-login.json'),'utf8')),{version:1,nodePath:process.execPath});
});

test('watcher launch uses one owned recovery instance and excludes credentials from launch data',async()=>{
  let first,second;
  const root=resolve(tmpdir(),'owned-watcher-fixture');
  await launchConnectorLoginWatcher({root,launch:async options=>{first=options;return{pid:1};}});
  await launchConnectorLoginWatcher({root,launch:async options=>{second=options;return{pid:2};}});
  assert.deepEqual(first,second); assert.equal(first.instanceName,'connector-login'); assert.deepEqual(first.env,{});
  assert.equal(first.supervisorPath,resolve(root,'scripts/connector-login.mjs'));
  assert.doesNotMatch(JSON.stringify(first),/deviceToken|pairingCode/);
});

test('automatic first bootstrap selects only an existing ordinary local conversation with read-only calls',async()=>{
  const choices=[{id:'child'},{id:'archived'},{id:'remote'},{id:'ordinary'}],calls=[];
  const selected=await selectOrdinaryLocalThread(choices,({callerThreadId})=>({call:async(name,args)=>{
    calls.push(name); assert.equal(args.threadId,callerThreadId);
    return {thread:{id:callerThreadId,kind:'codex',...(callerThreadId==='child'?{parentThreadId:'parent'}:callerThreadId==='archived'?{archived:true}:callerThreadId==='remote'?{hostId:'other'}:{hostId:'local'})}};
  }}));
  assert.equal(selected,'ordinary'); assert.deepEqual(calls,['read_thread','read_thread','read_thread','read_thread']);
  await assert.rejects(selectOrdinaryLocalThread([],()=>{}),/现有普通本机会话/);
});
