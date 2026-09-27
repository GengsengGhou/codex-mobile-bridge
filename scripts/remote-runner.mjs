import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { remoteRoot, remoteStatePath, readRemoteJson, writeRemoteJson } from '../src/remote-access.mjs';

export function parseQuickTunnelUrl(text) {
  const match = String(text).match(/(?:^|[\s|])https:\/\/([a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com)(?=$|[\s|])/);
  return match ? `https://${match[1]}` : null;
}

export function isTunnelRegistered(line) {
  return /(?:^|\s)INF Registered tunnel connection(?:\s|$)/.test(line);
}

export async function runRemoteAccess({ root = remoteRoot, spawnProcess = spawn,
  createGateway, createAuth, sleep = ms => new Promise(done => setTimeout(done, ms)),
  now = Date.now, pollMs = 250, retryMs = 1000, terminateTimeoutMs = 3000, startupTimeoutMs = 60000,
  resolvePublicHost = lookup, dnsLookupTimeoutMs = 1000, dnsRetryMs = 1000,
  expectedRunId = process.env.BRIDGE_REMOTE_RUN_ID,
  pid = process.pid, shouldStop = () => false } = {}) {
  const configPath = resolve(root, '.local/remote-access.json');
  const initial = await readRemoteJson(configPath);
  if (!initial?.enabled || !expectedRunId || initial.runId !== expectedRunId) return;
  if (typeof initial.runId !== 'string' || !initial.runId ||
      ![initial.gatewayPort, initial.bridgePort].every(port => Number.isInteger(port) && port >= 1024 && port <= 65535)) {
    throw new Error('Invalid remote runner configuration.');
  }
  const runId = initial.runId;
  const statePath = remoteStatePath(root, runId);
  const runnerId = randomUUID();
  await writeRemoteJson(statePath, { runId, runnerId, pid, state: 'starting', url: null, lastError: null, updatedAt: now() });
  const claimedConfig = await readRemoteJson(configPath);
  if (shouldStop() || !claimedConfig?.enabled || claimedConfig.runId !== runId) {
    await writeRemoteJson(statePath, { runId, runnerId, pid, state: 'stopped', url: null, lastError: null, updatedAt: now() });
    return;
  }
  const auth = createAuth ? await createAuth(resolve(root, '.local/remote-auth.json'))
    : new (await import('../src/remote-auth.mjs')).RemoteAuth({ path: resolve(root, '.local/remote-auth.json') });
  const gatewayFactory = createGateway || (await import('../src/remote-gateway.mjs')).createRemoteGateway;
  if (auth.isConfigured && !await auth.isConfigured()) throw new Error('Remote login has not been configured.');
  let child = null;
  let gateway = null;
  let lastError = null;
  let retries = 0;
  const exitedChildren = new WeakSet();
  const enabled = async () => {
    const config = await readRemoteJson(configPath);
    return !shouldStop() && config?.enabled && config.runId === runId;
  };
  const report = async (state, url = null) => {
    if ((await readRemoteJson(configPath))?.runId !== runId) return;
    await writeRemoteJson(statePath, { runId, runnerId, pid, state, url, lastError, updatedAt: now() });
  };
  async function closeGateway() {
    if (!gateway) return;
    const closing = gateway;
    gateway = null;
    await new Promise(done => {
      closing.close(() => done());
      closing.closeAllConnections?.();
    });
  }
  async function closeChild() {
    if (!child) return;
    const closing = child;
    child = null;
    if (exitedChildren.has(closing)) return;
    let exited = false;
    closing.once('exit', () => { exited = true; });
    closing.kill('SIGTERM');
    const deadline = now() + terminateTimeoutMs;
    while (!exited && now() < deadline) await sleep(50);
    if (!exited) {
      closing.kill('SIGKILL');
      const finalDeadline = now() + terminateTimeoutMs;
      while (!exited && now() < finalDeadline) await sleep(50);
      if (!exited) throw new Error('Owned tunnel process did not exit.');
    }
  }
  try {
    while (await enabled()) {
      await report('starting');
      if (!await enabled()) break;
      const startupDeadline = now() + startupTimeoutMs;
      let candidate = null;
      let registered = false;
      let dnsReady = false;
      let nextDnsLookupAt = 0;
      let exited = false;
      let failed = false;
      let buffer = '';
      child = spawnProcess(resolve(root, '.local/tools/cloudflared.exe'), [
        'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${initial.gatewayPort}`
      ], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const activeChild = child;
      child.once('exit', () => { exitedChildren.add(activeChild); exited = true; });
      child.once('error', () => { exitedChildren.add(activeChild); failed = true; exited = true; });
      const receive = chunk => {
        buffer = (buffer + String(chunk)).slice(-8192);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) {
          candidate ||= parseQuickTunnelUrl(line);
          registered ||= isTunnelRegistered(line);
        }
      };
      child.stdout?.on('data', receive);
      child.stderr?.on('data', receive);
      let ready = false;
      while (!exited && await enabled()) {
        if (!(ready && registered) && now() >= startupDeadline) {
          lastError = '隧道未能在 60 秒内完成连接，正在重试。';
          failed = true;
          break;
        }
        if (candidate && !ready) {
          gateway = await gatewayFactory({ publicOrigin: candidate,
            bridgeOrigin: `http://127.0.0.1:${initial.bridgePort}`, auth });
          try {
            await new Promise((done, reject) => {
              gateway.once('error', reject);
              gateway.listen(initial.gatewayPort, '127.0.0.1', () => {
                gateway.removeListener('error', reject);
                done();
              });
            });
            ready = true;
            lastError = null;
            retries = 0;
          } catch {
            lastError = 'The remote gateway port is unavailable.';
            failed = true;
            break;
          }
        }
        if (ready && registered && !dnsReady) {
          lastError = '临时网址正在生效，请稍候';
          await report('starting');
          if (now() >= nextDnsLookupAt) {
            const lookupStartedAt = now();
            let timeout;
            try {
              const resolved = await Promise.race([
                Promise.resolve().then(() => resolvePublicHost(new URL(candidate).hostname)),
                new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('DNS lookup timed out')), Math.min(1000, dnsLookupTimeoutMs)); })
              ]);
              dnsReady = Boolean(resolved && (typeof resolved === 'string' || resolved.address));
            } catch { /* A new Quick Tunnel hostname may take time to propagate. */ }
            finally { clearTimeout(timeout); }
            nextDnsLookupAt = lookupStartedAt + dnsRetryMs;
            if (dnsReady) lastError = null;
          }
        }
        if (exited || !await enabled()) break;
        const publicReady = ready && registered && dnsReady;
        await report(publicReady ? 'running' : 'starting', publicReady ? candidate : null);
        await sleep(pollMs);
      }
      await closeGateway();
      await closeChild();
      if (!await enabled()) break;
      lastError ||= failed ? 'The tunnel could not start.' : 'The tunnel disconnected; retrying.';
      await report('waiting');
      const until = now() + Math.min(30000, retryMs * 2 ** Math.min(retries++, 5));
      while (now() < until && await enabled()) { await sleep(pollMs); await report('waiting'); }
    }
    await report('stopped');
  } catch {
    lastError = 'The remote runner failed; inspect its local setup.';
    await closeGateway();
    await closeChild();
    await report('error');
    throw new Error(lastError);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stopping = false;
  process.on('SIGTERM', () => { stopping = true; });
  process.on('SIGINT', () => { stopping = true; });
  try { await runRemoteAccess({ shouldStop: () => stopping }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
