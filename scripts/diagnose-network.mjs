import { lookup } from 'node:dns/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyNetworkError } from './network-error.mjs';

export function diagnosticOrigin(input) {
  if (typeof input !== 'string' || input !== input.trim() || input.length > 2048 || !/^https:\/\/[^/?#]+\/?$/i.test(input)) throw new Error('INVALID_HTTPS_ORIGIN');
  let url;
  try { url = new URL(input); } catch { throw new Error('INVALID_HTTPS_ORIGIN'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.protocol !== 'https:') throw new Error('INVALID_HTTPS_ORIGIN');
  return url.origin;
}
export async function diagnoseNetwork(input, { fetchImpl = fetch, lookupImpl = lookup, env = process.env, timeoutMs = 10000 } = {}) {
  const origin = diagnosticOrigin(input);
  const report = { schema: 1, readOnly: true, origin, nodeVersion: process.version,
    environment: Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'NODE_USE_SYSTEM_CA', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS'].map(key => [key, Object.keys(env).some(name => name.toUpperCase() === key && !!env[name])])),
    note: 'Browser/Windows and Node can use different proxies and certificate stores. Proxy/CA causes require evidence. No credentials or response bodies are collected.' };
  let timer;
  try {
    const answers = await Promise.race([lookupImpl(new URL(origin).hostname, { all: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error(), { name: 'TimeoutError' })), timeoutMs); })]);
    report.dns = { ok: true, ipv4Count: answers.filter(a => a.family === 4).length, ipv6Count: answers.filter(a => a.family === 6).length };
  } catch (error) { report.dns = { ok: false, ...classifyNetworkError(error) }; }
  finally { clearTimeout(timer); }
  // Exactly one public GET, no redirects, no auth, no pairing, no automatic retry.
  try {
    const response = await fetchImpl(`${origin}/`, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    report.nodeHttps = { transportOk: true, status: response.status, redirect: response.status >= 300 && response.status < 400 };
    await response.body?.cancel();
  } catch (error) { report.nodeHttps = { transportOk: false, ...classifyNetworkError(error) }; }
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await diagnoseNetwork(process.argv[2]);
    // A system DNS resolver can outlive the bounded promise. Do not leave the
    // standalone diagnostic waiting for its native resolver thread afterwards.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n', () => process.exit(0));
  }
  catch { console.log(JSON.stringify({ schema: 1, readOnly: true, diagnosticError: 'INVALID_INPUT_OR_DIAGNOSTIC_FAILURE', help: 'Use: node diagnose-network.mjs https://YOUR-HUB (origin only; no path, credentials or query).' }, null, 2)); process.exitCode = 1; }
}
