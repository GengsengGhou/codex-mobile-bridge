import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { runConnectorForeground, connectorFailureMessage } from '../scripts/start-connector.mjs';

const quiet = { log() {} };
function fixture(overrides = {}) {
  const signals = new EventEmitter(), snapshots = [];
  let stops = 0, state = 'connecting';
  const connector = { status: () => ({ state }), stop: () => { stops++; state = 'stopped'; }, bindingCurrent: async () => true };
  return { signals, snapshots, stops: () => stops, options: { run: async () => connector, signals, intervalMs: 1, output: quiet, mayRun: async () => true, writeState: async (_path, state) => snapshots.push(state), ...overrides } };
}

test('first state failure stops connector and removes signal listeners', async () => {
  const failure = Object.assign(new Error('secret path and token must stay private'), { code: 'EPERM' });
  const f = fixture({ writeState: async () => { throw failure; } });
  await assert.rejects(runConnectorForeground(f.options), error => error.code === 'CONNECTOR_STATE_WRITE_FAILED' && error.cause === failure);
  assert.equal(f.stops(), 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.equal(f.signals.listenerCount('SIGINT'), 0);
  const message = connectorFailureMessage({ code: 'CONNECTOR_STATE_WRITE_FAILED', cause: failure });
  assert.match(message, /EPERM/); assert.doesNotMatch(message, /secret|token|path/);
});

test('later heartbeat failure propagates after cleanup, without overlapping state writes', async () => {
  let writes = 0, active = 0, maxActive = 0;
  const f = fixture({ writeState: async () => {
    active++; maxActive = Math.max(active, maxActive);
    await new Promise(done => setTimeout(done, 5)); active--;
    if (++writes === 3) throw Object.assign(new Error(), { code: 'EACCES' });
  } });
  await assert.rejects(runConnectorForeground(f.options), { code: 'CONNECTOR_STATE_WRITE_FAILED' });
  assert.equal(writes, 3); assert.equal(maxActive, 1); assert.equal(f.stops(), 1);
  assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('pause and binding changes stop and publish captured stopped identity', async t => {
  for (const kind of ['pause', 'binding']) await t.test(kind, async () => {
    const f = fixture({ mayRun: async () => kind !== 'pause' });
    const run = f.options.run;
    f.options.run = async () => ({ ...await run(), bindingCurrent: async () => kind !== 'binding' });
    await runConnectorForeground(f.options);
    assert.equal(f.stops(), 1); assert.equal(f.snapshots.at(-1).state, 'stopped');
    assert.equal(f.snapshots.length, 2);
    assert.equal(f.signals.listenerCount('SIGINT'), 0);
  });
});

test('shutdown signal during initial publication leaves no heartbeat timer', async () => {
  const f = fixture(); let writes = 0;
  f.options.writeState = async (_path, snapshot) => { f.snapshots.push(snapshot); if (++writes === 1) f.signals.emit('SIGTERM'); };
  f.options.mayRun = async () => { throw new Error('must not poll after shutdown'); };
  await runConnectorForeground(f.options);
  assert.equal(f.stops(), 1); assert.equal(f.snapshots.at(-1).state, 'stopped');
});

test('state and binding failures release a real child process with active connector handles', { timeout: 15000 }, async t => {
  for (const stage of ['first', 'heartbeat', 'binding']) await t.test(stage, async () => {
    const module = new URL('../scripts/start-connector.mjs', import.meta.url).href;
    const source = `import {runConnectorForeground,connectorFailureMessage} from ${JSON.stringify(module)};
      let writes=0,stops=0;const handle=setInterval(()=>{},60000);
      try {await runConnectorForeground({run:async()=>({status:()=>({state:'connecting'}),stop:()=>{stops++;clearInterval(handle)},bindingCurrent:async()=>{if(${JSON.stringify(stage)}==='binding')throw Error('binding');return true}}),intervalMs:1,mayRun:async()=>true,output:{log(){}},writeState:async()=>{if(++writes===(${JSON.stringify(stage)}==='first'?1:2))throw Object.assign(Error('private'),{code:'EPERM'})}})}
      catch(e){console.log(JSON.stringify({stops,code:e.code??'binding',safe:connectorFailureMessage(e)}));process.exitCode=1}`;
    try { await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], { windowsHide: true, timeout: 4000 }); assert.fail('must fail'); }
    catch (error) {
      assert.equal(error.killed, false); assert.equal(error.code, 1);
      const result = JSON.parse(error.stdout.trim()); assert.equal(result.stops, 1);
      assert.doesNotMatch(result.safe, /private/);
    }
  });
});

test('actual CLI exits on an unwritable state destination instead of retaining its Hub connection', { timeout: 15000 }, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'connector-state-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new URL('..', import.meta.url);
  for (const name of ['src', 'scripts', 'hub']) await cp(new URL(name, repository), resolve(root, name), { recursive: true });
  await symlink(new URL('node_modules', repository), resolve(root, 'node_modules'), 'junction');
  await mkdir(resolve(root, '.local/hub-connector-state.json'), { recursive: true });
  const server = createServer((_req, res) => { res.setHeader('set-cookie', `bridge_session=${'a'.repeat(64)}; Path=/`); res.end('fixture'); });
  const wss = new WebSocketServer({ server });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); await new Promise(done => wss.close(done)); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const port = server.address().port;
  await writeFile(resolve(root, '.local/hub-connector.json'), JSON.stringify({ version: 1, hubOrigin: `http://127.0.0.1:${port}`, deviceId: 'fixture', deviceToken: 'fixture', bridgePort: port, allowInsecureLocal: true }));
  try { await promisify(execFile)(process.execPath, [resolve(root, 'scripts/start-connector.mjs')], { windowsHide: true, timeout: 5000 }); assert.fail('must fail'); }
  catch (error) {
    assert.equal(error.killed, false); assert.equal(error.code, 1);
    assert.match(error.stderr, /连接器状态文件写入失败/);
    assert.doesNotMatch(error.stderr, /Bearer|fixture/);
  }
});
