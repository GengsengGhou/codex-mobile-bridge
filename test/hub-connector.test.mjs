import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { startConnector } from '../hub/connector.mjs';
import { HubRelay } from '../hub/relay.mjs';
import { MAX_PAYLOAD, UPLOAD_LIMIT, DOWNLOAD_LIMIT, allowedBridgeRequest, control, decode } from '../hub/protocol.mjs';

const thread = '11111111-1111-4111-8111-111111111111';
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Condition timeout'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function fixture(t, handler, options = {}, connectorOptions = {}) {
  let acquisitions = 0;
  const local = http.createServer((req, res) => {
    if (req.url === '/') { acquisitions++; res.setHeader('Set-Cookie', `bridge_session=${String(acquisitions).padStart(64, 'a')}; HttpOnly; Path=/`); res.end('local'); return; }
    handler(req, res, acquisitions);
  });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  const relay = new HubRelay(options), hub = http.createServer((req, res) => {
    relay.proxy(req.headers['x-device'] || 'desktop', req, res, req.url, { sessionToken: req.headers['x-session'] || 'active' }).catch(error => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(error.status); res.end(JSON.stringify({ code: error.code })); }
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  hub.on('upgrade', (req, socket, head) => {
    assert.equal(req.headers.authorization, 'Bearer test-secret'); assert.equal(req.headers['x-bridge-protocol'], '1');
    wss.handleUpgrade(req, socket, head, ws => relay.attach(new URL(req.url, 'http://localhost').searchParams.get('deviceId'), ws));
  });
  hub.listen(0, '127.0.0.1'); await once(hub, 'listening');
  const origin = `http://127.0.0.1:${hub.address().port}`;
  const connectors = [];
  const connect = (deviceId = 'desktop', port = local.address().port) => {
    const connector = startConnector({ hubOrigin: origin, deviceId, deviceToken: 'test-secret', bridgePort: port, allowInsecureLocal: true, reconnectMinMs: 10, reconnectMaxMs: 30, ...connectorOptions });
    connectors.push(connector); return connector;
  };
  const connector = connect(); await waitFor(() => connector.status().connected);
  t.after(async () => {
    for (const item of connectors) item.stop(); relay.close(); for (const client of wss.clients) client.terminate(); wss.close();
    local.closeAllConnections(); hub.closeAllConnections(); await Promise.all([new Promise(resolve => local.close(resolve)), new Promise(resolve => hub.close(resolve))]);
  });
  return { origin, relay, connector, connect, local, wss, acquisitions: () => acquisitions };
}

test('unsupported connector route is rejected per request and leaves the connector usable', async t => {
  const { origin, connector, wss } = await fixture(t, (_req, res) => res.end('supported'));
  const socket = [...wss.clients][0];
  const result = once(socket, 'message');
  control(socket, { type: 'request', id: thread, method: 'GET', path: `/api/threads/${thread}/future`, headers: {} });
  const [data, isBinary] = await result;
  assert.deepEqual(decode(data, isBinary), { v: 1, type: 'error', id: thread, code: 'BRIDGE_ROUTE_UNSUPPORTED' });
  assert.equal(connector.status().connected, true);
  const response = await fetch(`${origin}/api/status`);
  assert.equal(response.status, 200); assert.equal(await response.text(), 'supported');
});

test('concurrent thread reads finish out of order without crossing IDs, validators or reconnecting on desktop rejection', async t => {
  const other = '22222222-2222-4222-8222-222222222222';
  let release, started;
  const slow = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { origin, connector, relay } = await fixture(t, async (req, res) => {
    if (req.url === `/api/threads/${thread}`) { started(); await slow; }
    if (req.url.endsWith('?reject=1')) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'DESKTOP_REJECTED' })); return; }
    const id = req.url.includes(other) ? other : thread;
    const etag = `"${id}"`; res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ thread: { id }, turns: [] }));
  });
  const connection = relay.devices.get('desktop');
  const first = fetch(`${origin}/api/threads/${thread}`); await entered;
  const fast = await fetch(`${origin}/api/threads/${other}`);
  assert.equal((await fast.json()).thread.id, other); assert.equal(fast.headers.get('etag'), `"${other}"`);
  release(); const original = await first;
  assert.equal((await original.json()).thread.id, thread); assert.equal(original.headers.get('etag'), `"${thread}"`);
  const validated = await fetch(`${origin}/api/threads/${other}`, { headers: { 'If-None-Match': `"${other}"` } });
  assert.equal(validated.status, 304); assert.equal(await validated.text(), '');
  const rejected = await fetch(`${origin}/api/threads/${other}?reject=1`);
  assert.equal(rejected.status, 502); assert.equal((await rejected.json()).code, 'DESKTOP_REJECTED');
  assert.equal(connector.status().connected, true); assert.equal(relay.devices.get('desktop'), connection);
});

test('connector capacity rejects only the excess request and recovers after completion', async t => {
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let calls = 0;
  const { origin, connector } = await fixture(t, async (_req, res) => {
    calls++;
    if (calls === 1) { entered(); await blocked; }
    res.end('ok');
  }, { maxInFlight: 4 }, { maxInFlight: 1 });
  const first = fetch(`${origin}/api/status`);
  await started;
  const busy = await fetch(`${origin}/api/status`);
  assert.equal(busy.status, 503); assert.equal((await busy.json()).code, 'BRIDGE_BUSY');
  assert.equal(connector.status().connected, true);
  release(); assert.equal((await first).status, 200);
  assert.equal((await fetch(`${origin}/api/status`)).status, 200);
  assert.equal(calls, 2);
});

test('connector streams uploads/downloads and keeps bridge cookies and origin local', async t => {
  const payload = Buffer.alloc(310000, 37);
  const { origin } = await fixture(t, async (req, res) => {
    assert.match(req.headers.cookie, /^bridge_session=/); assert.equal(req.headers.origin, `http://127.0.0.1:${req.socket.localPort}`);
    assert.equal(req.headers['x-bridge-client'], 'mobile-v1'); assert.equal(req.headers.authorization, undefined);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), payload);
    res.setHeader('Set-Cookie', 'secret=never-forward'); res.setHeader('Content-Type', 'application/octet-stream'); res.end(payload);
  });
  const response = await fetch(`${origin}/api/threads/${thread}/uploads/${thread}`, { method: 'POST', headers: { cookie: 'remote=secret', authorization: 'remote-secret', origin: 'https://remote.example' }, body: payload });
  assert.equal(response.status, 200); assert.equal(response.headers.get('set-cookie'), null); assert.deepEqual(Buffer.from(await response.arrayBuffer()), payload);
});

test('GET refreshes an expired local cookie once; mutation 401 is not retried', async t => {
  let gets = 0, posts = 0;
  const { origin, acquisitions } = await fixture(t, (req, res) => {
    if (req.method === 'GET') { gets++; res.statusCode = gets === 1 ? 401 : 200; res.end('read'); }
    else { posts++; res.statusCode = 401; res.end('unauthorized'); }
  });
  assert.equal((await fetch(`${origin}/api/status`)).status, 200); assert.equal(gets, 2); assert.equal(acquisitions(), 2);
  assert.equal((await fetch(`${origin}/api/threads`, { method: 'POST', body: '{}' })).status, 401); assert.equal(posts, 1); assert.equal(acquisitions(), 2);
});

test('simultaneous devices isolate identical thread IDs', async t => {
  const { origin, connect } = await fixture(t, (req, res) => res.end('first'));
  const second = http.createServer((req, res) => {
    if (req.url === '/') res.setHeader('Set-Cookie', `bridge_session=${'b'.repeat(64)}; Path=/`);
    res.end(req.url === '/' ? 'local' : 'second');
  });
  second.listen(0, '127.0.0.1'); await once(second, 'listening'); t.after(() => { second.closeAllConnections(); second.close(); });
  const connector = connect('other', second.address().port); await waitFor(() => connector.status().connected);
  const results = await Promise.all(['desktop', 'other'].map(device => fetch(`${origin}/api/threads/${thread}`, { headers: { 'x-device': device } }).then(res => res.text())));
  assert.deepEqual(results, ['first', 'second']);
});

test('disconnect reports uncertain dispatched mutation and reconnect never replays it', async t => {
  let calls = 0;
  const { origin, relay } = await fixture(t, (req, res) => { calls++; relay.cancelDevice('desktop'); });
  const response = await fetch(`${origin}/api/threads`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN');
  await waitFor(() => relay.status('desktop')); assert.equal(calls, 1);
});

test('connector rejects remote upstream configuration and unsafe route variants', () => {
  assert.throws(() => startConnector({ hubOrigin: 'http://example.com', deviceId: 'x', deviceToken: 's' }));
  for (const path of ['http://127.0.0.1/api/status', '//evil/api/status', '/api/%73tatus', '/api/access', '/api/remote-access', '/api/status#fragment']) assert.equal(allowedBridgeRequest('GET', path), false);
  assert.equal(allowedBridgeRequest('PUT', '/api/recovery'), false);
  assert.equal(allowedBridgeRequest('GET', '/api/status?detail=1'), true);
});

test('streaming upload size is enforced without content-length and oversized downloads are rejected', async t => {
  let uploaded = 0;
  const { origin } = await fixture(t, (req, res) => {
    if (req.method === 'POST') { req.on('data', chunk => { uploaded += chunk.length; }); req.on('error', () => {}); }
    else { res.setHeader('content-length', DOWNLOAD_LIMIT + 1); res.write('x'); }
  });
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/threads`, { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(Buffer.alloc(UPLOAD_LIMIT + 100000, 3)); req.end();
  });
  assert.equal(status, 413); assert.ok(uploaded <= UPLOAD_LIMIT);
  const download = await fetch(`${origin}/api/status`);
  assert.equal(download.status, 502); assert.equal((await download.json()).code, 'BRIDGE_UNAVAILABLE');
});
