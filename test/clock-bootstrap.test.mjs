import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { HubStore } from '../hub/store.mjs';
import { createHubServer } from '../hub/server.mjs';
import { createClockBootstrap } from '../hub/clock-bootstrap.mjs';
import { CLOCK_PATH, clockSecretHash, pairingClockSubject, clockRequestMac, clockResponseMac, equalClockMac, validClockRequest } from '../src/clock-protocol.mjs';

const secret = () => randomBytes(32).toString('base64url');
function request(key, { origin = 'https://hub.example', type = 'device', subject = randomUUID(), nonce = secret() } = {}) {
  const value = { version: 1, type, origin, subject, nonce };
  return { ...value, mac: clockRequestMac(key, value) };
}
function fixture(t) {
  let now = Date.now();
  const store = new HubStore({ now: () => now }); t.after(() => store.close());
  const owner = store.createUser({ name: 'owner', salt: 'test-salt', hash: 'test-hash', role: 'admin', initialAdmin: true });
  const device = store.consumePairing(store.pairing(owner.id).pairingCode);
  return { store, owner, device, time: value => { now = value; }, now: () => now };
}

test('clock MACs bind direction, origin, credential type, subject, nonce and server epoch', () => {
  const hash = clockSecretHash(secret()), req = request(hash);
  const response = { ...req, serverTime: Date.now() };
  const mac = clockResponseMac(hash, response);
  assert.notEqual(req.mac, mac);
  assert.equal(equalClockMac(mac, clockResponseMac(hash, response)), true);
  assert.notEqual(req.mac, clockRequestMac(clockSecretHash(secret()), req));
  for (const [key, value] of Object.entries({ origin: 'https://other.example', type: 'pairing', subject: randomUUID(), nonce: secret() })) {
    assert.notEqual(req.mac, clockRequestMac(hash, { ...req, [key]: value }));
    assert.notEqual(mac, clockResponseMac(hash, { ...response, [key]: value }));
  }
  assert.notEqual(mac, clockResponseMac(hash, { ...response, serverTime: response.serverTime + 1 }));
  assert.notEqual(pairingClockSubject(hash), hash);
  assert.equal(equalClockMac([mac], mac), false);
});

test('request shape rejects coercible nonstrings and all unsupported fields/origins', () => {
  const req = request(clockSecretHash(secret())); assert.equal(validClockRequest(req), true);
  for (const field of ['subject', 'nonce', 'mac', 'origin']) assert.equal(validClockRequest({ ...req, [field]: [req[field]] }), false);
  for (const origin of ['http://hub.example', 'https://u:p@hub.example', 'https://hub.example/path', 'https://hub.example/', 'https://hub.example?x=1']) assert.equal(validClockRequest({ ...req, origin }), false);
  assert.equal(validClockRequest({ ...req, rawToken: secret() }), false);
  assert.equal(validClockRequest({ ...req, version: 2 }), false);
});

test('bootstrap authenticates device/pairing independently and blocks replay or disabled credentials', t => {
  const f = fixture(t), bootstrap = createClockBootstrap({ store: f.store });
  const hash = clockSecretHash(f.device.deviceToken), req = request(hash, { subject: f.device.deviceId });
  const response = bootstrap(req, req.origin, 'peer');
  assert.equal(response.serverTime, f.now()); assert.equal(equalClockMac(response.mac, clockResponseMac(hash, response)), true);
  assert.throws(() => bootstrap(req, req.origin, 'other-peer'), e => e.code === 'CLOCK_AUTH_FAILED');
  for (const bad of [{ ...req, nonce: secret() }, request(clockSecretHash(secret()), { subject: f.device.deviceId }), request(hash, { subject: f.device.deviceId, origin: 'https://other.example' })]) assert.throws(() => bootstrap(bad, req.origin, 'peer'), e => e.code === 'CLOCK_AUTH_FAILED');
  const pairing = f.store.pairing(f.owner.id), pairingHash = clockSecretHash(pairing.pairingCode);
  const pairingReq = () => request(pairingHash, { type: 'pairing', subject: pairingClockSubject(pairingHash) });
  assert.equal(bootstrap(pairingReq(), req.origin, 'peer').type, 'pairing');
  f.store.consumePairing(pairing.pairingCode);
  assert.throws(() => bootstrap(pairingReq(), req.origin, 'peer'), e => e.code === 'CLOCK_AUTH_FAILED');
  const expired = f.store.pairing(f.owner.id), expiredHash = clockSecretHash(expired.pairingCode);
  f.time(expired.expiresAt);
  assert.throws(() => bootstrap(request(expiredHash, { type: 'pairing', subject: pairingClockSubject(expiredHash) }), req.origin, 'peer'), e => e.code === 'CLOCK_AUTH_FAILED');
  f.store.db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(f.owner.id);
  assert.throws(() => bootstrap(request(hash, { subject: f.device.deviceId }), req.origin, 'peer'), e => e.code === 'CLOCK_AUTH_FAILED');
  f.store.db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(f.owner.id);
  f.store.revokeDevice(f.owner.id, f.device.deviceId);
  assert.throws(() => bootstrap(request(hash, { subject: f.device.deviceId }), req.origin, 'peer'), e => e.code === 'CLOCK_AUTH_FAILED');
});

test('bootstrap replay and rate maps stay bounded by monotonic time despite Hub wall jumps', () => {
  let mono = 0, wall = Date.now(); const hash = clockSecretHash(secret()), subject = randomUUID();
  const bootstrap = createClockBootstrap({ store: { clockKey: () => hash, now: () => wall }, monotonic: () => mono, maxSubjects: 2, maxPeers: 2, requestsPerMinute: 2 });
  const req = request(hash, { subject }); bootstrap(req, req.origin, 'one');
  wall += 730 * 86400000;
  assert.throws(() => bootstrap(req, req.origin, 'one'), e => e.code === 'CLOCK_AUTH_FAILED');
  assert.throws(() => bootstrap(request(hash, { subject }), req.origin, 'one'), e => e.code === 'CLOCK_BUSY');
  bootstrap(request(hash, { subject }), req.origin, 'two');
  assert.throws(() => bootstrap(request(hash, { subject }), req.origin, 'three'), e => e.code === 'CLOCK_BUSY');
  mono = 60000;
  assert.throws(() => bootstrap(request(hash, { subject }), req.origin, 'three'), e => e.code === 'CLOCK_BUSY');
  mono = 120000;
  assert.equal(bootstrap(req, req.origin, 'three').serverTime, wall);
});

test('real Hub endpoint uses only opaque proofs, accepts pairing, and bounds input before browser auth', async t => {
  const f = fixture(t), server = createHubServer({ store: f.store, allowInsecureLocal: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const hash = clockSecretHash(f.device.deviceToken), req = request(hash, { origin, subject: f.device.deviceId });
  const post = (value, extra = {}) => fetch(origin + CLOCK_PATH, { method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: typeof value === 'string' ? value : JSON.stringify(value) });
  const result = await post(req); assert.equal(result.status, 200); const response = await result.json();
  assert.equal(equalClockMac(response.mac, clockResponseMac(hash, response)), true);
  const encoded = JSON.stringify({ request: req, response }); assert.equal(encoded.includes(f.device.deviceToken), false); assert.equal(encoded.includes(hash), false);
  assert.equal((await post(req)).status, 401);
  const pairing = f.store.pairing(f.owner.id), pairingHash = clockSecretHash(pairing.pairingCode);
  const pairingReq = request(pairingHash, { origin, type: 'pairing', subject: pairingClockSubject(pairingHash) });
  assert.equal((await post(pairingReq)).status, 200);
  const encodedPairing = JSON.stringify(pairingReq); assert.equal(encodedPairing.includes(pairing.pairingCode), false); assert.equal(encodedPairing.includes(pairingHash), false);
  for (const bad of [{ ...req, secret: secret() }, { ...req, subject: [req.subject] }, 'x'.repeat(4097)]) assert.notEqual((await post(bad)).status, 200);
  assert.equal((await post(req, { authorization: 'Bearer fixture' })).status, 503);
  assert.equal((await post(req, { cookie: 'fixture=1' })).status, 503);
});
