import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { HubStore } from '../hub/store.mjs';
import { hashPassword } from '../hub/auth.mjs';
import { createHubServer } from '../hub/server.mjs';
import { startConnector } from '../hub/connector.mjs';

const password = 'isolated-test-password-24';
const thread = '00000000-0000-4000-8000-000000000001';
async function setup(options = {}) {
  const store = new HubStore();
  const admin = store.createUser({ name: 'administrator', ...await hashPassword(password), role: 'admin', initialAdmin: true });
  const server = createHubServer({ store, allowInsecureLocal: true, ...options });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', data, cookie, headers = {}, ...rest } = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'X-Bridge-Client': 'mobile-v1', ...(cookie ? { Cookie: cookie } : {}), ...(method === 'GET' ? {} : { Origin: origin, 'Content-Type': 'application/json' }), ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(data || {}) }), ...rest });
    const body = await response.clone().json().catch(() => null);
    return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], response };
  };
  const adminLogin = await call('/api/hub/login', { method: 'POST', data: { username: 'administrator', password } });
  const newUser = async name => {
    const invitation = await call('/api/hub/invitations', { method: 'POST', cookie: adminLogin.cookie });
    return call('/api/hub/register', { method: 'POST', data: { username: name, password, invite: invitation.body.invite } });
  };
  const pair = async (cookie, name) => {
    const code = await call('/api/hub/pairings', { method: 'POST', cookie, data: { name } });
    const connected = await call('/api/hub/connect', { method: 'POST', data: { pairingCode: code.body.pairingCode } });
    assert.equal(connected.status, 200); return connected.body;
  };
  const close = async () => { server.relay.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); store.close(); };
  return { store, admin, server, origin, call, newUser, pair, close, adminCookie: adminLogin.cookie };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 10)); }
  assert.fail('condition did not become ready');
}
async function fakeBridge(label) {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Set-Cookie', 'bridge_session=abcdef; HttpOnly; Path=/'); res.end('bridge'); return; }
    assert.equal(req.headers.cookie, 'bridge_session=abcdef'); assert.equal(req.headers['x-bridge-client'], 'mobile-v1');
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ label, thread, connected: true, cookieExposed: false }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); return server;
}

test('invite-only accounts, one-time owner pairing and session/CSRF enforcement', async () => {
  const h = await setup();
  try {
    assert.equal((await h.call('/api/hub/me')).status, 401);
    assert.equal((await h.call('/api/hub/register', { method: 'POST', data: { username: 'uninvited', password } })).status, 400);
    const invite = (await h.call('/api/hub/invitations', { method: 'POST', cookie: h.adminCookie })).body.invite;
    const registered = await Promise.all(['alice', 'bob'].map(username => h.call('/api/hub/register', { method: 'POST', data: { username, password, invite } })));
    assert.deepEqual(registered.map(value => value.status).sort(), [200, 400]);
    const owner = registered.find(value => value.status === 200);
    assert.equal(owner.body.user.role, 'user');
    assert.equal((await h.call('/api/hub/invitations', { method: 'POST', cookie: owner.cookie })).status, 403);
    assert.equal((await h.call('/api/hub/pairings', { method: 'POST', cookie: owner.cookie, headers: { Origin: 'https://malicious.invalid' } })).status, 403);
    const pairing = await h.call('/api/hub/pairings', { method: 'POST', cookie: owner.cookie });
    const results = await Promise.all([1, 2].map(() => h.call('/api/hub/connect', { method: 'POST', data: { pairingCode: pairing.body.pairingCode, name: '电脑' } })));
    assert.deepEqual(results.map(value => value.status).sort(), [200, 400]);
    const device = results.find(value => value.status === 200).body;
    assert.equal(h.store.device(device.deviceId).userId, owner.body.user.id);
    assert.equal((await h.call(`/devices/${device.deviceId}/context`, { cookie: h.adminCookie })).status, 404);
    const canonical = await h.call(`/devices/${device.deviceId}?thread=${thread}`, { cookie: owner.cookie, redirect: 'manual' });
    assert.equal(canonical.status, 308); assert.equal(canonical.response.headers.get('location'), `/devices/${device.deviceId}/?thread=${thread}`);
    assert.equal((await h.call(`/devices/${device.deviceId}/api/remote-access`, { cookie: owner.cookie })).status, 404);
    assert.equal((await h.call(`/devices/${device.deviceId}/api/recovery`, { method: 'PUT', cookie: owner.cookie, data: { autoStart: true } })).status, 404);
    assert.equal((await h.call('/api/hub/logout', { method: 'POST', cookie: owner.cookie })).status, 200);
    assert.equal((await h.call(`/devices/${device.deviceId}/context`, { cookie: owner.cookie })).status, 401);
  } finally { await h.close(); }
});

test('two accounts/devices with overlapping thread IDs cannot cross routes, and revoked connectors cannot reconnect', async () => {
  const h = await setup(); const bridges = [], connectors = [];
  try {
    const users = await Promise.all([h.newUser('alpha'), h.newUser('bravo')]);
    const devices = await Promise.all(users.map((user, i) => h.pair(user.cookie, `电脑 ${i}`)));
    for (let i = 0; i < 2; i++) {
      const bridge = await fakeBridge(`owner-${i}`); bridges.push(bridge);
      connectors.push(startConnector({ hubOrigin: h.origin, ...devices[i], bridgePort: bridge.address().port, allowInsecureLocal: true, reconnectMinMs: 10, reconnectMaxMs: 20 }));
    }
    await waitFor(() => devices.every(device => h.server.relay.status(device.deviceId)));
    const reads = await Promise.all(users.map((user, i) => h.call(`/devices/${devices[i].deviceId}/api/threads/${thread}`, { cookie: user.cookie })));
    assert.deepEqual(reads.map(read => read.body.label), ['owner-0', 'owner-1']);
    assert.equal((await h.call(`/devices/${devices[1].deviceId}/api/threads/${thread}`, { cookie: users[0].cookie })).status, 404);
    const context = await h.call(`/devices/${devices[0].deviceId}/context`, { cookie: users[0].cookie });
    assert.equal(context.body.user.id, users[0].body.user.id); assert.equal(context.body.device.online, true);
    assert.equal((await h.call(`/api/hub/devices/${devices[1].deviceId}`, { method: 'DELETE', cookie: users[0].cookie })).status, 404);
    assert.equal((await h.call(`/api/hub/devices/${devices[0].deviceId}`, { method: 'DELETE', cookie: users[0].cookie })).status, 200);
    assert.equal(h.store.authenticateDevice(devices[0].deviceToken), null);
    await waitFor(() => !h.server.relay.status(devices[0].deviceId));
    await new Promise(done => setTimeout(done, 70));
    assert.equal(h.server.relay.status(devices[0].deviceId), false);
    assert.equal((await h.call(`/devices/${devices[0].deviceId}/api/status`, { cookie: users[0].cookie })).status, 404);
  } finally {
    connectors.forEach(connector => connector.stop());
    await Promise.all(bridges.map(bridge => new Promise(done => { bridge.closeAllConnections(); bridge.close(done); })));
    await h.close();
  }
});

test('persisted data contains no passwords or bearer secrets and expiry is enforced', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'hub-store-')); const path = resolve(root, 'store.sqlite'); let store;
  try {
    let now = 100;
    store = new HubStore({ path, now: () => now });
    const admin = store.createUser({ name: 'administrator', ...await hashPassword(password), role: 'admin', initialAdmin: true });
    const invite = store.invite(admin.id);
    const session = store.issueSession(admin.id);
    const pairing = store.pairing(admin.id);
    const device = store.consumePairing(pairing.pairingCode);
    store.close(); store = new HubStore({ path, now: () => now });
    assert.ok(store.session(session.token)); assert.ok(store.authenticateDevice(device.deviceToken));
    const bytes = await readFile(path);
    for (const value of [password, invite.invite, session.token, pairing.pairingCode, device.deviceToken]) assert.equal(bytes.includes(Buffer.from(value)), false);
    const expiry = store.pairing(admin.id); now += 600001;
    assert.throws(() => store.consumePairing(expiry.pairingCode), { code: 'INVALID_PAIRING' });
    now += 7 * 86400000; assert.equal(store.session(session.token), null);
    assert.throws(() => store.createUser({ name: 'new-admin', salt: 'a', hash: 'b', role: 'admin', initialAdmin: true }), { code: 'ALREADY_INITIALIZED' });
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test('only explicit private proxy mode trusts its overwritten single-IP header', async () => {
  const h = await setup({ trustPrivateProxy: true });
  try {
    assert.equal((await h.call('/api/hub/login', { method: 'POST', data: { username: 'administrator', password }, headers: { 'X-Hub-Client-IP': 'invalid, spoof' } })).status, 503);
    for (let i = 0; i < 21; i++) await h.call('/api/hub/login', { method: 'POST', data: { username: 'missing-user', password }, headers: { 'X-Hub-Client-IP': '203.0.113.1' } });
    const other = await h.call('/api/hub/login', { method: 'POST', data: { username: 'administrator', password }, headers: { 'X-Hub-Client-IP': '203.0.113.2' } });
    assert.equal(other.status, 200);
  } finally { await h.close(); }
});

test('static revalidation remains behind device authentication and metadata JSON stays no-store', async () => {
  const h = await setup();
  try {
    const device = await h.pair(h.adminCookie, 'Static test');
    const asset = `/devices/${device.deviceId}/app.js`;
    const first = await fetch(h.origin + asset, { headers: { Cookie: h.adminCookie } });
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'private, no-cache');
    const etag = first.headers.get('etag'); assert.match(etag, /^"[a-f0-9]{64}"$/); await first.arrayBuffer();
    const second = await fetch(h.origin + asset, { headers: { Cookie: h.adminCookie, 'If-None-Match': etag } });
    assert.equal(second.status, 304); assert.equal(await second.text(), '');
    const unauthorized = await fetch(h.origin + asset, { headers: { 'If-None-Match': etag } });
    assert.equal(unauthorized.status, 401); assert.equal(unauthorized.headers.get('cache-control'), 'no-store');
    const context = await h.call(`/devices/${device.deviceId}/context`, { cookie: h.adminCookie, headers: { 'If-None-Match': etag } });
    assert.equal(context.status, 200); assert.equal(context.response.headers.get('cache-control'), 'no-store');
    assert.equal(context.response.headers.get('etag'), null);
    await h.call('/api/hub/logout', { method: 'POST', cookie: h.adminCookie });
    assert.equal((await fetch(h.origin + asset, { headers: { Cookie: h.adminCookie, 'If-None-Match': etag } })).status, 401);
  } finally { await h.close(); }
});
