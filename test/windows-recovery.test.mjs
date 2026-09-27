import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'node:net';
import { launchWindowsBridge } from '../scripts/windows-launch.mjs';
import { createRecoveryManager } from '../src/recovery.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
async function waitFor(check, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch {}
    await new Promise(done => setTimeout(done, 50));
  }
  throw new Error('Timed out waiting for isolated recovery proof.');
}
async function sparePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

test('independent Windows supervisor recovers crashes, rejects duplicates and disables without stopping child', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'bridge-recovery-proof-'));
  const port = await sparePort();
  let childPid, supervisorPid;
  const manager = createRecoveryManager({ root, platform: 'win32', registration: { read: async () => ({ enabled: false }) } });
  try {
    await mkdir(resolve(root, 'scripts'));
    await mkdir(resolve(root, '.local'));
    await copyFile(resolve(projectRoot, 'scripts/windows-service.ps1'), resolve(root, 'scripts/windows-service.ps1'));
    const serverPath = resolve(root, 'proof-server.mjs');
    const supervisorPath = resolve(root, 'proof-supervisor.mjs');
    await writeFile(serverPath, `import http from 'node:http'; const server=http.createServer((req,res)=>{res.end(JSON.stringify({pid:process.pid}));if(req.url==='/crash')setTimeout(()=>process.exit(23),20);}); server.listen(${port},'127.0.0.1');`);
    await writeFile(supervisorPath, `import {runSupervisor} from ${JSON.stringify(pathToFileURL(resolve(projectRoot, 'scripts/supervisor.mjs')).href)}; await runSupervisor({root:${JSON.stringify(root)},serverPath:${JSON.stringify(serverPath)},loadConfig:async()=>({callerThreadId:'proof',allowedSendThreadId:'proof',port:${port},enableSend:false,sendScope:'single'}),backoff:{baseMs:100,maximumMs:200}});`);
    const options = { root, nodePath: process.execPath, serverPath, supervisorPath, env: {} };
    await launchWindowsBridge(options);
    const state = await waitFor(async () => {
      const status = await manager.status();
      return status.supervisorRunning && status.childPid ? status : null;
    });
    supervisorPid = state.supervisorPid;
    childPid = state.childPid;
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}`)).ok);
    await launchWindowsBridge(options);
    await new Promise(done => setTimeout(done, 600));
    assert.equal((await manager.status()).supervisorPid, supervisorPid);
    assert.equal((await manager.status()).childPid, childPid);
    await fetch(`http://127.0.0.1:${port}/crash`);
    const recovered = await waitFor(async () => {
      const status = await manager.status();
      return status.childPid && status.childPid !== childPid && status.restartCount === 1 ? status : null;
    });
    childPid = recovered.childPid;
    await waitFor(async () => (await fetch(`http://127.0.0.1:${port}`)).ok);
    await manager.configure({ autoRestart: false });
    assert.equal((await (await fetch(`http://127.0.0.1:${port}`)).json()).pid, childPid);
    await manager.configure({ autoRestart: true });
    assert.equal((await manager.status()).childPid, childPid);
    await manager.configure({ autoRestart: false });
    await fetch(`http://127.0.0.1:${port}/crash`);
    await waitFor(async () => JSON.parse(await readFile(resolve(root, '.local/recovery-state.json'), 'utf8')).state === 'stopped');
    const finalState = JSON.parse(await readFile(resolve(root, '.local/recovery-state.json'), 'utf8'));
    assert.equal(finalState.restartCount, 1);
    childPid = null;
    await waitFor(() => { try { process.kill(supervisorPid, 0); return false; } catch { return true; } });
    supervisorPid = null;
    t.diagnostic(JSON.stringify({ recovered: true, singleton: true, port, restartCount: finalState.restartCount }));
  } finally {
    // These PIDs are created by this isolated test and never taken from production state.
    await manager.configure({ autoRestart: false });
    for (const pid of [childPid, supervisorPid]) if (pid) { try { process.kill(pid); } catch {} }
    await new Promise(done => setTimeout(done, 300));
    await rm(root, { recursive: true, force: true });
  }
});
