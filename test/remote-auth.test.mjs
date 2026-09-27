import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteAuth } from '../src/remote-auth.mjs';

const password = 'test password with sufficient length';
test('remote auth persists hashes, survives restart, expires and revokes sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-auth-'));
  try {
    let now = 100000; const path = join(dir, 'auth.json');
    const auth = new RemoteAuth({ path, now: () => now, sessionTtlMs: 1000 });
    await auth.configure(password); const grant = await auth.login(password);
    const persisted = await readFile(path, 'utf8');
    assert.ok(!persisted.includes(password)); assert.ok(!persisted.includes(grant.token));
    const restarted = new RemoteAuth({ path, now: () => now });
    assert.deepEqual(await restarted.authenticate(grant.token), { expiresAt: 101000 });
    now = 101000; assert.equal(await restarted.authenticate(grant.token), null);
    const other = await restarted.login(password); await restarted.logout(other.token);
    assert.equal(await new RemoteAuth({ path, now: () => now }).authenticate(other.token), null);
    const last = await restarted.login(password); await restarted.revokeAll(); assert.equal(await restarted.authenticate(last.token), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('remote auth bounds session count, concurrency and global attempts', async () => {
  const auth = new RemoteAuth({ maxSessions: 2, rateLimit: 4 }); await auth.configure(password);
  const first = await auth.login(password), second = await auth.login(password), third = await auth.login(password);
  assert.equal(await auth.authenticate(first.token), null); assert.ok(await auth.authenticate(second.token)); assert.ok(await auth.authenticate(third.token));
  await assert.rejects(auth.login('wrong'), { code: 'INVALID_CREDENTIALS' });
  await assert.rejects(auth.login(password), { code: 'LOGIN_THROTTLED' });
  const concurrent = new RemoteAuth(); await concurrent.configure(password);
  const a = concurrent.login(password), b = concurrent.login(password);
  await assert.rejects(concurrent.login(password), { code: 'LOGIN_THROTTLED' }); await Promise.all([a, b]);
});
test('unconfigured and corrupt auth state fail closed', async () => {
  const auth = new RemoteAuth(); assert.equal(await auth.isConfigured(), false);
  await assert.rejects(auth.login(password), { code: 'AUTH_NOT_CONFIGURED' });
  const dir = await mkdtemp(join(tmpdir(), 'bridge-auth-'));
  try { const path = join(dir, 'auth.json'); await writeFile(path, '{broken'); await assert.rejects(new RemoteAuth({ path }).authenticate('anything'), { code: 'AUTH_UNAVAILABLE' }); }
  finally { await rm(dir, { recursive: true, force: true }); }
});
