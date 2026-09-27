import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parseQuickTunnelUrl, isTunnelRegistered, runRemoteAccess } from '../scripts/remote-runner.mjs';
import { remoteStatePath, readRemoteJson, writeRemoteJson } from '../src/remote-access.mjs';
import { windowsLaunchScript } from '../scripts/windows-launch.mjs';

test('remote Windows instance has a separate mutex and log prefix', () => {
  const base = { root: 'C:\\bridge', nodePath: 'C:\\node.exe', supervisorPath: 'C:\\runner.mjs', env: {} };
  const decode = script => JSON.parse(Buffer.from(script.match(/-LaunchData ([A-Za-z0-9+/=]+)/)[1], 'base64').toString());
  const normal = decode(windowsLaunchScript(base));
  const remote = decode(windowsLaunchScript({ ...base, instanceName: 'remote' }));
  assert.notEqual(normal.mutexName, remote.mutexName);
  assert.equal(normal.logName, 'bridge'); assert.equal(remote.logName, 'remote');
  assert.throws(() => windowsLaunchScript({ ...base, instanceName: '../unsafe' }), /Invalid/);
});

test('only exact HTTPS quick tunnel origins are accepted', () => {
  assert.equal(parseQuickTunnelUrl('| https://fresh-url.trycloudflare.com |'), 'https://fresh-url.trycloudflare.com');
  for (const value of ['http://fresh.trycloudflare.com', 'https://fresh.trycloudflare.com.evil.com', 'https://fresh.trycloudflare.com/path', 'https://fresh.trycloudflare.com:443', 'https://evil.com', 'https://x.trycloudflare.com@evil.com']) assert.equal(parseQuickTunnelUrl(value), null);
});

test('registration marker requires the cloudflared info event', () => {
  assert.equal(isTunnelRegistered('2026-09-26T00:00:00Z INF Registered tunnel connection connIndex=0'), true);
  assert.equal(isTunnelRegistered('ERR Registered tunnel connection failed'), false);
  assert.equal(isTunnelRegistered('Some message about Registered tunnel connection'), false);
});

test('late old run exits before opening auth or spawning a tunnel', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-stale-'));
  try {
    await writeRemoteJson(resolve(root, '.local/remote-access.json'), { enabled: true, runId: 'new', gatewayPort: 4318, bridgePort: 4317 });
    await runRemoteAccess({ root, expectedRunId: 'old', createAuth: () => { assert.fail('stale auth opened'); }, spawnProcess: () => { assert.fail('stale tunnel spawned'); } });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('URL alone never publishes running and unregistered startup has a bounded deadline', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-unready-'));
  try {
    const configPath = resolve(root, '.local/remote-access.json');
    await writeRemoteJson(configPath, { enabled: true, runId: 'deadline', gatewayPort: 4318, bridgePort: 4317 });
    let time = 0;
    let killed = false;
    await runRemoteAccess({ root, expectedRunId: 'deadline', startupTimeoutMs: 10, pollMs: 5, retryMs: 5,
      resolvePublicHost: async () => ({ address: '127.0.0.1' }),
      now: () => time, createAuth: async () => ({}),
      spawnProcess: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { killed = true; child.emit('exit', 0); };
        queueMicrotask(() => child.stderr.emit('data', '| https://waiting.trycloudflare.com |\n'));
        return child;
      },
      createGateway: () => {
        const server = new EventEmitter(); server.listen = (_port, _host, done) => done(); server.close = done => done(); return server;
      },
      sleep: async ms => {
        time += ms;
        const state = await readRemoteJson(remoteStatePath(root, 'deadline'));
        assert.notEqual(state.state, 'running'); assert.equal(state.url, null);
        if (state.state === 'waiting') {
          assert.match(state.lastError, /60/);
          await writeRemoteJson(configPath, { enabled: false, runId: 'deadline' });
        }
      } });
    assert.equal(killed, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered tunnel survives DNS propagation beyond startup deadline, then resolution is cached', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-dns-'));
  try {
    const configPath = resolve(root, '.local/remote-access.json');
    await writeRemoteJson(configPath, { enabled: true, runId: 'dns', gatewayPort: 4318, bridgePort: 4317 });
    let time = 0;
    let lookups = 0;
    let runningTicks = 0;
    let spawned = 0;
    await runRemoteAccess({ root, expectedRunId: 'dns', startupTimeoutMs: 10, pollMs: 5, dnsRetryMs: 10, now: () => time,
      createAuth: async () => ({}),
      resolvePublicHost: async hostname => {
        assert.equal(hostname, 'delayed.trycloudflare.com');
        if (++lookups < 3) throw Object.assign(new Error('not propagated'), { code: 'ENOTFOUND' });
        return { address: '104.16.1.1', family: 4 };
      },
      spawnProcess: () => {
        spawned++;
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => child.emit('exit', 0);
        queueMicrotask(() => child.stderr.emit('data', '| https://delayed.trycloudflare.com |\n2026-09-26 INF Registered tunnel connection connIndex=0\n'));
        return child;
      },
      createGateway: () => {
        const server = new EventEmitter(); server.listen = (_port, _host, done) => done(); server.close = done => done(); return server;
      },
      sleep: async ms => {
        time += ms;
        const state = await readRemoteJson(remoteStatePath(root, 'dns'));
        if (lookups < 3) {
          assert.equal(state.state, 'starting'); assert.equal(state.url, null);
          if (lookups > 0) assert.equal(state.lastError, '临时网址正在生效，请稍候');
        } else {
          assert.equal(state.state, 'running'); assert.equal(state.url, 'https://delayed.trycloudflare.com');
          assert.equal(state.lastError, null);
          if (++runningTicks === 3) await writeRemoteJson(configPath, { enabled: false, runId: 'dns' });
        }
      } });
    assert.equal(lookups, 3); assert.equal(runningTicks, 3); assert.equal(spawned, 1);
    assert.ok(time > 10);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a stalled DNS lookup times out and allows an already-requested stop', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-dns-stop-'));
  try {
    const configPath = resolve(root, '.local/remote-access.json');
    await writeRemoteJson(configPath, { enabled: true, runId: 'dns-stop', gatewayPort: 4318, bridgePort: 4317 });
    let killed = false;
    await runRemoteAccess({ root, expectedRunId: 'dns-stop', pollMs: 1, dnsLookupTimeoutMs: 10,
      createAuth: async () => ({}),
      resolvePublicHost: async () => {
        await writeRemoteJson(configPath, { enabled: false, runId: 'dns-stop' });
        return new Promise(() => {});
      },
      spawnProcess: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => { killed = true; child.emit('exit', 0); };
        queueMicrotask(() => child.stderr.emit('data', '| https://stalled.trycloudflare.com |\n2026-09-26 INF Registered tunnel connection connIndex=0\n'));
        return child;
      },
      createGateway: () => {
        const server = new EventEmitter(); server.listen = (_port, _host, done) => done(); server.close = done => done(); return server;
      } });
    assert.equal(killed, true);
    const state = await readRemoteJson(remoteStatePath(root, 'dns-stop'));
    assert.equal(state.state, 'stopped'); assert.equal(state.url, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runner binds loopback after URL, replaces gateway on retry, and closes owned children', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-runner-'));
  try {
    const configPath = resolve(root, '.local/remote-access.json');
    await writeRemoteJson(configPath, { enabled: true, runId: 'test', gatewayPort: 4318, bridgePort: 5010 });
    const children = [];
    const origins = [];
    let closed = 0;
    let ticks = 0;
    let time = 0;
    await runRemoteAccess({ root, expectedRunId: 'test', pid: 123, now: () => time, retryMs: 1, pollMs: 1,
      resolvePublicHost: async () => ({ address: '127.0.0.1' }),
      createAuth: async () => ({}),
      spawnProcess: (exe, args) => {
        assert.ok(exe.endsWith('cloudflared.exe'));
        assert.deepEqual(args.slice(-2), ['--url', 'http://127.0.0.1:4318']);
        const child = new EventEmitter();
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
        children.push(child);
        queueMicrotask(() => child.stderr.emit('data', `| https://url-${children.length}.trycloudflare.com |\n2026-09-26T00:00:00Z INF Registered tunnel connection connIndex=0\n`));
        return child;
      },
      createGateway: ({ publicOrigin, bridgeOrigin }) => {
        origins.push(publicOrigin); assert.equal(bridgeOrigin, 'http://127.0.0.1:5010');
        const server = new EventEmitter();
        server.listen = (port, host, done) => { assert.equal(host, '127.0.0.1'); assert.equal(port, 4318); done(); };
        server.close = done => { closed++; done(); };
        return server;
      },
      sleep: async ms => {
        time += ms; ticks++;
        if (ticks === 2) { children[0].exitCode = 1; children[0].emit('exit', 1); }
        if (origins.length >= 2) await writeRemoteJson(configPath, { enabled: false, runId: 'test' });
      } });
    assert.deepEqual(origins, ['https://url-1.trycloudflare.com', 'https://url-2.trycloudflare.com']);
    assert.equal(closed, 2);
    assert.ok(children.every(child => child.exitCode !== null));
    const state = await readRemoteJson(remoteStatePath(root, 'test'));
    assert.equal(state.state, 'stopped'); assert.equal(state.url, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('occupied gateway is reported without publishing URL or killing the occupant', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'remote-conflict-'));
  try {
    const configPath = resolve(root, '.local/remote-access.json');
    await writeRemoteJson(configPath, { enabled: true, runId: 'conflict', gatewayPort: 4318, bridgePort: 4317 });
    let childKilled = false;
    let closed = false;
    await runRemoteAccess({ root, expectedRunId: 'conflict', retryMs: 1, createAuth: async () => ({}),
      resolvePublicHost: async () => ({ address: '127.0.0.1' }),
      spawnProcess: () => {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.exitCode = null;
        child.kill = () => { childKilled = true; child.exitCode = 0; child.emit('exit', 0); };
        queueMicrotask(() => child.stderr.emit('data', '| https://conflict.trycloudflare.com |\n'));
        return child;
      },
      createGateway: () => {
        const server = new EventEmitter(); server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error(), { code: 'EADDRINUSE' })));
        server.close = done => { closed = true; done(); }; return server;
      },
      sleep: async () => {
        const state = await readRemoteJson(remoteStatePath(root, 'conflict'));
        if (state?.state === 'waiting') {
          assert.equal(state.url, null); assert.match(state.lastError, /port is unavailable/);
          await writeRemoteJson(configPath, { enabled: false, runId: 'conflict' });
        }
      } });
    assert.ok(childKilled); assert.ok(closed);
  } finally { await rm(root, { recursive: true, force: true }); }
});
