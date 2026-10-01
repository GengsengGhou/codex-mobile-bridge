import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyBridge, startBridge } from '../scripts/start.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
const currentBridgePage=await readFile(new URL('../public/index.html',import.meta.url),'utf8');

function response({ status = 200, body = '', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: key => headers[key.toLowerCase()] ?? null },
    text: async () => body,
    json: async () => typeof body === 'string' ? JSON.parse(body) : body
  };
}

test('launcher recognizes the bridge only after authenticated status succeeds', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push([url, options]);
    if (url.endsWith('/')) return response({
      body: currentBridgePage,
      headers: { 'set-cookie': 'bridge_session=session-token; HttpOnly; SameSite=Strict; Path=/' }
    });
    return response({
      body: { connected: false, canSend: false, callerThreadId: 'thread-id' }
    });
  };

  assert.equal(await verifyBridge('http://127.0.0.1:4317', fetchImpl), true);
  assert.equal(requests.length, 2);
  assert.equal(requests[1][1].headers.Cookie, 'bridge_session=session-token');
  assert.equal(requests[1][1].headers['X-Bridge-Client'], 'mobile-v1');
});

test('launcher rejects an unrelated page even when it returns a session cookie', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return response({ body: '<title>Another local service</title>', headers: { 'set-cookie': 'bridge_session=session-token; Path=/' } });
  };

  assert.equal(await verifyBridge('http://127.0.0.1:4317', fetchImpl), false);
  assert.equal(requests, 1);
});

test('launcher rejects the bridge page when its authenticated API is not normal', async () => {
  const fetchImpl = async url => url.endsWith('/')
    ? response({ body: currentBridgePage, headers: { 'set-cookie': 'bridge_session=x; Path=/' } })
    : response({ status: 401, body: {} });

  assert.equal(await verifyBridge('http://127.0.0.1:4317', fetchImpl), false);
});

const config = { callerThreadId: 'caller', allowedSendThreadId: 'allowed', port: 4317, enableSend: true, sendScope: 'single' };
const quiet = { log() {}, error() {} };
test('legacy root branding still requires authenticated status during upgrades',async()=>{
  const requests=[];
  const fetchImpl=async(url,options)=>{requests.push({url,options});return url.endsWith('/')?response({body:'<title>Codex 手机桥接</title>',headers:{'set-cookie':'bridge_session=legacy-token; Path=/'}}):response({body:{connected:true,canSend:false,callerThreadId:'legacy-thread'}});};
  assert.equal(await verifyBridge('http://127.0.0.1:4317',fetchImpl),true);assert.equal(requests.length,2);assert.equal(requests[1].options.headers.Cookie,'bridge_session=legacy-token');
});
test('newly launched server readiness recognizes the actual shipped English page',async()=>{
  const root=mkdtempSync(resolve(tmpdir(),'bridge-readiness-test-'));let launched=false,authenticatedRequests=0;
  try {
    const result=await startBridge({root,platform:'win32',loadConfig:async()=>config,output:quiet,launchWindows:async()=>{launched=true;return {pid:123,mode:'fixture-broker'};},fetchImpl:async(url,options={})=>{
      if(!launched)return response({status:404});
      if(url.endsWith('/'))return response({body:currentBridgePage,headers:{'set-cookie':'bridge_session=ready-token; Path=/'}});
      assert.equal(options.headers.Cookie,'bridge_session=ready-token');assert.equal(options.headers['X-Bridge-Client'],'mobile-v1');authenticatedRequests++;return response({body:{connected:true,canSend:false,callerThreadId:'thread-id'}});
    }});
    assert.equal(result.started,true);assert.equal(authenticatedRequests,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('Windows launcher uses independent broker with explicit bridge settings', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'bridge-launch-test-'));
  let options;
  try {
    const result = await startBridge({ root, platform: 'win32', loadConfig: async () => config,
      fetchImpl: async () => response({ status: 404 }), waitForReady: async () => ({ connected: true }), output: quiet,
      spawnProcess: () => assert.fail('Windows must not use detached spawn'),
      launchWindows: async value => { options = value; return { pid: 123, mode: 'windows-wmi' }; }
    });
    assert.equal(result.mode, 'windows-wmi');
    assert.equal(result.pid, 123);
    assert.equal(options.env.CODEX_THREAD_ID, 'caller');
    assert.equal(options.env.BRIDGE_SEND_THREAD_ID, 'allowed');
    assert.equal(options.env.BRIDGE_ENABLE_SEND, '1');
    assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
    assert.equal(options.serverPath, resolve(root, 'src/server.mjs'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Windows broker error propagates without using detached spawn', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'bridge-launch-test-'));
  try {
    await assert.rejects(startBridge({ root, platform: 'win32', loadConfig: async () => config,
      fetchImpl: async () => response({ status: 404 }), output: quiet,
      spawnProcess: () => assert.fail('No unsafe fallback'),
      launchWindows: async () => { throw new Error('broker denied'); }
    }), /broker denied/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('non-Windows launcher preserves detached spawn and readiness checks', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'bridge-launch-test-'));
  let options;
  try {
    const result = await startBridge({ root, platform: 'linux', loadConfig: async () => config,
      fetchImpl: async () => response({ status: 404 }), waitForReady: async () => ({ connected: true }), output: quiet,
      launchWindows: () => assert.fail('Non-Windows must not use WMI'),
      spawnProcess: (node, args, value) => { options = value; return Object.assign(new EventEmitter(), { pid: 456, unref() {} }); }
    });
    assert.equal(result.mode, 'detached');
    assert.equal(options.detached, true);
    assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
