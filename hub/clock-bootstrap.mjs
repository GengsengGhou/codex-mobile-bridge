import { performance } from 'node:perf_hooks';
import { HubError } from './errors.mjs';
import { clockRequestMac, clockResponseMac, equalClockMac, validClockRequest } from '../src/clock-protocol.mjs';

export function createClockBootstrap({ store, monotonic = () => performance.now(), maxSubjects = 4096, maxPeers = 2048, requestsPerMinute = 30 } = {}) {
  const peers = new Map(), nonces = new Map();
  const reject = (code, status = 401) => { throw new HubError(code, code, status); };
  return (value, origin, peer) => {
    const now = monotonic();
    for (const [key, record] of peers) if (now - record.at >= 60000) peers.delete(key);
    for (const [key, at] of nonces) if (now - at >= 120000) nonces.delete(key);
    const rate = peers.get(peer);
    if (!rate && peers.size >= maxPeers || rate && rate.count >= requestsPerMinute) reject('CLOCK_BUSY', 429);
    if (rate) rate.count++; else peers.set(peer, { at: now, count: 1 });
    if (!validClockRequest(value) || value.origin !== origin) reject('CLOCK_AUTH_FAILED');
    const hash = store.clockKey(value.type, value.subject);
    if (!hash || !equalClockMac(value.mac, clockRequestMac(hash, value))) reject('CLOCK_AUTH_FAILED');
    const nonceKey = `${value.type}/${value.subject}/${value.nonce}`;
    if (nonces.has(nonceKey)) reject('CLOCK_AUTH_FAILED');
    if (nonces.size >= maxSubjects) reject('CLOCK_BUSY', 503);
    nonces.set(nonceKey, now);
    const serverTime = store.now();
    if (!Number.isSafeInteger(serverTime) || serverTime < 0 || serverTime > 8640000000000000) reject('CLOCK_UNAVAILABLE', 503);
    const response = { version: 1, type: value.type, origin, subject: value.subject, nonce: value.nonce, serverTime };
    return { ...response, mac: clockResponseMac(hash, response) };
  };
}
