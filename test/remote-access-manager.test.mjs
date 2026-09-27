import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRemoteAccessManager, remoteStatePath, writeRemoteJson } from '../src/remote-access.mjs';

test('serialized starts configure one code once, save no plaintext, and stop before changing auth', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-manager-'));
  try {
    await mkdir(resolve(root, '.local/tools'), { recursive: true });
    await writeFile(resolve(root, '.local/tools/cloudflared.exe'), 'fake');
    let configured = 0;
    let revoked = 0;
    let configuredCode;
    const manager = createRemoteAccessManager({ root, platform: 'win32', isAlive: () => false,
      loadConfig: async options => { assert.deepEqual(options.env, {}); return { port: 5001 }; },
      createAuth: () => ({ configure: async code => { configured++; configuredCode = code; }, revokeAll: async () => { revoked++; } }),
      launchWindows: async options => { assert.match(options.instanceName, /^remote-[a-f0-9]{32}$/); assert.equal(options.logName, 'remote'); assert.match(options.env.BRIDGE_REMOTE_RUN_ID, /^[a-f0-9-]{36}$/); return { pid: 123 }; } });
    const [first, second] = await Promise.all([manager.start(), manager.start()]);
    assert.equal(configured, 1);
    assert.match(first.accessCode, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(second.accessCode, undefined);
    const saved = await readFile(resolve(root, '.local/remote-access.json'), 'utf8');
    assert.equal(saved.includes(configuredCode), false);
    const config = JSON.parse(saved);
    assert.equal(config.bridgePort, 5001);
    await writeRemoteJson(remoteStatePath(root, config.runId), { runId: config.runId, pid: 321, state: 'stopped', updatedAt: Date.now() });
    await manager.stop();
    assert.equal(revoked, 1);
    await manager.start();
    assert.equal(configured, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unconfirmed live runner stop refuses credential reset', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-stop-'));
  try {
    await mkdir(resolve(root, '.local/tools'), { recursive: true });
    await writeFile(resolve(root, '.local/tools/cloudflared.exe'), 'fake');
    await writeRemoteJson(resolve(root, '.local/remote-access.json'), { enabled: true, runId: 'old', wrapperPid: 55 });
    await writeRemoteJson(remoteStatePath(root, 'old'), { runId: 'old', pid: 56, state: 'running', updatedAt: Date.now() });
    let revoked = false;
    const manager = createRemoteAccessManager({ root, platform: 'win32', isAlive: () => true, stopTimeoutMs: 0,
      createAuth: () => ({ revokeAll: async () => { revoked = true; } }) });
    await assert.rejects(manager.stop(), { code: 'REMOTE_BUSY', status: 409 });
    await assert.rejects(manager.start(), { code: 'REMOTE_BUSY', status: 409 });
    assert.equal(revoked, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ambiguous WMI launch is invalidated and can stop and restart with a new immutable run identity', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-launch-fail-'));
  try {
    await mkdir(resolve(root, '.local/tools'), { recursive: true });
    await writeFile(resolve(root, '.local/tools/cloudflared.exe'), 'fake');
    let launches = 0;
    const runIds = [];
    const manager = createRemoteAccessManager({ root, platform: 'win32', isAlive: () => false,
      loadConfig: async () => ({ port: 4317 }), createAuth: () => ({ configure: async () => {}, revokeAll: async () => {} }),
      launchWindows: async options => {
        runIds.push(options.env.BRIDGE_REMOTE_RUN_ID);
        if (++launches === 1) throw new Error('timeout, launch may have happened');
        return { pid: 123 };
      } });
    await assert.rejects(manager.start(), { code: 'REMOTE_UNAVAILABLE', status: 503 });
    const invalidated = await readFile(resolve(root, '.local/remote-access.json'), 'utf8');
    assert.equal(JSON.parse(invalidated).enabled, false);
    await manager.stop();
    assert.ok((await manager.start()).accessCode);
    assert.notEqual(runIds[0], runIds[1]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('future heartbeats cannot publish a URL and setup errors surface safe API guidance', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-future-'));
  try {
    await writeRemoteJson(resolve(root, '.local/remote-access.json'), { enabled: true, runId: 'future' });
    await writeRemoteJson(remoteStatePath(root, 'future'), { runId: 'future', pid: 123, state: 'running', url: 'https://future.trycloudflare.com', updatedAt: 1001 });
    const manager = createRemoteAccessManager({ root, platform: 'win32', now: () => 1000, isAlive: () => true });
    const state = await manager.status();
    assert.equal(state.state, 'waiting'); assert.equal(state.url, null);
    await assert.rejects(manager.start(), error => error.code === 'REMOTE_UNAVAILABLE' && error.status === 503 && error.message.includes('cloudflared'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
