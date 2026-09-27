import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { createRecoveryManager, writeRecoveryFile, readRecoveryFile, createWindowsRegistration, startupCommand } from '../src/recovery.mjs';
import { runSupervisor, restartDelay } from '../scripts/supervisor.mjs';

const fixture = async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'bridge-recovery-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};
const config = { callerThreadId: 'saved-caller', allowedSendThreadId: 'saved-allowed', port: 14317, enableSend: true, sendScope: 'single' };

test('recovery status reads actual startup and fresh supervision without desktop access', async t => {
  const root = await fixture(t);
  const registration = { read: async () => ({ enabled: true }) };
  const now = 100000;
  await writeRecoveryFile(resolve(root, '.local/recovery-state.json'), { state: 'running', supervisorPid: 123, childPid: 456, restartCount: 2, updatedAt: new Date(now).toISOString() });
  const manager = createRecoveryManager({ root, platform: 'win32', registration, now: () => now });
  assert.deepEqual((await manager.status()).supervisorRunning, true);
  assert.equal((await manager.status()).autoStart, true);
  assert.equal((await manager.status()).restartCount, 2);
  assert.equal((await createRecoveryManager({ root, platform: 'win32', registration, now: () => now + 10000 }).status()).state, 'unmanaged');
  assert.equal((await createRecoveryManager({ root, platform: 'win32', registration, now: () => now - 1 }).status()).supervisorRunning, false);
  assert.equal((await createRecoveryManager({ root, platform: 'linux' }).status()).supported, false);
});

test('settings serialize, survive lost registration response, and never claim unmanaged adoption', async t => {
  const root = await fixture(t);
  let enabled = false;
  const calls = [];
  const registration = { read: async () => ({ enabled }), set: async value => { calls.push(value); enabled = value; throw new Error('lost response'); } };
  const manager = createRecoveryManager({ root, platform: 'win32', registration });
  const results = await Promise.all([manager.configure({ autoStart: true, autoRestart: false }), manager.configure({ autoStart: false, autoRestart: true })]);
  assert.deepEqual(calls, [true, false]);
  assert.equal(results[0].autoRestart, false);
  assert.equal(results[1].restartRequired, true);
  assert.equal(results[1].supervisorRunning, false);
  assert.deepEqual(await readRecoveryFile(resolve(root, '.local/recovery.json')), { autoRestart: true });
  for (const settings of [{ autoStart: 1 }, { unknown: false }, {}, null]) await assert.rejects(manager.configure(settings), { code: 'INVALID_REQUEST' });
});

test('registration quotes paths, reads back actual values and refuses alien command replacement', async () => {
  const commands = [];
  const registry = createWindowsRegistration({ root: "C:\\b's root", nodePath: 'C:\\node.exe', execute: async (_, args) => {
    commands.push(Buffer.from(args.at(-1), 'base64').toString('utf16le'));
    return { stdout: '{"enabled":true,"conflict":false}' };
  } });
  await registry.set(true);
  await registry.set(false);
  assert.match(commands[0], /b''s root/);
  assert.match(commands[0], /登录启动项被其他命令占用/);
  assert.doesNotMatch(commands[0], /SilentlyContinue/);
  assert.match(commands[1], /Remove-ItemProperty/);
  assert.match(startupCommand('C:\\bridge', 'C:\\node.exe'), /WindowStyle Hidden/);
  assert.doesNotMatch(startupCommand('C:\\bridge'), /LaunchData|TOKEN|PIPE_PATH/);
});

test('supervisor restarts only exiting children, reloads settings and caps backoff', async t => {
  const root = await fixture(t);
  const children = [];
  const delays = [];
  let tick = 100000;
  let loads = 0;
  const operation = runSupervisor({ root, now: () => tick, heartbeatMs: 100000,
    loadConfig: async () => ({ ...config, enableSend: ++loads === 1 }), isPortOccupied: async () => false,
    spawnProcess: (_, args, options) => {
      const child = Object.assign(new EventEmitter(), { pid: 100 + children.length, options, args });
      children.push(child);
      setTimeout(() => child.emit('exit', 1, null), 10);
      return child;
    }, sleep: async delay => {
      delays.push(delay); tick += delay;
      if (delays.length === 3) await writeRecoveryFile(resolve(root, '.local/recovery.json'), { autoRestart: false });
    }, backoff: { baseMs: 5, maximumMs: 8 }
  });
  const state = await operation;
  assert.deepEqual(delays, [5, 8, 8]);
  assert.equal(children.length, 3);
  assert.equal(children[0].options.env.BRIDGE_ENABLE_SEND, '1');
  assert.equal(children[1].options.env.BRIDGE_ENABLE_SEND, '0');
  assert.equal(children[0].options.env.CODEX_APP_TOOLS_PIPE_PATH, undefined);
  assert.equal(state.state, 'stopped');
  assert.equal(state.restartCount, 2);
  assert.equal(restartDelay(1000), 30000);
});

test('disabling and re-enabling while child lives never replaces the child', async t => {
  const root = await fixture(t);
  let child;
  const manager = createRecoveryManager({ root, platform: 'win32', registration: { read: async () => ({ enabled: false }) } });
  const operation = runSupervisor({ root, loadConfig: async () => config, isPortOccupied: async () => false,
    spawnProcess: () => { child = Object.assign(new EventEmitter(), { pid: 987 }); return child; } });
  while (!(await manager.status()).supervisorRunning) await new Promise(done => setTimeout(done, 5));
  assert.equal((await manager.configure({ autoRestart: false })).childPid, 987);
  assert.equal((await manager.configure({ autoRestart: true })).childPid, 987);
  await manager.configure({ autoRestart: false });
  child.emit('exit', 0, null);
  assert.equal((await operation).restartCount, 0);
});

test('occupied port stops supervisor without spawning or killing a listener', async t => {
  const root = await fixture(t);
  const state = await runSupervisor({ root, loadConfig: async () => config, isPortOccupied: async () => true,
    spawnProcess: () => assert.fail('port occupant must be left alone') });
  assert.match(state.lastError, /端口已被占用/);
  assert.equal(state.restartCount, 0);
});

test('unknown registration fails status explicitly and conflicts surface a readable error', async t => {
  const root = await fixture(t);
  const unknown = createRecoveryManager({ root, platform: 'win32', registration: { read: async () => { throw new Error('denied'); } } });
  await assert.rejects(unknown.status(), { code: 'RECOVERY_UNAVAILABLE', status: 503 });
  const conflict = createRecoveryManager({ root, platform: 'win32', registration: { read: async () => ({ enabled: false, conflict: true }) } });
  assert.match((await conflict.status()).lastError, /被其他命令占用/);
});

test('state persistence failure never replaces a still running child', async t => {
  const root = await fixture(t);
  await writeRecoveryFile(resolve(root, '.local/recovery.json'), { autoRestart: false });
  let child, spawns = 0;
  let writeAttempts = 0;
  const operation = runSupervisor({ root, loadConfig: async () => config, isPortOccupied: async () => false,
    writeState: async () => { writeAttempts++; throw new Error('disk unavailable'); },
    spawnProcess: () => { spawns++; child = Object.assign(new EventEmitter(), { pid: 42 }); return child; } });
  while (!writeAttempts) await new Promise(done => setTimeout(done, 5));
  await new Promise(done => setTimeout(done, 20));
  assert.equal(spawns, 1);
  child.emit('exit', 0, null);
  await assert.rejects(operation, /disk unavailable/);
  assert.equal(spawns, 1);
});

test('early spawn errors are handled before slow state persistence completes', async t => {
  const root = await fixture(t);
  await writeRecoveryFile(resolve(root, '.local/recovery.json'), { autoRestart: false });
  const state = await runSupervisor({ root, loadConfig: async () => config, isPortOccupied: async () => false,
    writeState: async (path, value) => { await new Promise(done => setTimeout(done, 20)); await writeRecoveryFile(path, value); },
    spawnProcess: () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('spawn denied'))); return child; } });
  assert.match(state.lastError, /spawn denied/);
  assert.equal(state.restartCount, 0);
});
