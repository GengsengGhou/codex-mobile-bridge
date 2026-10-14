import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const CLOCK_PATH = '/api/hub/clock-proof';
export const clockSecretHash = secret => createHash('sha256').update(secret).digest('hex');
const key = hash => Buffer.from(hash, 'hex');
export const pairingClockSubject = hash => createHmac('sha256', key(hash)).update('codex-mobile-clock/pairing-locator/v1').digest('hex');
const fields = value => [1, value.type, value.origin, value.subject, value.nonce];
export const clockRequestMac = (hash, value) => createHmac('sha256', key(hash)).update(JSON.stringify(['codex-mobile-clock/request', ...fields(value)])).digest('hex');
export const clockResponseMac = (hash, value) => createHmac('sha256', key(hash)).update(JSON.stringify(['codex-mobile-clock/response', ...fields(value), value.serverTime])).digest('hex');
export function equalClockMac(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}
export function validClockRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'mac,nonce,origin,subject,type,version' || value.version !== 1 || !['device', 'pairing'].includes(value.type) || typeof value.origin !== 'string' || typeof value.subject !== 'string' || typeof value.nonce !== 'string' || typeof value.mac !== 'string' || value.origin.length > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(value.nonce) || !/^[a-f0-9]{64}$/.test(value.mac)) return false;
  if (!(value.type === 'device' ? /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i : /^[a-f0-9]{64}$/).test(value.subject || '')) return false;
  try { const origin = new URL(value.origin); return origin.origin === value.origin && !origin.username && !origin.password && origin.pathname === '/' && !origin.search && !origin.hash && (origin.protocol === 'https:' || origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)); } catch { return false; }
}
