import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createBridgeServer } from '../src/server.mjs';
import { createRemoteGateway } from '../src/remote-gateway.mjs';
import { createHubServer } from '../hub/server.mjs';
import { HubStore } from '../hub/store.mjs';
import { mathAssets, assetContentType, appCsp } from '../src/static-assets.mjs';

async function start(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
function gatewayGet(port, path, cookie) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { Host: 'phone.example.test', ...(cookie ? { Cookie: cookie } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
test('all bundled assets use exact local allowlists, correct MIME and a narrowly scoped math CSP', async t => {
  const server = createBridgeServer({ bridge: { callerThreadId: '00000000-0000-0000-0000-000000000001' } });
  const port = await start(server); t.after(() => close(server)); const base = `http://127.0.0.1:${port}`;
  for (const path of mathAssets) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), assetContentType(path));
    assert.equal(response.headers.get('content-security-policy'), appCsp);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../public' + path, import.meta.url)));
  }
  for (const path of ['/vendor/katex/unknown.mjs', '/vendor/katex/fonts/not-a-font.woff2', '/vendor/katex/%2e%2e/%2e%2e/package.json', '/vendor/katex/fonts/KaTeX_Main-Regular.woff2%00']) assert.equal((await fetch(base + path)).status, 404);
  assert.match(appCsp, /script-src 'self';/); assert.ok(!appCsp.includes("script-src 'unsafe-inline'"));
  assert.match(appCsp, /style-src-attr 'unsafe-inline'; font-src 'self'/);
});
test('temporary authenticated gateway relays local math scripts, CSS and binary fonts without leaking login access', async t => {
  const server = createBridgeServer({ bridge: { callerThreadId: '00000000-0000-0000-0000-000000000001' } });
  const backendPort = await start(server);
  const gateway = createRemoteGateway({ publicOrigin: 'https://phone.example.test', bridgeOrigin: `http://127.0.0.1:${backendPort}`, auth: { authenticate: async token => token === 'test-session' ? { expiresAt: Date.now() + 10000 } : null } });
  const port = await start(gateway); t.after(async () => { await close(gateway); await close(server); });
  for (const path of ['/vendor/katex/katex.mjs', '/vendor/katex/katex.min.css', '/vendor/katex/fonts/KaTeX_Main-Regular.woff2']) {
    assert.equal((await gatewayGet(port, path)).status, 302);
    const response = await gatewayGet(port, path, '__Host-bridge_remote=test-session');
    assert.equal(response.status, 200); assert.equal(response.headers['content-type'], assetContentType(path));
    assert.equal(response.headers['content-security-policy'], appCsp);
    assert.deepEqual(response.bytes, await readFile(new URL('../public' + path, import.meta.url)));
    assert.equal(response.headers['cache-control'], 'private, no-cache');
  }
  assert.equal((await gatewayGet(port, '/vendor/katex/fonts/unknown.woff2', '__Host-bridge_remote=test-session')).status, 404);
});
test('hub serves math assets under the owner device path with account/device isolation and binary font MIME', async t => {
  const store = new HubStore();
  const owner = store.createUser({ name: 'math-owner', salt: 'isolated', hash: 'isolated', role: 'admin', initialAdmin: true });
  const other = store.createUser({ name: 'math-other', salt: 'isolated', hash: 'isolated', invite: store.invite(owner.id).invite });
  const grant = store.consumePairing(store.pairing(owner.id).pairingCode);
  const session = store.issueSession(owner.id), otherSession = store.issueSession(other.id);
  const server = createHubServer({ store, allowInsecureLocal: true }); const port = await start(server);
  t.after(async () => { server.relay.close(); await close(server); store.close(); });
  const base = `http://127.0.0.1:${port}/devices/${grant.deviceId}`;
  for (const path of mathAssets) {
    const unauthenticated = await fetch(base + path); assert.equal(unauthenticated.status, 401);
    const wrongOwner = await fetch(base + path, { headers: { Cookie: `hub_session=${otherSession.token}` } }); assert.equal(wrongOwner.status, 404);
    const response = await fetch(base + path, { headers: { Cookie: `hub_session=${session.token}` } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), assetContentType(path));
    assert.equal(response.headers.get('content-security-policy'), appCsp);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL('../public' + path, import.meta.url)));
  }
  assert.equal((await fetch(base + '/vendor/katex/%2fpackage.json', { headers: { Cookie: `hub_session=${session.token}` } })).status, 400);
  assert.equal((await fetch(base + '/vendor/katex/unknown.mjs', { headers: { Cookie: `hub_session=${session.token}`, 'X-Bridge-Client': 'mobile-v1' } })).status, 404);
});
