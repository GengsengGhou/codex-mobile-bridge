import { randomUUID } from 'node:crypto';
import { allowedBridgeRequest, control, binary, decode, FRAME_BYTES, UPLOAD_LIMIT, DOWNLOAD_LIMIT, selectHeaders, REQUEST_HEADERS, RESPONSE_HEADERS, HubTransportError } from './protocol.mjs';
import { RelayBandwidth } from './resources.mjs';

export class HubRelay {
  constructor({ validateRequest = () => true, requestTimeoutMs = 120000, maxInFlight = 8, heartbeatMs = 30000, maxGlobalInFlight = 24, maxUserInFlight = 8, maxDevices = 64, maxUserDevices = 10, bytesPerSecond = 4 * 1024 * 1024 } = {}) {
    this.validateRequest = validateRequest; this.requestTimeoutMs = requestTimeoutMs; this.maxInFlight = maxInFlight; this.heartbeatMs = heartbeatMs; this.devices = new Map();
    this.maxGlobalInFlight = maxGlobalInFlight; this.maxUserInFlight = maxUserInFlight; this.maxDevices = maxDevices; this.maxUserDevices = maxUserDevices;
    this.active = 0; this.userRequests = new Map(); this.bandwidth = new RelayBandwidth({ bytesPerSecond });
  }
  status(deviceId) { return this.devices.get(deviceId)?.ws.readyState === 1; }
  checkConnection(deviceId, userId) {
    const existing = this.devices.get(deviceId);
    if (!existing && this.devices.size >= this.maxDevices) throw new HubTransportError('HUB_BUSY', 503);
    const count = [...this.devices.values()].filter(connection => connection.userId === userId).length;
    if ((!existing || existing.userId !== userId) && count >= this.maxUserDevices) throw new HubTransportError('ACCOUNT_BUSY', 503);
  }
  attach(deviceId, ws, { validateDevice = () => true, userId = deviceId } = {}) {
    this.checkConnection(deviceId, userId);
    this.cancelDevice(deviceId);
    const connection = { ws, requests: new Map(), validateDevice, userId };
    this.devices.set(deviceId, connection);
    const fence = () => {
      clearInterval(connection.heartbeat);
      if (this.devices.get(deviceId) !== connection) return;
      this.devices.delete(deviceId);
      for (const request of [...connection.requests.values()]) request.fail(this.failure(request));
      ws.close(1008, 'Transport closed');
    };
    let alive = true;
    ws.on('pong', () => { alive = true; });
    connection.heartbeat = setInterval(() => {
      if (!alive || !validateDevice()) { fence(); ws.terminate(); return; }
      alive = false; try { ws.ping(); } catch { fence(); }
    }, this.heartbeatMs);
    connection.heartbeat.unref();
    ws.on('close', fence); ws.on('error', fence);
    ws.on('message', (data, isBinary) => {
      try {
        if (this.devices.get(deviceId) !== connection || !validateDevice()) { fence(); return; }
        const message = decode(data, isBinary), request = connection.requests.get(message.id);
        // Late frames for cancelled requests are harmless; no request is ever reused.
        if (!request) return;
        if (!this.validateRequest(request.context)) { request.fail(this.revoked(request)); return; }
        if (message.type === 'ack' && message.direction === 'upload' && request.uploadAck) { const resolve = request.uploadAck; request.uploadAck = null; resolve(); }
        else if (message.type === 'response' && !request.responseStarted && Number.isInteger(message.status) && message.status >= 200 && message.status <= 599) {
          const length = message.headers?.['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > DOWNLOAD_LIMIT)) throw new Error('Download too large');
          const headers = selectHeaders(message.headers, RESPONSE_HEADERS);
          // HTTP framing belongs to the hub; connector metadata cannot size a response.
          delete headers['content-length'];
          request.responseStarted = true; request.responseStatus = message.status; request.res.writeHead(message.status, headers);
        } else if (message.type === 'data' && request.responseStarted && !request.downloadPending) {
          if ([204, 205, 304].includes(request.responseStatus)) throw new Error('Response status forbids a body');
          request.downloadBytes += message.bytes.length;
          if (request.downloadBytes > DOWNLOAD_LIMIT) throw new Error('Download too large');
          request.downloadPending = true;
          const ack = () => { if (connection.requests.has(request.id)) { request.downloadPending = false; try { control(ws, { type: 'ack', id: request.id, direction: 'download' }); } catch { fence(); } } };
          void (async () => {
            try {
              await this.bandwidth.wait(message.bytes.length, request.abort.signal);
              if (!connection.requests.has(request.id)) return;
              if (!this.validateRequest(request.context) || !validateDevice()) { request.fail(this.revoked(request)); return; }
              if (request.res.write(message.bytes)) ack(); else request.res.once('drain', ack);
            } catch { if (connection.requests.has(request.id)) request.fail(this.failure(request)); }
          })();
        } else if (message.type === 'end' && message.direction === 'download' && request.responseStarted && !request.downloadPending) {
          request.res.end(); request.finish();
        } else if (message.type === 'error') request.fail(new HubTransportError(request.mutation ? 'DELIVERY_UNKNOWN' : 'BRIDGE_UNAVAILABLE', request.mutation ? 409 : 502));
        else throw new Error('Unexpected frame');
      } catch { fence(); }
    });
    return connection;
  }
  failure(request) { return new HubTransportError(request.mutation && request.dispatched ? 'DELIVERY_UNKNOWN' : 'DEVICE_OFFLINE', request.mutation && request.dispatched ? 409 : 503); }
  revoked(request) { return new HubTransportError(request.mutation && request.dispatched ? 'DELIVERY_UNKNOWN' : 'SESSION_REVOKED', request.mutation && request.dispatched ? 409 : 401); }
  async proxy(deviceId, req, res, path, context = {}) {
    const connection = this.devices.get(deviceId);
    if (!connection || connection.ws.readyState !== 1 || !connection.validateDevice()) throw new HubTransportError('DEVICE_OFFLINE', 503);
    if (!allowedBridgeRequest(req.method, path)) throw new HubTransportError('NOT_FOUND', 404);
    if (!this.validateRequest(context)) throw new HubTransportError('SESSION_REVOKED', 401);
    if (connection.requests.size >= this.maxInFlight) throw new HubTransportError('DEVICE_BUSY', 503);
    const userId = connection.userId;
    if (this.active >= this.maxGlobalInFlight) throw new HubTransportError('HUB_BUSY', 503);
    if ((this.userRequests.get(userId) || 0) >= this.maxUserInFlight) throw new HubTransportError('ACCOUNT_BUSY', 503);
    if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > UPLOAD_LIMIT)) throw new HubTransportError('BODY_TOO_LARGE', 413);
    const id = randomUUID(), mutation = req.method !== 'GET';
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    // Attach a handler immediately while the upload coroutine is running.
    done.catch(() => {});
    const request = { id, req, res, context, mutation, abort: new AbortController(), dispatched: false, responseStarted: false, downloadBytes: 0, downloadPending: false, uploadAck: null };
    const cleanup = () => {
      if (!connection.requests.delete(id)) return;
      clearTimeout(request.timer); request.abort.abort(); this.active--;
      const count = this.userRequests.get(userId) - 1;
      if (count) this.userRequests.set(userId, count); else this.userRequests.delete(userId);
      req.off('aborted', aborted); res.off('close', closed); if (request.uploadAck) { request.uploadAck(); request.uploadAck = null; }
    };
    request.finish = () => { cleanup(); resolve(); };
    request.fail = error => { if (!connection.requests.has(id)) return; try { control(connection.ws, { type: 'cancel', id }); } catch {} cleanup(); req.resume(); if (res.headersSent && !res.writableEnded) res.destroy(); reject(error); };
    const aborted = () => request.fail(this.failure(request));
    const closed = () => { if (!res.writableFinished) aborted(); };
    req.on('aborted', aborted); res.on('close', closed);
    connection.requests.set(id, request);
    this.active++; this.userRequests.set(userId, (this.userRequests.get(userId) || 0) + 1);
    request.timer = setTimeout(() => request.fail(this.failure(request)), this.requestTimeoutMs);
    void (async () => { try {
      control(connection.ws, { type: 'request', id, method: req.method, path, headers: selectHeaders(req.headers, REQUEST_HEADERS) });
      request.dispatched = true;
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > UPLOAD_LIMIT) { request.fail(new HubTransportError('BODY_TOO_LARGE', 413)); return; }
        for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
          if (!connection.requests.has(id)) return;
          if (!this.validateRequest(context) || !connection.validateDevice()) throw this.revoked(request);
          await this.bandwidth.wait(Math.min(FRAME_BYTES, chunk.length - offset), request.abort.signal);
          if (!connection.requests.has(id)) return;
          if (!this.validateRequest(context) || !connection.validateDevice()) throw this.revoked(request);
          const ack = new Promise(yes => { request.uploadAck = yes; });
          binary(connection.ws, id, chunk.subarray(offset, offset + FRAME_BYTES)); await ack;
        }
      }
      if (connection.requests.has(id)) control(connection.ws, { type: 'end', id, direction: 'upload' });
    } catch (error) { request.fail(error instanceof HubTransportError ? error : this.failure(request)); } })();
    return done;
  }
  cancelDevice(id) {
    const connection = this.devices.get(id); if (!connection) return;
    clearInterval(connection.heartbeat);
    this.devices.delete(id);
    for (const request of [...connection.requests.values()]) request.fail(this.failure(request));
    connection.ws.close(1008, 'Device disconnected');
  }
  cancelSession(token) { for (const connection of this.devices.values()) for (const request of [...connection.requests.values()]) if (request.context.sessionToken === token) request.fail(this.revoked(request)); }
  close() { for (const id of [...this.devices.keys()]) this.cancelDevice(id); }
}
