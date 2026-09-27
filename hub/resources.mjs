import { HubTransportError } from './protocol.mjs';

export function resourceLimit(env, name, fallback, min = 1, max = 1000000000) {
  if (env[name] === undefined || env[name] === '') return fallback;
  const value = Number(env[name]);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}

export function hubResources(env = process.env) {
  return {
    maxInFlight: resourceLimit(env, 'HUB_DEVICE_REQUESTS', 8, 1, 64),
    maxGlobalInFlight: resourceLimit(env, 'HUB_GLOBAL_REQUESTS', 24, 1, 256),
    maxUserInFlight: resourceLimit(env, 'HUB_USER_REQUESTS', 8, 1, 128),
    maxDevices: resourceLimit(env, 'HUB_CONNECTIONS', 64, 1, 1024),
    maxUserDevices: resourceLimit(env, 'HUB_USER_CONNECTIONS', 10, 1, 64),
    bytesPerSecond: resourceLimit(env, 'HUB_RELAY_BYTES_PER_SECOND', 4 * 1024 * 1024, 65536, 100 * 1024 * 1024),
    maxHttpConnections: resourceLimit(env, 'HUB_HTTP_CONNECTIONS', 128, 1, 4096),
    maxHttpRequests: resourceLimit(env, 'HUB_HTTP_REQUESTS', 64, 1, 1024),
    maxUsers: resourceLimit(env, 'HUB_MAX_USERS', 256, 1, 10000),
    maxDeviceRecords: resourceLimit(env, 'HUB_DEVICE_RECORDS', 4096, 10, 100000),
    revokedRetentionDays: resourceLimit(env, 'HUB_REVOKED_DEVICE_RETENTION_DAYS', 7, 1, 365),
  };
}

// FIFO frame turns give each backpressured request a turn without buffering bodies.
export class RelayBandwidth {
  constructor({ bytesPerSecond = 4 * 1024 * 1024, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.bytesPerSecond = bytesPerSecond; this.now = now; this.setTimer = setTimer; this.clearTimer = clearTimer;
    this.queue = []; this.nextAt = 0; this.timer = null;
  }
  wait(bytes, signal) {
    if (signal?.aborted) return Promise.reject(new HubTransportError('TRANSFER_CANCELLED', 503));
    return new Promise((resolve, reject) => {
      const entry = { bytes, resolve, reject, signal };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); signal.removeEventListener('abort', entry.abort);
        reject(new HubTransportError('TRANSFER_CANCELLED', 503));
        if (!this.queue.length && this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry); this.pump();
    });
  }
  pump() {
    if (this.timer !== null || !this.queue.length) return;
    const delay = this.nextAt - this.now();
    if (delay > 0) { this.timer = this.setTimer(() => { this.timer = null; this.pump(); }, Math.ceil(delay)); return; }
    const entry = this.queue.shift(); entry.signal?.removeEventListener('abort', entry.abort);
    this.nextAt = Math.max(this.nextAt, this.now()) + entry.bytes * 1000 / this.bytesPerSecond;
    entry.resolve(); this.pump();
  }
}
