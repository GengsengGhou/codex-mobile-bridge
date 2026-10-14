import tls from 'node:tls';
import https from 'node:https';
import { X509Certificate, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLOCK_PATH, clockSecretHash, pairingClockSubject, clockRequestMac, clockResponseMac, equalClockMac } from '../src/clock-protocol.mjs';

const nativePath = fileURLToPath(new URL('../runtime/CertificateVerifier.exe', import.meta.url));
const fail = code => Object.assign(new Error(code), { code });
const dateFailure = error => ['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED'].includes(error?.code);
const transports = new Map();
const abortFailure = () => Object.assign(new Error('Connection cancelled'), { code: 'ABORT_ERR', name: 'AbortError' });
function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) { promise.catch(() => {}); return Promise.reject(abortFailure()); }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(abortFailure());
    signal.addEventListener('abort', cancel, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
const defaultRoots = () => (typeof tls.getCACertificates === 'function' ? tls.getCACertificates('default') : tls.rootCertificates).map(pem => new X509Certificate(pem).raw.toString('base64'));

export async function verifyCertificateChain(value, { helperPath = nativePath, timeoutMs = 10000, signal } = {}) {
  if (signal?.aborted) throw abortFailure();
  const input = JSON.stringify(value);
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw fail('CLOCK_CERTIFICATE_INVALID');
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    let output = '', settled = false;
    const cancel = () => finish(abortFailure());
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); child.kill(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(fail('CLOCK_VALIDATION_UNAVAILABLE')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdin.on('error', () => {});
    child.on('error', () => finish(fail('CLOCK_VALIDATION_UNAVAILABLE')));
    child.stderr.resume();
    child.stdout.on('data', bytes => { output += bytes; if (output.length > 4096) finish(fail('CLOCK_CERTIFICATE_INVALID')); });
    child.once('close', code => {
      let result; try { result = JSON.parse(output); } catch { finish(fail('CLOCK_CERTIFICATE_INVALID')); return; }
      if (code !== 0 || result?.ok !== true) finish(fail('CLOCK_CERTIFICATE_INVALID')); else finish(null, true);
    });
    child.stdin.end(input);
  });
}

// The socket remains private to this agent until its complete validation succeeds.
// Ordinary TLS is tried before clock bootstrap, so correct-time clients retain old-Hub support.
export function createClockTransport({ origin, type = 'device', subject, secret, ca, trustRoots, helperPath, verifyChain = verifyCertificateChain, monoNow = () => performance.now(), wallNow = () => Date.now(), proofMaxAgeMs = 60000, maxRttMs = 5000 } = {}) {
  const hub = new URL(origin);
  if (hub.origin !== origin || hub.protocol !== 'https:' || hub.username || hub.password || !['device', 'pairing'].includes(type) || !/^[A-Za-z0-9_-]{43}$/.test(secret || '')) throw fail('CLOCK_AUTH_FAILED');
  const hash = clockSecretHash(secret);
  subject ||= type === 'pairing' ? pairingClockSubject(hash) : null;
  if (!(type === 'pairing' ? /^[a-f0-9]{64}$/ : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i).test(subject || '')) throw fail('CLOCK_AUTH_FAILED');
  const roots = trustRoots || (ca ? (Array.isArray(ca) ? ca : [ca]).map(pem => new X509Certificate(pem).raw.toString('base64')) : defaultRoots());
  let anchor = null, acquiring = null, lastWall, lastMono;
  function liveAnchor() {
    const mono = monoNow(), wall = wallNow();
    if (lastMono !== undefined && Math.abs((wall - lastWall) - (mono - lastMono)) > 30000) anchor = null;
    lastMono = mono; lastWall = wall;
    if (anchor && (mono - anchor.receivedAt < 0 || mono - anchor.receivedAt >= proofMaxAgeMs)) anchor = null;
    return anchor;
  }
  async function bootstrap() {
    if (liveAnchor()) return anchor;
    if (acquiring) return acquiring;
    acquiring = (async () => {
      const request = { version: 1, type, origin, subject, nonce: randomBytes(32).toString('base64url') };
      request.mac = clockRequestMac(hash, request);
      const started = monoNow();
      const response = await new Promise((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify(request));
        // This isolated endpoint receives only public binding fields and a nonce MAC.
        // It receives no raw secret/hash, authorization header, cookie or business command.
        const outgoing = https.request(new URL(CLOCK_PATH, origin), { method: 'POST', agent: false, rejectUnauthorized: false, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), connection: 'close' }, timeout: maxRttMs }, incoming => {
          let size = 0; const parts = [];
          incoming.on('data', part => { size += part.length; if (size > 4096) incoming.destroy(fail('CLOCK_AUTH_FAILED')); else parts.push(part); });
          incoming.on('error', reject);
          incoming.on('end', () => {
            if (incoming.statusCode === 404 || incoming.statusCode === 405) { reject(fail('CLOCK_UNSUPPORTED')); return; }
            if (incoming.statusCode !== 200) { reject(fail('CLOCK_AUTH_FAILED')); return; }
            try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch { reject(fail('CLOCK_AUTH_FAILED')); }
          });
        });
        const timer = setTimeout(() => outgoing.destroy(fail('CLOCK_AUTH_FAILED')), maxRttMs);
        outgoing.once('close', () => clearTimeout(timer));
        outgoing.on('error', () => reject(fail('CLOCK_AUTH_FAILED')));
        outgoing.on('timeout', () => outgoing.destroy(fail('CLOCK_AUTH_FAILED')));
        outgoing.end(bytes);
      });
      const receivedAt = monoNow(), rtt = receivedAt - started;
      if (rtt < 0 || rtt > maxRttMs || !response || Object.keys(response).sort().join(',') !== 'mac,nonce,origin,serverTime,subject,type,version' || response.version !== 1 || response.type !== type || response.origin !== origin || response.subject !== subject || response.nonce !== request.nonce || !Number.isSafeInteger(response.serverTime) || response.serverTime < 946684800000 || response.serverTime > 4102444800000 || !equalClockMac(response.mac, clockResponseMac(hash, response))) throw fail('CLOCK_AUTH_FAILED');
      anchor = { serverTime: response.serverTime, receivedAt, rtt };
      return anchor;
    })().finally(() => { acquiring = null; });
    return acquiring;
  }
  function connectSocket(options, rejectUnauthorized, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortFailure()); return; }
      const hostname = hub.hostname.replace(/^\[|\]$/g, '');
      const socket = tls.connect({ ...options, path: undefined, host: hostname, port: Number(hub.port || 443), servername: tlsServername(hostname), ca, rejectUnauthorized, session: undefined, ALPNProtocols: ['http/1.1'] });
      let complete = false;
      const timer = setTimeout(() => finish(fail('CLOCK_AUTH_FAILED')), 10000);
      const cancel = () => finish(abortFailure());
      const onClose = () => finish(fail('CLOCK_AUTH_FAILED'));
      const finish = (error, result) => { if (complete) return; complete = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); socket.off('close', onClose); socket.off('error', onError); socket.on('error', () => {}); error ? (socket.destroy(), reject(error)) : resolve(result); };
      const onError = error => finish(error);
      signal?.addEventListener('abort', cancel, { once: true }); socket.once('close', onClose);
      socket.once('error', onError); socket.once('secureConnect', () => finish(null, socket));
    });
  }
  async function secureSocket(options, signal) {
    let socket;
    try { socket = await connectSocket(options, true, signal); if (signal?.aborted) { socket.destroy(); throw abortFailure(); } socket.bridgeClockCompatible = false; return socket; }
    catch (error) { if (!dateFailure(error)) throw error; }
    await abortable(bootstrap(), signal);
    socket = await connectSocket(options, false, signal);
    // Retain an error listener while the private socket is checked asynchronously.
    let socketError; const capture = error => { socketError = error; }; socket.on('error', capture);
    const cancel = () => socket.destroy(); signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw abortFailure();
      const peer = socket.getPeerCertificate(true);
      if (!peer?.raw || tls.checkServerIdentity(hub.hostname.replace(/^\[|\]$/g, ''), peer)) throw fail('CLOCK_CERTIFICATE_INVALID');
      const peerChain = [], seen = new Set(); let certificate = peer;
      while (certificate?.raw) {
        const encoded = certificate.raw.toString('base64'); if (seen.has(encoded)) break;
        if (certificate.raw.length > 128 * 1024 || peerChain.length >= 32) throw fail('CLOCK_CERTIFICATE_INVALID');
        peerChain.push(encoded); seen.add(encoded); certificate = certificate.issuerCertificate;
      }
      const proof = liveAnchor(); if (!proof) { await abortable(bootstrap(), signal); }
      const current = anchor, age = monoNow() - current.receivedAt;
      if (age < 0 || age >= proofMaxAgeMs) throw fail('CLOCK_AUTH_FAILED');
      // Validate both bounds of the bounded network-time uncertainty interval.
      for (const time of [current.serverTime + age, current.serverTime + age + current.rtt]) {
        await abortable(verifyChain({ version: 1, referenceTime: new Date(Math.ceil(time)).toISOString(), peerChain, trustRoots: roots }, { helperPath, signal }), signal);
        if (signal?.aborted) throw abortFailure();
        if (socketError || socket.destroyed || !socket.getPeerCertificate().raw?.equals(peer.raw)) throw fail('CLOCK_CERTIFICATE_INVALID');
      }
      socket.off('error', capture); socket.bridgeClockCompatible = true;
      return socket;
    } catch (error) { socket.destroy(); throw signal?.aborted ? abortFailure() : error.code?.startsWith('CLOCK_') ? error : fail('CLOCK_CERTIFICATE_INVALID'); }
    finally { signal?.removeEventListener('abort', cancel); socket.off('error', capture); }
  }
  class ClockAgent extends https.Agent {
    constructor() { super({ keepAlive: false, maxCachedSessions: 0, maxSockets: 4 }); this.pending = new Set(); }
    addRequest(request, options) {
      const controller = new AbortController();
      const cancel = () => { controller.abort(); pending.cleanup(); };
      request.once('close', cancel);
      request.once('error', cancel);
      const signal = options.bridgeClockSignal;
      const pending = { controller, cleanup: () => { request.off('close', cancel); request.off('error', cancel); signal?.removeEventListener('abort', cancel); this.pending.delete(pending); } };
      this.pending.add(pending);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      super.addRequest(request, { ...options, bridgeClockPending: pending });
    }
    createConnection(options, callback) {
      const pending = options.bridgeClockPending;
      secureSocket(options, pending?.controller.signal).then(socket => { pending?.cleanup(); callback(null, socket); }, error => { pending?.cleanup(); callback(error); });
    }
    destroy() { for (const pending of this.pending) { pending.controller.abort(); pending.cleanup(); } super.destroy(); }
  }
  const agent = new ClockAgent();
  async function fetch(url, options = {}) {
    const endpoint = new URL(url);
    if (endpoint.origin !== origin || endpoint.username || endpoint.password) throw fail('CLOCK_AUTH_FAILED');
    return new Promise((resolve, reject) => {
      const request = https.request(endpoint, { method: options.method || 'GET', headers: options.headers, signal: options.signal, bridgeClockSignal: options.signal, agent }, response => {
        if (response.statusCode >= 300 && response.statusCode < 400) { response.resume(); reject(fail('CLOCK_AUTH_FAILED')); return; }
        const headers = new Headers(); for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
        resolve(new Response([204, 205, 304].includes(response.statusCode) || options.method === 'HEAD' ? null : Readable.toWeb(response), { status: response.statusCode, headers }));
      });
      request.on('error', reject); request.end(options.body);
    });
  }
  return { agent, fetch, bootstrap, clockCompatible: () => !!liveAnchor(), trustedNow: () => liveAnchor() ? anchor.serverTime + monoNow() - anchor.receivedAt : wallNow(), close: () => { agent.destroy(); anchor = null; } };
}
function tlsServername(hostname) { return /^[\d.]+$/.test(hostname) || hostname.includes(':') ? undefined : hostname; }
export function hubClockTransport(config, { pairingCode } = {}) {
  const origin = new URL(config.hubOrigin).origin, secret = pairingCode || config.deviceToken, type = pairingCode ? 'pairing' : 'device';
  const subject = pairingCode ? pairingClockSubject(clockSecretHash(secret)) : config.deviceId;
  const identity = JSON.stringify([origin, type, subject, clockSecretHash(secret)]);
  if (!transports.has(identity)) {
    if (transports.size >= 32) { const first = transports.keys().next().value; transports.get(first).close(); transports.delete(first); }
    transports.set(identity, createClockTransport({ origin, type, subject, secret }));
  }
  return transports.get(identity);
}
export function clockAwareHubFetch(config, url, options, pairingCode) {
  if (new URL(url).protocol === 'http:' && config.allowInsecureLocal && ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)) return globalThis.fetch(url, options);
  return hubClockTransport(config, { pairingCode }).fetch(url, options);
}
