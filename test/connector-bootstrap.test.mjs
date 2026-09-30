import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { ensureLocalBridge, localThreadCandidates, chooseFreePort, probeLocalBridge, selectOrdinaryLocalThread } from '../scripts/bootstrap-bridge.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const status = { connected: true, mode: 'desktop-pipe', canSend: true, callerThreadId: id };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'codex-bridge-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let running = false, starts = 0;
  const calls = [];
  const options = {
    root, platform: 'win32', callerThreadId: id,
    probe: async () => running ? status : null,
    bridgeFactory: () => ({ capabilities: async () => ['list_threads', 'read_thread'], call: async (tool, args) => { calls.push({ tool, args }); return { thread: { id, kind: 'codex', hostId: 'local', archived: false }, turns: [] }; } }),
    choosePort: async () => 4339,
    start: async ({ loadConfig }) => { const config = await loadConfig(); assert.equal(config.port, 4339); starts++; running = true; return { started: true }; },
    ...overrides,
  };
  return { root, options, calls, starts: () => starts };
}

test('fresh setup verifies selected existing local conversation before persisting minimal runtime', async t => {
  let selections = 0;
  const { root, options, calls } = await fixture(t, { callerThreadId: undefined, candidates: async () => [{ id, title: 'existing' }], selectThread: async choices => { selections++; assert.equal(choices[0].id, id); return id; } });
  const ready = await ensureLocalBridge(options);
  assert.deepEqual(ready, { port: 4339, started: true, connected: true, url: 'http://127.0.0.1:4339' });
  assert.equal(selections, 1); assert.equal(calls.length, 1); assert.equal(calls[0].tool, 'read_thread'); assert.equal(calls[0].args.includeOutputs, false);
  const config = JSON.parse(await readFile(resolve(root, '.local/runtime.json'), 'utf8'));
  assert.deepEqual(config, { callerThreadId: id, enableSend: true, allowedSendThreadId: id, sendScope: 'all-local', port: 4339 });
  assert.doesNotMatch(JSON.stringify(config), /PIPE|TOKEN|password|provider|CODEX_HOME/);
});

test('automatic first pairing uses the discovered desktop request while selecting a local conversation', async t => {
  const desktopRequest = async () => {};
  const seen = [];
  const { options } = await fixture(t, {
    callerThreadId: undefined,
    request: desktopRequest,
    candidates: async () => [{ id, title: 'existing' }],
    selectThread: selectOrdinaryLocalThread,
    bridgeFactory: args => {
      assert.equal(args.request, desktopRequest);
      seen.push(args.callerThreadId);
      return {
        capabilities: async () => ['list_threads', 'read_thread'],
        call: async () => ({ thread: { id, kind: 'codex', hostId: 'local', archived: false } }),
      };
    },
  });
  const ready = await ensureLocalBridge(options);
  assert.equal(ready.connected, true);
  assert.deepEqual(seen, [undefined, id]);
});

test('missing desktop and unsupported selected threads block persistence and launch', async t => {
  for (const kind of ['desktop', 'archived', 'remote', 'subagent']) await t.test(kind, async subtest => {
    const thread = { id, kind: 'codex', hostId: kind === 'remote' ? 'remote' : 'local', archived: kind === 'archived', parentThreadId: kind === 'subagent' ? other : null };
    const { root, options, starts } = await fixture(subtest, { bridgeFactory: () => ({ capabilities: async () => { if (kind === 'desktop') throw new Error('请打开 Codex'); return ['list_threads', 'read_thread']; }, call: async () => ({ thread }) }) });
    await assert.rejects(ensureLocalBridge(options)); assert.equal(starts(), 0);
    await assert.rejects(readFile(resolve(root, '.local/runtime.json')), { code: 'ENOENT' });
  });
});

test('healthy existing bridge is reused without selection, config writes or process launch', async t => {
  const { root, options, starts } = await fixture(t, { callerThreadId: undefined, probe: async () => status, bridgeFactory: () => { throw new Error('must not access desktop again'); }, selectThread: () => { throw new Error('must not prompt'); } });
  const result = await ensureLocalBridge(options); assert.equal(result.port, 4317); assert.equal(result.started, false); assert.equal(starts(), 0);
  await assert.rejects(readFile(resolve(root, '.local/runtime.json')), { code: 'ENOENT' });
});

test('existing configured send scope is preserved when starting a disconnected bridge', async t => {
  const { root, options } = await fixture(t);
  await mkdir(resolve(root, '.local'));
  const config = { callerThreadId: id, allowedSendThreadId: other, enableSend: false, sendScope: 'single', port: 4317 };
  await writeFile(resolve(root, '.local/runtime.json'), JSON.stringify(config));
  await ensureLocalBridge(options);
  assert.deepEqual(JSON.parse(await readFile(resolve(root, '.local/runtime.json'), 'utf8')), { ...config, port: 4339 });
});

test('a service started without actual desktop connectivity cannot be considered ready for pairing', async t => {
  const { options } = await fixture(t, { probe: async () => null });
  await assert.rejects(ensureLocalBridge(options), /停止配对/);
});

test('no candidates and cancelled selection leave fresh setup unconfigured', async t => {
  for (const choices of [[], [{ id, title: 'existing' }]]) await t.test(choices.length ? 'cancelled' : 'empty', async subtest => {
    const { root, options, starts } = await fixture(subtest, { callerThreadId: undefined, candidates: async () => choices, selectThread: async () => undefined });
    await assert.rejects(ensureLocalBridge(options)); assert.equal(starts(), 0);
    await assert.rejects(readFile(resolve(root, '.local/runtime.json')), { code: 'ENOENT' });
  });
});

test('unknown port occupant is preserved and a free port is chosen', async t => {
  const occupant = net.createServer(socket => socket.end('existing service'));
  await new Promise(resolveReady => occupant.listen(0, '127.0.0.1', resolveReady)); t.after(() => occupant.close());
  const occupied = occupant.address().port, selected = await chooseFreePort(occupied);
  assert.notEqual(selected, occupied); assert.ok(selected >= 1024); assert.equal(occupant.listening, true);
});

test('a reserved connector port cannot be silently changed during bootstrap', async t => {
  const { root, options, starts } = await fixture(t, { port: 64817, choosePort: async () => 64818 });
  await assert.rejects(ensureLocalBridge(options), /端口已被其他程序占用/);
  assert.equal(starts(), 0);
  await assert.rejects(readFile(resolve(root, '.local/runtime.json')), { code: 'ENOENT' });
});

test('structured session index and sidebar fallback supply bounded, sanitized choices', async t => {
  const root = await mkdtemp(resolve(tmpdir(), 'codex-choice-index-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'session_index.jsonl'), `invalid-json\n${JSON.stringify({ id, thread_name: 'selected\nconversation' })}\n`);
  await writeFile(resolve(root, '.codex-global-state.json'), JSON.stringify({ 'projectless-thread-ids': [other], secret: 'do-not-return', 'thread-project-assignments': {} }));
  const choices = await localThreadCandidates({ codexHome: root });
  assert.deepEqual(choices, [{ id, title: 'selected conversation' }, { id: other, title: '本机会话' }]);
  assert.equal((await localThreadCandidates({ codexHome: root, maxCandidates: 1 })).length, 1);
});

test('HTTP bridge probe requires actual connected desktop protocol, not merely a responding listener', async t => {
  let reply = { ...status, connected: false };
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('Set-Cookie', `bridge_session=${'a'.repeat(64)}; Path=/`); res.end('<title>Codex 手机桥接</title>'); }
    else { assert.equal(req.headers['x-bridge-client'], 'mobile-v1'); assert.equal(req.headers.cookie, `bridge_session=${'a'.repeat(64)}`); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(reply)); }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolveClosed => server.close(resolveClosed)); });
  const port = server.address().port;
  assert.equal(await probeLocalBridge(port), null);
  reply = { ...status, mode: 'unknown-service' }; assert.equal(await probeLocalBridge(port), null);
  reply = status; assert.deepEqual(await probeLocalBridge(port), status);
});
