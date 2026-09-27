import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { HubRelay } from '../hub/relay.mjs';
import { control, binary, decode, MAX_PAYLOAD, FRAME_BYTES, UPLOAD_LIMIT } from '../hub/protocol.mjs';

async function fixture(t, options = {}) {
  const relay = new HubRelay(options);
  const server = http.createServer((req, res) => {
    relay.proxy('desktop', req, res, req.url, { sessionToken: 'session' }).catch(error => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(error.status); res.end(JSON.stringify({ code: error.code })); }
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  server.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => relay.attach('desktop', ws)));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const connect = async () => { const ws = new WebSocket(origin); await once(ws, 'open'); return ws; };
  const ws = await connect();
  t.after(async () => { relay.close(); for (const client of wss.clients) client.terminate(); ws.terminate(); wss.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { relay, ws, origin, connect };
}
test('offline rejects before dispatch and advertised oversized body never reaches connector', async t => {
  const { relay, ws, origin } = await fixture(t);
  let requests = 0; ws.on('message', () => requests++);
  const large = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/threads`, { method: 'POST', headers: { 'content-length': UPLOAD_LIMIT + 1 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); }); req.on('error', reject); req.end();
  });
  assert.equal(large, 413); assert.equal(requests, 0);
  relay.cancelDevice('desktop');
  const response = await fetch(`${origin}/api/status`); assert.equal(response.status, 503); assert.equal((await response.json()).code, 'DEVICE_OFFLINE');
});
test('upload sends only one bounded frame until acknowledged', async t => {
  const { ws, origin } = await fixture(t); let frames = 0, requestId;
  const first = new Promise(resolve => ws.on('message', (data, isBinary) => {
    const message = decode(data, isBinary);
    if (message.type === 'request') requestId = message.id;
    if (message.type === 'data') { frames++; assert.ok(message.bytes.length <= FRAME_BYTES); if (frames === 1) resolve(); else control(ws, { type: 'ack', id: message.id, direction: 'upload' }); }
    if (message.type === 'end') { control(ws, { type: 'response', id: message.id, status: 200 }); control(ws, { type: 'end', id: message.id, direction: 'download' }); }
  }));
  const pending = fetch(`${origin}/api/threads`, { method: 'POST', body: Buffer.alloc(FRAME_BYTES * 3, 42) });
  await first; await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(frames, 1);
  control(ws, { type: 'ack', id: requestId, direction: 'upload' }); assert.equal((await pending).status, 200); assert.ok(frames >= 3);
});
test('inflight limit, cancellation and timeout settle requests without replay', async t => {
  const { relay, ws, origin } = await fixture(t, { maxInFlight: 1, requestTimeoutMs: 300 });
  const dispatched = new Promise(resolve => ws.once('message', () => resolve()));
  const pending = fetch(`${origin}/api/status`); await dispatched;
  assert.equal((await fetch(`${origin}/api/status`)).status, 503);
  relay.cancelSession('session'); const revoked = await pending; assert.equal(revoked.status, 401); assert.equal((await revoked.json()).code, 'SESSION_REVOKED');
  const timedOut = await fetch(`${origin}/api/status`); assert.equal(timedOut.status, 503);
});
test('replacing connector fences old socket and settles dispatched writes', async t => {
  const { ws, origin, connect } = await fixture(t);
  const dispatched = new Promise(resolve => ws.once('message', () => resolve()));
  const pending = fetch(`${origin}/api/threads`, { method: 'POST', body: '{}' }); await dispatched;
  const replacement = await connect(); t.after(() => replacement.terminate());
  const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN');
  replacement.on('message', (data, isBinary) => { const message = decode(data, isBinary); if (message.type === 'end') { control(replacement, { type: 'response', id: message.id, status: 200 }); control(replacement, { type: 'end', id: message.id, direction: 'download' }); } });
  assert.equal((await fetch(`${origin}/api/status`)).status, 200);
});
test('invalid connector frame closes socket and cancels requests', async t => {
  const { ws, origin } = await fixture(t);
  const dispatched = new Promise(resolve => ws.once('message', () => resolve()));
  const pending = fetch(`${origin}/api/status`); await dispatched;
  ws.send('{invalid-json');
  assert.equal((await pending).status, 503);
});

test('ownership is checked on each incoming frame and revoked writes remain uncertain', async t => {
  let valid = true;
  const { ws, origin } = await fixture(t, { validateRequest: () => valid });
  const dispatched = new Promise(resolve => ws.once('message', (data, isBinary) => resolve(decode(data, isBinary))));
  const pending = fetch(`${origin}/api/threads`, { method: 'POST', body: '{}' });
  const request = await dispatched; valid = false;
  control(ws, { type: 'response', id: request.id, status: 200 });
  const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN');
});

test('connector content-length cannot confuse framing on a reused HTTP connection', async t => {
  const { ws, origin } = await fixture(t);
  let responses = 0;
  ws.on('message', (data, isBinary) => {
    const message = decode(data, isBinary);
    if (message.type === 'end' && message.direction === 'upload') {
      responses++;
      control(ws, { type: 'response', id: message.id, status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': responses === 1 ? '1' : '999' } });
      binary(ws, message.id, Buffer.from(responses === 1 ? 'first-file-payload' : 'second-file-payload'));
    } else if (message.type === 'ack' && message.direction === 'download') control(ws, { type: 'end', id: message.id, direction: 'download' });
  });
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); t.after(() => agent.destroy());
  const read = () => new Promise((resolve, reject) => {
    const req = http.get(`${origin}/api/status`, { agent }, res => {
      const chunks = []; const socket = res.socket;
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks).toString(), socket }));
    }); req.on('error', reject);
  });
  const first = await read(), second = await read();
  assert.equal(first.headers['content-length'], undefined); assert.equal(second.headers['content-length'], undefined);
  assert.equal(first.headers['transfer-encoding'], 'chunked'); assert.equal(first.socket, second.socket);
  assert.equal(first.body, 'first-file-payload'); assert.equal(second.body, 'second-file-payload');
});

test('body frames for 204, 205 or 304 fence an untrusted connector', async t => {
  for (const status of [204, 205, 304]) await t.test(`status ${status}`, async subtest => {
    const { relay, ws, origin } = await fixture(subtest);
    ws.on('message', (data, isBinary) => {
      const message = decode(data, isBinary);
      if (message.type === 'end' && message.direction === 'upload') {
        control(ws, { type: 'response', id: message.id, status }); binary(ws, message.id, Buffer.from('forbidden-body'));
      }
    });
    const closed = once(ws, 'close');
    const pending = fetch(`${origin}/api/status`).then(response => response.text()).catch(() => 'connection-rejected');
    const [code] = await closed; assert.equal(code, 1008); assert.equal(relay.status('desktop'), false);
    assert.notEqual(await pending, 'forbidden-body');
    assert.equal((await fetch(`${origin}/api/status`)).status, 503);
  });
});

test('duplicate upload acknowledgments cannot grant extra credit', async t => {
  const { relay, ws, origin } = await fixture(t);
  ws.on('message', (data, isBinary) => {
    const message = decode(data, isBinary);
    if (message.type === 'data') {
      control(ws, { type: 'ack', id: message.id, direction: 'upload' });
      control(ws, { type: 'ack', id: message.id, direction: 'upload' });
    }
  });
  const response = await fetch(`${origin}/api/threads`, { method: 'POST', body: Buffer.alloc(FRAME_BYTES * 3, 7) });
  assert.equal(response.status, 409); assert.equal((await response.json()).code, 'DELIVERY_UNKNOWN'); assert.equal(relay.status('desktop'), false);
});

test('noninteger, informational and out-of-range response statuses are rejected', async t => {
  for (const status of [199, 200.5, 600, '200']) await t.test(`status ${status}`, async subtest => {
    const { ws, origin } = await fixture(subtest);
    ws.on('message', (data, isBinary) => { const message = decode(data, isBinary); if (message.type === 'end') control(ws, { type: 'response', id: message.id, status }); });
    assert.equal((await fetch(`${origin}/api/status`)).status, 503);
  });
});

test('known concurrent load remains frame bounded and aggregate throughput is paced', async t => {
  const concurrency = 24, frames = 2, bytesPerSecond = 4 * 1024 * 1024;
  const { relay, ws, origin } = await fixture(t, { maxInFlight: concurrency, maxGlobalInFlight: concurrency, maxUserInFlight: concurrency, bytesPerSecond });
  const remaining = new Map(); let peakQueue = 0, peakRequests = 0;
  const sample = setInterval(() => { peakQueue = Math.max(peakQueue, relay.bandwidth.queue.length); peakRequests = Math.max(peakRequests, relay.active); }, 1);
  t.after(() => clearInterval(sample));
  ws.on('message', (data, isBinary) => {
    const message = decode(data, isBinary);
    if (message.type === 'end' && message.direction === 'upload') {
      remaining.set(message.id, frames - 1);
      control(ws, { type: 'response', id: message.id, status: 200 });
      binary(ws, message.id, Buffer.alloc(FRAME_BYTES, 42));
    } else if (message.type === 'ack' && message.direction === 'download') {
      const count = remaining.get(message.id);
      if (count) { remaining.set(message.id, count - 1); binary(ws, message.id, Buffer.alloc(FRAME_BYTES, 42)); }
      else { remaining.delete(message.id); control(ws, { type: 'end', id: message.id, direction: 'download' }); }
    }
  });
  const before = process.memoryUsage().rss, started = Date.now();
  const results = await Promise.all(Array.from({ length: concurrency }, async () => {
    const response = await fetch(`${origin}/api/status`); assert.equal(response.status, 200);
    return (await response.arrayBuffer()).byteLength;
  }));
  const elapsed = Date.now() - started, rssGrowth = process.memoryUsage().rss - before;
  assert.ok(results.every(bytes => bytes === frames * FRAME_BYTES));
  assert.ok(elapsed >= (concurrency * frames - 1) * FRAME_BYTES * 1000 / bytesPerSecond - 50, `elapsed ${elapsed}ms`);
  assert.equal(peakRequests, concurrency); assert.ok(peakQueue <= concurrency);
  assert.ok(rssGrowth < 48 * 1024 * 1024, `RSS growth ${rssGrowth}`);
  assert.equal(relay.active, 0); assert.equal(relay.bandwidth.queue.length, 0); assert.equal(remaining.size, 0);
  t.diagnostic(`24 concurrent downloads, 3 MiB total, elapsed=${elapsed}ms, RSS growth=${rssGrowth}, peak scheduled frames=${peakQueue}`);
});

test('conditional reads forward validators and preserve bodyless 304 without cached account data', async t => {
  const { ws, origin } = await fixture(t);
  ws.on('message', (data, isBinary) => {
    const message = decode(data, isBinary);
    if (message.type === 'request') assert.equal(message.headers['if-none-match'], '"private-version"');
    if (message.type === 'end' && message.direction === 'upload') {
      control(ws, { type: 'response', id: message.id, status: 304, headers: { etag: '"private-version"' } });
      control(ws, { type: 'end', id: message.id, direction: 'download' });
    }
  });
  const response = await fetch(`${origin}/api/status`, { headers: { 'If-None-Match': '"private-version"' } });
  assert.equal(response.status, 304); assert.equal(response.headers.get('etag'), '"private-version"'); assert.equal(await response.text(), '');
});
