import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { RemoteAuth } from '../src/remote-auth.mjs';
import { createRemoteGateway } from '../src/remote-gateway.mjs';

const origin = 'https://phone.example.test', password = 'test password with sufficient length';
const id = '12345678-1234-1234-1234-123456789012';
async function start(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function stop(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port, path, method, headers: { host: 'phone.example.test', ...headers } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) })); response.on('error', reject);
    }); request.on('error', reject); request.end(body);
  });
}
async function fixture(t) {
  let cookie = 'bridge_session=abc123', requests = [], writes = 0, loseWrite = false;
  const backend = http.createServer(async (req, res) => {
    requests.push({ path: req.url, method: req.method, headers: req.headers });
    if (req.url === '/') { res.setHeader('Set-Cookie', `${cookie}; HttpOnly; Path=/`); res.end('private app'); return; }
    if (req.headers.cookie !== cookie) { res.writeHead(401); res.end('{"code":"UNAUTHORIZED"}'); return; }
    if (req.method === 'POST') {
      writes++; if (loseWrite) { req.socket.destroy(); return; }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = Buffer.concat(chunks); res.setHeader('Content-Type', 'application/octet-stream'); res.setHeader('Content-Length', data.length); res.end(data); return;
    }
    res.setHeader('Set-Cookie', 'bridge_session=leak'); res.setHeader('Location', 'http://evil.example'); res.end('private data');
  });
  const backendPort = await start(backend), auth = new RemoteAuth(); await auth.configure(password);
  const gateway = createRemoteGateway({ publicOrigin: origin, bridgeOrigin: `http://127.0.0.1:${backendPort}`, auth }); const port = await start(gateway);
  t.after(async () => { await stop(gateway); await stop(backend); });
  const login = await call(port, '/auth/login', { method: 'POST', headers: { origin, 'x-bridge-client': 'mobile-v1', 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); const session = login.headers['set-cookie'][0].split(';')[0];
  assert.match(login.headers['set-cookie'][0], /Secure; HttpOnly; SameSite=Strict; Path=\//);
  return { port, session, requests, rotate() { cookie = 'bridge_session=def456'; }, loseWrite() { loseWrite = true; }, get writes() { return writes; } };
}
test('gateway denies unauthenticated app, API, files and local provisioning without upstream access', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/app.js', '/api/threads', `/api/threads/${id}/file?path=secret`]) {
    const result = await call(f.port, path); assert.equal(result.status, path.startsWith('/api/') ? 401 : 302);
    assert.ok(!result.body.toString().includes('private'));
  }
  assert.equal(f.requests.length, 0);
  const denied = await call(f.port, '/api/remote-access', { headers: { cookie: f.session } }); assert.equal(denied.status, 404); assert.equal(f.requests.length, 0);
});

test('login language modules are public without exposing the authenticated app', async t => {
  const f = await fixture(t);
  for (const path of ['/i18n.js', '/i18n-messages.js']) {
    const response = await call(f.port, path);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/javascript/);
    assert.ok(response.body.length > 0);
    assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  }
  assert.equal((await call(f.port, '/app.js')).status, 302);
  assert.equal((await call(f.port, '/api/threads')).status, 401);
  assert.equal(f.requests.length, 0);
});
test('gateway enforces exact Host and Origin and ignores spoofed forwarding identity', async t => {
  const f = await fixture(t);
  for (const headers of [ { host: '127.0.0.1', 'x-forwarded-host': 'phone.example.test' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' } ]) {
    assert.equal((await call(f.port, '/api/status', { headers: { cookie: f.session, ...headers } })).status, 403);
  }
  assert.equal((await call(f.port, '/api/threads', { method: 'POST', headers: { cookie: f.session, 'x-bridge-client': 'mobile-v1' } })).status, 403);
  assert.equal(f.requests.length, 0);
  const success = await call(f.port, '/api/status', { headers: { cookie: `${f.session}; bridge_session=evil`, authorization: 'evil', 'x-forwarded-for': 'evil' } });
  assert.equal(success.status, 200); assert.equal(success.headers['set-cookie'], undefined); assert.equal(success.headers.location, undefined);
  assert.equal(f.requests.at(-1).headers.authorization, undefined); assert.equal(f.requests.at(-1).headers['x-forwarded-for'], undefined);
  assert.equal(f.requests.at(-1).headers.cookie, 'bridge_session=abc123');
});

test('context metadata crosses the authenticated gateway only as a read', async t => {
  const f = await fixture(t), path = `/api/threads/${id}/context`;
  assert.equal((await call(f.port, path)).status, 401);
  assert.equal((await call(f.port, path, { headers: { cookie: f.session } })).status, 200);
  assert.equal(f.requests.at(-1).path, path);
  const count = f.requests.length;
  assert.equal((await call(f.port, path, { method: 'POST', headers: { cookie: f.session, origin, 'x-bridge-client': 'mobile-v1' }, body: '{}' })).status, 405);
  assert.equal(f.requests.length, count);
});
test('gateway renews stale backend session only for reads and never replays lost writes', async t => {
  const f = await fixture(t); const headers = { cookie: f.session, origin, 'x-bridge-client': 'mobile-v1' };
  await call(f.port, '/api/status', { headers }); f.rotate();
  assert.equal((await call(f.port, '/api/status', { headers })).status, 200);
  assert.equal(f.requests.filter(r => r.path === '/').length, 2);
  f.loseWrite(); const result = await call(f.port, '/api/threads', { method: 'POST', headers, body: '{}' });
  assert.equal(result.status, 502); assert.equal(JSON.parse(result.body).code, 'DELIVERY_UNKNOWN'); assert.equal(f.writes, 1);
});
test('gateway preserves multi-megabyte binary requests and responses and logout revokes access', async t => {
  const f = await fixture(t), body = randomBytes(3 * 1024 * 1024);
  const headers = { cookie: f.session, origin, 'x-bridge-client': 'mobile-v1', 'content-type': 'application/octet-stream', 'content-length': body.length };
  const result = await call(f.port, `/api/threads/${id}/uploads/${id}`, { method: 'POST', headers, body });
  assert.equal(result.status, 200); assert.deepEqual(result.body, body);
  const logout = await call(f.port, '/auth/logout', { method: 'POST', headers: { cookie: f.session, origin, 'x-bridge-client': 'mobile-v1' } });
  assert.equal(logout.status, 200); assert.equal((await call(f.port, '/api/status', { headers: { cookie: f.session } })).status, 401);
});
test('stale backend session rejects a mutation once and all-session revocation is durable', async t => {
  const f = await fixture(t); const headers = { cookie: f.session, origin, 'x-bridge-client': 'mobile-v1' };
  await call(f.port, '/api/status', { headers }); f.rotate();
  const rejected = await call(f.port, '/api/threads', { method: 'POST', headers, body: '{}' });
  assert.equal(rejected.status, 401); assert.equal(f.writes, 0);
  assert.equal(f.requests.filter(r => r.path === '/api/threads').length, 1); assert.equal(f.requests.filter(r => r.path === '/').length, 1);
  assert.equal((await call(f.port, '/auth/revoke-all', { method: 'POST', headers })).status, 200);
  assert.deepEqual(JSON.parse((await call(f.port, '/auth/status', { headers })).body), { authenticated: false });
  assert.equal((await call(f.port, '/api/access', { headers })).status, 401);
});
test('unconfigured gateway never grants access and exposes no upstream route through URL tricks', async t => {
  const gateway = createRemoteGateway({ publicOrigin: origin }); const port = await start(gateway); t.after(() => stop(gateway));
  const login = await call(port, '/auth/login', { method: 'POST', headers: { origin, 'x-bridge-client': 'mobile-v1', 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 503); assert.equal(JSON.parse(login.body).code, 'AUTH_NOT_CONFIGURED');
  assert.equal((await call(port, 'http://127.0.0.1/api/status')).status, 400);
  assert.equal((await call(port, '//127.0.0.1/api/status')).status, 400);
  assert.equal((await call(port, '/api/status', { headers: { 'x-forwarded-host': 'phone.example.test', 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } })).status, 401);
});
