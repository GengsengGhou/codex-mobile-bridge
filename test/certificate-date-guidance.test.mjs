import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyNetworkError, certificateDateMessage, pairingNetworkError } from '../scripts/network-error.mjs';
import { startConnector } from '../hub/connector.mjs';
import { guiCommand } from '../scripts/connector-gui.mjs';
import { serveMcp } from '../scripts/collaboration-mcp.mjs';
import { hubCollaboration, createCollaborationClient } from '../scripts/collaboration-client.mjs';
import { writePrivate } from '../scripts/collaboration-common.mjs';

const config = { version: 1, hubOrigin: 'https://fixture.invalid', deviceId: '11111111-1111-4111-8111-111111111111', deviceToken: 'x'.repeat(43) };
const target = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const secret = 'https://user:secret@private.invalid/?deviceToken=private-token';
const raw = code => new TypeError(secret, { cause: new AggregateError([{ cause: Object.assign(new Error(secret), { code }) }, { code: 'PRIVATE_ERROR' }], secret) });
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition completed'); await new Promise(done => setTimeout(done, 5)); }
};

for (const code of ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED']) {
  test(`${code}: nested classification and pairing retain safe guidance and uncertain outcome`, () => {
    assert.deepEqual(classifyNetworkError(raw(code)), { category: 'TLS_DATE', codes: [code] });
    const error = pairingNetworkError(raw(code));
    assert.equal(error.code, 'PAIR_NETWORK_TLS_DATE');
    assert.ok(error.message.includes(certificateDateMessage));
    assert.match(error.message, /请求可能已到达服务器/);
    assert.doesNotMatch(JSON.stringify(error), /secret|private-token|PRIVATE_ERROR|private.invalid/);
  });

  test(`${code}: actual connector status survives reconnect, GUI filters stale errors, and success clears guidance`, async t => {
    const local = http.createServer((_req, res) => { res.setHeader('Set-Cookie', `bridge_session=${'a'.repeat(64)}; Path=/`); res.end('fixture'); });
    local.listen(0, '127.0.0.1'); await once(local, 'listening');
    const sockets = [], attempts = [];
    class Socket extends EventEmitter {
      constructor(endpoint, options) {
        super(); sockets.push(this); attempts.push({ endpoint, options });
        queueMicrotask(() => this.emit(sockets.length === 1 ? 'error' : 'open', raw(code)));
      }
      close() { this.emit('close'); }
    }
    const connector = startConnector({ ...config, bridgePort: local.address().port, WebSocketImpl: Socket, reconnectMinMs: 150, reconnectMaxMs: 150 });
    t.after(async () => { connector.stop(); local.closeAllConnections(); await new Promise(done => local.close(done)); });
    await waitFor(() => connector.status().state === 'offline');
    const snapshot = { ...connector.status(), ...config, updatedAt: new Date().toISOString() };
    assert.deepEqual(snapshot.networkError, { category: 'TLS_DATE', codes: [code] });
    assert.equal(snapshot.lastError, certificateDateMessage);
    const gui = (state, intent = {}) => guiCommand({ action: 'status' }, { read: async () => config, probe: async () => true, readState: async () => state, control: { read: async () => ({ paused: false, ...intent }) } });
    const view = await gui(snapshot);
    assert.equal(view.lastError, certificateDateMessage); assert.equal(view.networkError.category, 'TLS_DATE');
    for (const state of [{ ...snapshot, deviceId: target }, { ...snapshot, hubOrigin: 'https://other.invalid' }, { ...snapshot, updatedAt: '2000-01-01' }, { ...snapshot, state: 'online' }, { ...snapshot, state: 'connected' }]) {
      const ignored = await gui(state); assert.equal(ignored.networkError, null); assert.equal(ignored.lastError, null);
    }
    assert.equal((await gui(snapshot, { paused: true })).networkError, null);
    assert.equal((await gui(snapshot, { lastError: 'control failure' })).lastError, 'control failure');
    const poisoned = await gui({ ...snapshot, lastError: secret, networkError: { category: secret, codes: [code, 'PRIVATE_ERROR'] } });
    assert.equal(poisoned.lastError, certificateDateMessage); assert.doesNotMatch(JSON.stringify(poisoned.networkError), /secret|PRIVATE_ERROR/);
    await waitFor(() => connector.status().connected);
    assert.equal(attempts.length, 2); assert.equal(connector.status().networkError, null); assert.equal(connector.status().lastError, null);
    for (const attempt of attempts) {
      assert.equal(attempt.endpoint.protocol, 'wss:'); assert.equal(attempt.options.rejectUnauthorized, undefined);
      assert.equal(attempt.options.headers.Authorization, `Bearer ${config.deviceToken}`);
    }
    const recovered = await gui({ ...connector.status(), ...config, updatedAt: new Date().toISOString() });
    assert.equal(recovered.hubConnected, true); assert.equal(recovered.lastError, null);
  });

  test(`${code}: real MCP transport explains reads, wait and uncertain commands without resets or resend`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'clock-mcp-')); await mkdir(join(root, '.local'));
    const pairing = join(root, '.local/hub-connector.json'), policy = join(root, '.local/computer-collaboration.json');
    await writePrivate(pairing, config);
    await writePrivate(policy, { version: 1, hubOrigin: config.hubOrigin, deviceId: config.deviceId, controlEnabled: true, receiveEnabled: true, requiresAuthorization: false, allowedDeviceIds: [target], allowedProjectRoots: [] });
    const before = await Promise.all([readFile(pairing), readFile(policy)]);
    let failure = raw(code); const requests = [];
    const input = new PassThrough(), output = new PassThrough(), replies = createInterface({ input: output });
    const lines = serveMcp({ root, input, output, fetchImpl: async (_url, options) => {
      requests.push({ method: options.method, body: options.body && JSON.parse(options.body) });
      assert.ok(options.signal instanceof AbortSignal); if (failure) throw failure;
      return new Response(JSON.stringify({ version: 1, sourceDeviceId: config.deviceId, devices: [] }));
    } });
    t.after(async () => { lines.close(); replies.close(); input.destroy(); output.destroy(); await rm(root, { recursive: true, force: true }); });
    let id = 0;
    const rpc = async (method, params) => { const result = once(replies, 'line'); input.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) + '\n'); return JSON.parse((await result)[0]); };
    const tool = async (name, args) => {
      const reply = await rpc('tools/call', { name: 'collaboration_' + name, arguments: args });
      assert.doesNotMatch(JSON.stringify(reply), /secret|private-token|PRIVATE_ERROR|private.invalid/);
      const value = JSON.parse(reply.result.content[0].text);
      assert.equal(value.code, 'COLLABORATION_NETWORK_TLS_DATE');
      assert.ok((value.error || value.message).includes(certificateDateMessage));
      return value;
    };
    assert.ok((await rpc('initialize')).result);
    await tool('devices', {}); await tool('projects', { deviceId: target });
    const waiting = await tool('wait', { deviceId: target, threadId, timeoutMs: 0 }); assert.equal(waiting.available, false);
    for (const operation of ['create', 'send']) {
      const operationId = operation === 'create' ? '44444444-4444-4444-8444-444444444444' : '55555555-5555-4555-8555-555555555555';
      const args = { deviceId: target, prompt: 'fixture only', operationId, ...(operation === 'create' ? { projectId: 'fixture-project' } : { threadId }) };
      const value = await tool(operation, args);
      assert.equal(value.state, 'unknown'); assert.equal(value.operationId, operationId); assert.match(value.message, /receipt.*Do not resend/);
      const prior = requests.length; const repeated = await tool(operation, args);
      assert.equal(repeated.state, 'unknown'); assert.equal(requests.length, prior + 1); assert.equal(requests.at(-1).body.operation, 'receipt');
      await tool('receipt', { deviceId: target, operationId });
    }
    assert.equal(requests.filter(r => ['create', 'send'].includes(r.body?.operation)).length, 2);
    assert.ok((await rpc('ping')).result, 'TLS failure leaves MCP available');
    failure = raw('DEPTH_ZERO_SELF_SIGNED_CERT');
    const otherTls = JSON.parse((await rpc('tools/call', { name: 'collaboration_devices', arguments: {} })).result.content[0].text);
    assert.equal(otherTls.code, 'COLLABORATION_NETWORK_TLS'); assert.ok(!otherTls.error.includes(certificateDateMessage));
    failure = null;
    const recovered = await rpc('tools/call', { name: 'collaboration_devices', arguments: {} });
    assert.equal(recovered.result.isError, undefined); assert.deepEqual(JSON.parse(recovered.result.content[0].text).devices, []);
    assert.deepEqual(await Promise.all([readFile(pairing), readFile(policy)]), before);
  });
}

test('other TLS errors and secret text are not mislabelled as certificate-date failure', async () => {
  for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    assert.equal(classifyNetworkError(raw(code)).category, 'TLS');
    assert.doesNotMatch(pairingNetworkError(raw(code)).message, /立即同步/);
    await assert.rejects(hubCollaboration(config, null, null, { fetchImpl: async () => { throw raw(code); } }), error => error.code === 'COLLABORATION_NETWORK_TLS' && !error.message.includes(certificateDateMessage));
  }
  assert.equal(classifyNetworkError(new Error('CERT_HAS_EXPIRED')).category, 'UNKNOWN');
});

test('response stream certificate-date errors are sanitized at collaboration fetch boundary', async () => {
  await assert.rejects(hubCollaboration(config, null, null, { fetchImpl: async () => ({ status: 200, ok: true, body: (async function* () { throw raw('CERT_HAS_EXPIRED'); })() }) }), error => error.code === 'COLLABORATION_NETWORK_TLS_DATE' && error.message === certificateDateMessage);
});

test('CLOCK failures retain their own wait guidance and surface capability-discovery failures', async t => {
  const root=await mkdtemp(join(tmpdir(),'clock-guidance-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'.local'));
  await writePrivate(join(root,'.local/hub-connector.json'),config);
  await writePrivate(join(root,'.local/computer-collaboration.json'),{version:1,hubOrigin:config.hubOrigin,deviceId:config.deviceId,controlEnabled:true,receiveEnabled:true,allowedDeviceIds:[target],allowedProjectRoots:[]});
  for(const code of ['CLOCK_UNSUPPORTED','CLOCK_AUTH_FAILED','CLOCK_CERTIFICATE_INVALID','CLOCK_VALIDATION_UNAVAILABLE']) {
    const client=createCollaborationClient({root,fetchImpl:async(_url,options)=>{if(options.method==='GET')return new Response(JSON.stringify({version:1,sourceDeviceId:config.deviceId,devices:[{id:target,online:true,name:'fixture'}]}));throw raw(code);}});
    const waited=await client.wait(target,threadId,{timeoutMs:0});assert.equal(waited.code,'COLLABORATION_NETWORK_CLOCK');assert.doesNotMatch(waited.message,/立即同步|secret|private-token/);
    assert.equal(waited.message.includes(certificateDateMessage),false);
    await assert.rejects(client.devices(),error=>error.code==='COLLABORATION_NETWORK_CLOCK');
  }
});
