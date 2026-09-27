import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, writeFile, readdir, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from '../hub/store.mjs';
import { HubRelay } from '../hub/relay.mjs';
import { hubResources, RelayBandwidth } from '../hub/resources.mjs';
import { pruneBackups } from '../deploy/maintenance.mjs';

test('daily metadata sweep removes only expired sessions and unusable invites/pairings', () => {
  let now = 100;
  const store = new HubStore({ now: () => now });
  try {
    const admin = store.createUser({ name: 'administrator', salt: 'salt', hash: 'hash', initialAdmin: true, role: 'admin' });
    const expiredSession = store.issueSession(admin.id);
    store.invite(admin.id); store.pairing(admin.id);
    now += 7 * 86400000;
    const activeSession = store.issueSession(admin.id);
    // issueSession already removes expired sessions; insert one to exercise the daily sweep itself.
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('expired', admin.id, now, 100);
    const usedInvite = store.invite(admin.id);
    const user = store.createUser({ name: 'registered', salt: 'salt', hash: 'hash', invite: usedInvite.invite });
    const usedPairing = store.pairing(user.id), device = store.consumePairing(usedPairing.pairingCode);
    const revokedPairing = store.pairing(admin.id), revoked = store.consumePairing(revokedPairing.pairingCode);
    store.revokeDevice(admin.id, revoked.deviceId);
    const activeInvite = store.invite(admin.id), activePairing = store.pairing(admin.id);
    assert.deepEqual(store.maintenance(), { sessions: 1, invitations: 2, pairings: 3, devices: 0 });
    assert.equal(store.session(expiredSession.token), null); assert.ok(store.session(activeSession.token));
    assert.ok(store.authenticateDevice(device.deviceToken)); assert.equal(store.authenticateDevice(revoked.deviceToken), null);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM invitations').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pairings').get().n, 1);
    assert.ok(store.consumePairing(activePairing.pairingCode));
    assert.ok(store.createUser({ name: 'survivor', salt: 'salt', hash: 'hash', invite: activeInvite.invite }));
  } finally { store.close(); }
});

test('account capacity preserves existing accounts and does not consume an invitation', () => {
  const store = new HubStore({ maxUsers: 1 });
  try {
    const admin = store.createUser({ name: 'administrator', salt: 'salt', hash: 'hash', initialAdmin: true, role: 'admin' });
    const invite = store.invite(admin.id);
    assert.throws(() => store.createUser({ name: 'extra', salt: 'salt', hash: 'hash', invite: invite.invite }), { code: 'LIMIT_REACHED' });
    assert.equal(store.db.prepare('SELECT used_at FROM invitations').get().used_at, null);
    assert.ok(store.userByUsername('administrator'));
  } finally { store.close(); }
});

test('aggregate frame scheduler paces FIFO turns, removes cancellation and retains no frame data', async () => {
  let now = 0, timer, cancelledTimers = 0;
  const bandwidth = new RelayBandwidth({ bytesPerSecond: 65536, now: () => now, setTimer: (callback, delay) => { timer = { callback, delay }; return timer; }, clearTimer: () => { timer = null; cancelledTimers++; } });
  const turns = [];
  await bandwidth.wait(65536); turns.push('first');
  const aborted = new AbortController();
  const cancelled = bandwidth.wait(65536, aborted.signal).catch(error => error.code);
  const second = bandwidth.wait(65536).then(() => turns.push('second'));
  const third = bandwidth.wait(65536).then(() => turns.push('third'));
  assert.equal(timer.delay, 1000); assert.equal(bandwidth.queue.length, 3);
  assert.ok(bandwidth.queue.every(entry => !('buffer' in entry) && !('data' in entry)));
  aborted.abort(); assert.equal(await cancelled, 'TRANSFER_CANCELLED');
  now = 1000; timer.callback(); await second;
  assert.deepEqual(turns, ['first', 'second']); assert.equal(timer.delay, 1000);
  now = 2000; timer.callback(); await third;
  assert.deepEqual(turns, ['first', 'second', 'third']); assert.equal(bandwidth.queue.length, 0);
  const last = new AbortController(); const pending = bandwidth.wait(65536, last.signal).catch(() => {});
  last.abort(); await pending; assert.equal(cancelledTimers, 1); assert.equal(bandwidth.timer, null);
});

class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.sent = []; }
  send(value) { this.sent.push(value); }
  close() { this.readyState = 3; }
  ping() {}
}
function request() {
  const req = Readable.from([]); req.method = 'GET'; req.headers = {};
  const res = new EventEmitter(); res.headersSent = false; res.writableFinished = false; res.destroy = () => {};
  return { req, res };
}

test('global/account admission and connector replacement cannot bypass shared request counters', async () => {
  const relay = new HubRelay({ maxGlobalInFlight: 3, maxUserInFlight: 2, maxDevices: 3, maxUserDevices: 2 });
  try {
    relay.attach('one', new Socket(), { userId: 'account' }); relay.attach('two', new Socket(), { userId: 'account' }); relay.attach('three', new Socket(), { userId: 'other' });
    assert.throws(() => relay.attach('four', new Socket(), { userId: 'third' }), { code: 'HUB_BUSY' });
    const first = request(), second = request(), third = request();
    const a = relay.proxy('one', first.req, first.res, '/api/status').catch(error => error.code);
    const b = relay.proxy('two', second.req, second.res, '/api/status').catch(error => error.code);
    const rejected = request(); await assert.rejects(relay.proxy('one', rejected.req, rejected.res, '/api/status'), { code: 'ACCOUNT_BUSY' });
    const c = relay.proxy('three', third.req, third.res, '/api/status').catch(error => error.code);
    const global = request(); await assert.rejects(relay.proxy('three', global.req, global.res, '/api/status'), { code: 'HUB_BUSY' });
    assert.equal(relay.active, 3);
    relay.attach('one', new Socket(), { userId: 'account' }); assert.equal(await a, 'DEVICE_OFFLINE'); assert.equal(relay.active, 2);
    relay.cancelDevice('two'); relay.cancelDevice('three'); await Promise.all([b, c]);
    assert.equal(relay.active, 0); assert.equal(relay.userRequests.size, 0); assert.equal(relay.bandwidth.queue.length, 0);
    relay.cancelDevice('three'); assert.equal(relay.active, 0);
  } finally { relay.close(); }
});

test('account connection cap rejects another device but permits authenticated replacement', () => {
  const relay = new HubRelay({ maxDevices: 8, maxUserDevices: 1 });
  try {
    relay.attach('one', new Socket(), { userId: 'account' });
    assert.throws(() => relay.attach('two', new Socket(), { userId: 'account' }), { code: 'ACCOUNT_BUSY' });
    relay.attach('one', new Socket(), { userId: 'account' }); assert.equal(relay.devices.size, 1);
  } finally { relay.close(); }
});

test('backup pruning preserves three newest rollback copies and unrelated paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-maintenance-'));
  try {
    const scope = { directory: root, pattern: /^release-\d{8}T\d{6}Z$/, directories: true };
    for (let i = 1; i <= 4; i++) {
      const path = join(root, `release-2026092${i}T000000Z`); await mkdir(path); await writeFile(join(path, 'app.txt'), 'backup'); await utimes(path, i, i);
    }
    await mkdir(join(root, 'runtime')); await mkdir(join(root, '.ssh')); await writeFile(join(root, 'release-20260925T000000Z'), 'regular file is not an app backup');
    assert.equal((await pruneBackups(scope)).length, 1);
    assert.deepEqual((await readdir(root)).sort(), ['.ssh', 'release-20260922T000000Z', 'release-20260923T000000Z', 'release-20260924T000000Z', 'release-20260925T000000Z', 'runtime']);
    await assert.rejects(pruneBackups(scope, { keep: 0 }));
    const alias = join(root, 'alias'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(pruneBackups({ ...scope, directory: alias }), /exact configured path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('environment limits reject malformed or unsafe unbounded configuration', () => {
  assert.equal(hubResources({}).maxGlobalInFlight, 24);
  for (const value of ['0', '-1', 'NaN', '1.5', '9999999999']) assert.throws(() => hubResources({ HUB_GLOBAL_REQUESTS: value }));
});

test('legacy revoked devices receive seven days from migration and valid credentials survive cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hub-revoked-retention-')); const path = join(root, 'hub.sqlite');
  let now = 1, store = new HubStore({ path, now: () => now });
  try {
    const admin = store.createUser({ name: 'administrator', salt: 'salt', hash: 'hash', initialAdmin: true, role: 'admin' });
    const revoked = store.consumePairing(store.pairing(admin.id).pairingCode);
    const active = store.consumePairing(store.pairing(admin.id).pairingCode);
    store.revokeDevice(admin.id, revoked.deviceId);
    store.db.exec('ALTER TABLE devices DROP COLUMN revoked_at'); store.close();
    now = 30 * 86400000;
    store = new HubStore({ path, now: () => now });
    assert.equal(store.db.prepare('SELECT revoked_at FROM devices WHERE id=?').get(revoked.deviceId).revoked_at, now);
    assert.equal(store.maintenance().devices, 0);
    now += 7 * 86400000 - 1; assert.equal(store.maintenance().devices, 0);
    now++; assert.equal(store.maintenance().devices, 1);
    assert.equal(store.authenticateDevice(revoked.deviceToken), null); assert.ok(store.authenticateDevice(active.deviceToken));
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    assert.equal(store.maintenance().devices, 0);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test('global device-record admission includes revoked records and never consumes a rejected code', () => {
  let now = 1;
  const store = new HubStore({ maxDeviceRecords: 2, now: () => now });
  try {
    const admin = store.createUser({ name: 'administrator', salt: 'salt', hash: 'hash', initialAdmin: true, role: 'admin' });
    const active = store.consumePairing(store.pairing(admin.id).pairingCode);
    const revoked = store.consumePairing(store.pairing(admin.id).pairingCode);
    store.revokeDevice(admin.id, revoked.deviceId);
    const code = store.pairing(admin.id);
    assert.throws(() => store.consumePairing(code.pairingCode), { code: 'LIMIT_REACHED' });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pairings WHERE used_at IS NULL').get().n, 1);
    // A lower configured cap after an upgrade only stops admission.
    store.maxDeviceRecords = 1; assert.ok(store.authenticateDevice(active.deviceToken));
    assert.throws(() => store.consumePairing(code.pairingCode), { code: 'LIMIT_REACHED' });
    now += 7 * 86400000; assert.equal(store.maintenance().devices, 1);
    store.maxDeviceRecords = 2;
    const next = store.pairing(admin.id); assert.ok(store.consumePairing(next.pairingCode));
    assert.ok(store.authenticateDevice(active.deviceToken));
  } finally { store.close(); }
});
