import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { launchWindowsBridge, windowsLaunchScript } from '../scripts/windows-launch.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

test('Windows broker launch encodes explicit settings and quotes PowerShell literals', () => {
  const script = windowsLaunchScript({ root: "C:\\bridge's root", nodePath: 'C:\\node.exe', serverPath: 'C:\\server.mjs', env: { BRIDGE_PORT: '4317' } });
  assert.match(script, /Invoke-CimMethod -ClassName Win32_Process/);
  assert.match(script, /bridge''s root/);
  assert.match(script, /ShowWindow = \[uint16\]0/);
});

test('Windows broker failure is visible and has no detached fallback', async () => {
  await assert.rejects(launchWindowsBridge({ root: 'C:\\bridge', env: {} }, async () => { throw new Error('WMI unavailable'); }), /Windows independent launch failed: WMI unavailable/);
});

test('Windows service survives termination of the entire launcher Job Object', { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
  const proofRoot = mkdtempSync(resolve(tmpdir(), 'bridge-job-proof-'));
  try {
    mkdirSync(resolve(proofRoot, 'scripts'));
    mkdirSync(resolve(proofRoot, '.local'));
    copyFileSync(resolve(root, 'scripts/windows-service.ps1'), resolve(proofRoot, 'scripts/windows-service.ps1'));
    writeFileSync(resolve(proofRoot, 'proof-server.mjs'), `import http from 'node:http'; import { writeFileSync } from 'node:fs'; console.log('proof stdout'); console.error('proof stderr'); const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/plain'); res.end('bridge-proof'); }); server.listen(0, '127.0.0.1', () => writeFileSync('.local/server.json', JSON.stringify({ pid: process.pid, port: server.address().port })));`);
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(root, 'test/fixtures/windows-job-proof.ps1'),
      '-NodePath', process.execPath, '-ParentScript', resolve(root, 'test/fixtures/windows-job-parent.mjs'), '-ProofRoot', proofRoot
    ], { windowsHide: true, timeout: 35000 });
    const evidence = JSON.parse(stdout.trim());
    assert.equal(evidence.survivedJobTermination, true);
    assert.match(readFileSync(resolve(proofRoot, '.local/bridge.stdout.log'), 'utf8'), /proof stdout/);
    assert.match(readFileSync(resolve(proofRoot, '.local/bridge.stderr.log'), 'utf8'), /proof stderr/);
    t.diagnostic(JSON.stringify(evidence));
  } finally {
    rmSync(proofRoot, { recursive: true, force: true });
  }
});
