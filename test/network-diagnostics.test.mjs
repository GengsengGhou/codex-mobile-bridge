import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyNetworkError, pairingNetworkError, pairingNetworkMessages, pairingUncertainMessage } from '../scripts/network-error.mjs';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { diagnoseNetwork, diagnosticOrigin } from '../scripts/diagnose-network.mjs';

test('bounded nested/aggregate classifier emits only allowlisted codes, never secret text', () => {
  const secret = 'https://user:password@host/?deviceToken=secret';
  const error = new TypeError(secret, { cause: new AggregateError([Object.assign(new Error(secret), { code: 'ECONNREFUSED' }), { cause: { code: 'ENETUNREACH' } }, { code: secret }], secret) });
  assert.deepEqual(classifyNetworkError(error), { category: 'MULTIPLE', codes: ['ECONNREFUSED', 'ENETUNREACH'] });
  assert.doesNotMatch(JSON.stringify(pairingNetworkError(error)), /password|deviceToken|secret/);
  const cyclic = { code: 'EAI_AGAIN' }; cyclic.cause = cyclic;
  assert.equal(classifyNetworkError(cyclic).category, 'DNS');
  let deep = { code: 'ENOTFOUND' }; for (let i=0; i<20; i++) deep = { cause: deep };
  assert.equal(classifyNetworkError(deep).category, 'UNKNOWN');
  assert.equal(classifyNetworkError({ cause: { name: 'TimeoutError' } }).category, 'TIMEOUT');
  assert.equal(classifyNetworkError({ name: 'AbortError' }).category, 'CANCELLED');
  assert.equal(classifyNetworkError({ get code() { throw Error(secret); } }).category, 'UNKNOWN');
});

test('pair fetch failure preserves token file, supplies abort signal, never retries and safely guides uncertain outcome', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pair-network-'));
  try {
    const configPath = join(root, 'fixture.json'), original = '{"deviceToken":"fixture-secret"}';
    await writeFile(configPath, original);
    for (const [raw, expected] of [[{ cause: { code: 'ENOTFOUND' } }, 'DNS'], [{ cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } }, 'TLS'], [{ cause: { code: 'CERT_NOT_YET_VALID' } }, 'TLS_DATE'], [{ cause: { code: 'CERT_HAS_EXPIRED' } }, 'TLS_DATE'], [{ name: 'TimeoutError' }, 'TIMEOUT'], [new Error('secret pairing code'), 'UNKNOWN']]) {
      let calls = 0;
      await assert.rejects(pairConnector({ origin: 'https://hub.example', pairingCode: 'p'.repeat(43), configPath, replace: true, fetchImpl: async (_, options) => {
        calls++; assert.equal(options.method, 'POST'); assert.ok(options.signal instanceof AbortSignal); throw raw;
      } }), error => { assert.equal(error.code, `PAIR_NETWORK_${expected}`); assert.ok(error.message.includes(pairingUncertainMessage)); assert.doesNotMatch(error.message, /secret|pppppp/); return true; });
      assert.equal(calls, 1); assert.equal(await readFile(configPath, 'utf8'), original);
    }
    await assert.rejects(pairConnector({ origin: 'https://hub.example', pairingCode: 'p'.repeat(43), configPath, replace: true, fetchImpl: async () => new Response('secret', { status: 401 }) }), /设备配对失败/);
    await assert.rejects(pairConnector({ origin: 'https://hub.example', pairingCode: 'p'.repeat(43), configPath, replace: true, fetchImpl: async () => new Response('not-json') }), /配对响应无效/);
    assert.equal(await readFile(configPath, 'utf8'), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('diagnostic rejects private URL material and makes one public GET without reading config/body', async () => {
  for (const input of ['http://hub.example', 'https://user:pass@hub.example', 'https://hub.example/?secret=x', 'https://hub.example/path', 'https://hub.example/#x', 'https://hub.example\n']) assert.throws(() => diagnosticOrigin(input));
  let calls = 0, cancelled = false;
  const report = await diagnoseNetwork('https://hub.example', { env: { HTTPS_PROXY: 'https://user:pass@proxy/?secret', NODE_EXTRA_CA_CERTS: 'private/path' }, lookupImpl: async () => [{ family: 4, address: 'private-ip' }], fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://hub.example/'); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.headers, undefined); assert.ok(options.signal instanceof AbortSignal);
    return { status: 302, body: { cancel: async () => { cancelled = true; } } };
  } });
  assert.equal(calls, 1); assert.ok(cancelled); assert.equal(report.environment.HTTPS_PROXY, true); assert.equal(report.nodeHttps.status, 302);
  assert.doesNotMatch(JSON.stringify(report), /user:pass|private-ip|private\/path|\?secret/);
  const failed = await diagnoseNetwork('https://hub.example', { lookupImpl: async () => { throw { code: 'ENOTFOUND' }; }, fetchImpl: async () => { throw new TypeError('private text', { cause: { code: 'ECONNREFUSED' } }); } });
  assert.equal(failed.dns.category, 'DNS'); assert.equal(failed.nodeHttps.category, 'REFUSED');
  const bounded = await diagnoseNetwork('https://hub.example', { timeoutMs: 10, lookupImpl: () => new Promise(() => {}), fetchImpl: async () => ({ status: 200 }) });
  assert.equal(bounded.dns.category, 'TIMEOUT'); assert.equal(bounded.nodeHttps.status, 200);
});

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); });
test('actual native fetch DNS/refused/TLS/abort failures produce machine categories on isolated targets', async () => {
  async function failure(url, options = {}) { try { await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(3000) }); assert.fail('fetch should fail'); } catch (error) { return classifyNetworkError(error); } }
  // An oversized DNS label is rejected by the system resolver locally. A plain
  // .invalid domain can be synthesized by a VPN/TUN fake-IP resolver instead.
  const dns = await failure(`https://${'a'.repeat(64)}.invalid/`); assert.equal(dns.category, 'DNS');
  const reserve = httpServer(); await listen(reserve); const port = reserve.address().port; await close(reserve);
  const refused = await failure(`http://127.0.0.1:${port}/`); assert.equal(refused.category, 'REFUSED');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/network-tls.json', import.meta.url)));
  const tls = httpsServer(fixture, (_, response) => response.end('fixture')); await listen(tls);
  try { assert.equal((await failure(`https://127.0.0.1:${tls.address().port}/`)).category, 'TLS'); }
  finally { await close(tls); }
  const hanging = httpServer(() => {}); await listen(hanging);
  try {
    assert.equal((await failure(`http://127.0.0.1:${hanging.address().port}/`, { signal: AbortSignal.timeout(30) })).category, 'TIMEOUT');
    const controller = new AbortController(); controller.abort();
    assert.equal((await failure(`http://127.0.0.1:${hanging.address().port}/`, { signal: controller.signal })).category, 'CANCELLED');
  } finally { await close(hanging); }
});

test('each classified pairing diagnostic and uncertain-response hint has both desktop translations', async () => {
  const js = await readFile(new URL('../deploy/windows/ui/desktop-locale.js', import.meta.url), 'utf8');
  const cs = await readFile(new URL('../deploy/windows/DesktopLocale.cs', import.meta.url), 'utf8');
  for (const message of [...Object.values(pairingNetworkMessages), pairingUncertainMessage]) { assert.ok(js.includes(JSON.stringify(message))); assert.ok(cs.includes(JSON.stringify(message))); }
});
