import http from 'node:http';
import WebSocket from 'ws';
import { classifyNetworkError, networkErrorMessage } from '../scripts/network-error.mjs';
import { hubClockTransport } from '../scripts/hub-clock.mjs';
import { allowedBridgeRequest, control, binary, decode, FRAME_BYTES, MAX_PAYLOAD, UPLOAD_LIMIT, DOWNLOAD_LIMIT, selectHeaders, REQUEST_HEADERS, RESPONSE_HEADERS } from './protocol.mjs';

export function startConnector({ hubOrigin, deviceId, deviceToken, bridgePort = 4317, allowInsecureLocal = false, WebSocketImpl = WebSocket, reconnectMinMs = 500, reconnectMaxMs = 30000, handshakeTimeoutMs = 10000, requestTimeoutMs = 120000, maxInFlight = 8, collaborationExecutor, clockTransport: suppliedClockTransport } = {}) {
  const hub = new URL(hubOrigin);
  if (hub.username || hub.password || hub.pathname !== '/' || hub.search || hub.hash || !(hub.protocol === 'https:' || allowInsecureLocal && hub.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(hub.hostname))) throw new Error('Invalid hub origin');
  if (!Number.isInteger(bridgePort) || bridgePort < 1 || bridgePort > 65535 || typeof deviceId !== 'string' || !deviceId || typeof deviceToken !== 'string' || !deviceToken || /[\r\n]/.test(deviceToken)) throw new Error('Invalid connector configuration');
  if (!Number.isSafeInteger(handshakeTimeoutMs) || handshakeTimeoutMs < 1 || handshakeTimeoutMs > 2147483647) throw new Error('Invalid handshake timeout');
  const backend = new URL(`http://127.0.0.1:${bridgePort}`), endpoint = new URL('/api/hub/connector', hub);
  endpoint.protocol = hub.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.searchParams.set('deviceId', deviceId);
  let stopped = false, ws = null, timer, attempt = 0, cookie = null, acquiring = null, acquiringHttp = null, state = 'connecting', networkError = null, clockCompatible = false;
  const clockTransport = suppliedClockTransport || (hub.protocol === 'https:' && WebSocketImpl === WebSocket ? hubClockTransport({ hubOrigin: hub.origin, deviceId, deviceToken }) : null);
  const requests = new Map();
  function acquire() {
    if (!acquiring) acquiring = new Promise((resolve, reject) => {
      const request = http.get(new URL('/', backend), { headers: { host: backend.host } }, response => {
        const value = response.headers['set-cookie']?.find(v => /^bridge_session=[a-f0-9]+;/.test(v));
        response.resume();
        response.on('error', reject);
        response.on('end', () => { if (response.statusCode !== 200 || !value) reject(new Error('Local authentication unavailable')); else { cookie = value.split(';')[0]; resolve(); } });
      });
      acquiringHttp = request;
      request.setTimeout(Math.min(requestTimeoutMs, 10000), () => request.destroy(new Error('Local authentication timeout')));
      request.on('error', reject);
    }).finally(() => { acquiring = null; acquiringHttp = null; });
    return acquiring;
  }
  function dispose(request) {
    if (!requests.has(request.id)) return;
    requests.delete(request.id); clearTimeout(request.timer);
    request.cancelled = true;
    request.http?.destroy(); request.response?.destroy();
    request.downloadAck?.();
  }
  function disconnect(socket) {
    if (ws !== socket) return;
    ws = null; state = stopped ? 'stopped' : 'offline';
    for (const request of [...requests.values()]) dispose(request);
    socket.close();
    if (!stopped) { const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(attempt++, 10)); timer = setTimeout(connect, delay); }
  }
  async function respond(request, response, retry = false) {
    request.response = response;
    try {
      if (response.statusCode === 401 && request.method === 'GET' && !retry) {
        response.destroy(); await acquire();
        if (!request.cancelled) upstream(request, true).end();
        return;
      }
      if (request.cancelled) { response.destroy(); return; }
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > DOWNLOAD_LIMIT)) throw new Error('Download too large');
      control(request.ws, { type: 'response', id: request.id, status: response.statusCode, headers: selectHeaders(response.headers, RESPONSE_HEADERS) });
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > DOWNLOAD_LIMIT) throw new Error('Download too large');
        for (let offset = 0; offset < chunk.length; offset += FRAME_BYTES) {
          if (request.cancelled) return;
          const ack = new Promise(resolve => { request.downloadAck = resolve; });
          binary(request.ws, request.id, chunk.subarray(offset, offset + FRAME_BYTES)); await ack;
        }
      }
      if (!request.cancelled) control(request.ws, { type: 'end', id: request.id, direction: 'download' });
      dispose(request);
    } catch { fail(request); }
  }
  function fail(request) {
    if (!requests.has(request.id)) return;
    try { control(request.ws, { type: 'error', id: request.id, code: 'BRIDGE_UNAVAILABLE' }); } catch {}
    dispose(request);
  }
  function upstream(request, retry = false) {
    const headers = { ...selectHeaders(request.headers, REQUEST_HEADERS), host: backend.host, origin: backend.origin, 'x-bridge-client': 'mobile-v1', cookie };
    if (request.method === 'GET') delete headers['content-length'];
    const outgoing = http.request(new URL(request.path, backend), { method: request.method, headers }, response => { void respond(request, response, retry); });
    request.http = outgoing;
    outgoing.on('error', () => fail(request));
    outgoing.setTimeout(requestTimeoutMs, () => outgoing.destroy(new Error('Local request timeout')));
    return outgoing;
  }
  async function collaborate(request) {
    try {
      let status = 200, value;
      try {
        if (!collaborationExecutor) throw Object.assign(new Error('Computer collaboration is disabled.'), { code: 'COLLABORATION_UNAVAILABLE', status: 403 });
        value = await collaborationExecutor({ ...request.collaboration, request: JSON.parse(Buffer.concat(request.parts).toString('utf8')) });
      } catch (error) { status = error.status || 503; value = { code: error.code || 'COLLABORATION_UNAVAILABLE', error: error.message }; }
      if (request.cancelled) return;
      const bytes = Buffer.from(JSON.stringify(value));
      if (bytes.length > 2 * 1024 * 1024) throw new Error('Collaboration result too large');
      control(request.ws, { type: 'response', id: request.id, status, headers: { 'content-type': 'application/json', 'content-length': String(bytes.length) } });
      for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
        if (request.cancelled) return;
        const ack = new Promise(resolve => { request.downloadAck = resolve; });
        binary(request.ws, request.id, bytes.subarray(offset, offset + FRAME_BYTES)); await ack;
      }
      if (!request.cancelled) control(request.ws, { type: 'end', id: request.id, direction: 'download' });
      dispose(request);
    } catch { fail(request); }
  }
  async function connect() {
    if (stopped) return;
    state = 'connecting';
    try { await acquire(); } catch { if (!stopped) { state = 'offline'; timer = setTimeout(connect, Math.min(reconnectMaxMs, reconnectMinMs * 2 ** Math.min(attempt++, 10))); } return; }
    if (stopped) return;
    const socket = new WebSocketImpl(endpoint, { headers: { Authorization: `Bearer ${deviceToken}`, 'X-Bridge-Protocol': '1' }, maxPayload: MAX_PAYLOAD, handshakeTimeout: handshakeTimeoutMs + (clockTransport ? 25000 : 0), ...(clockTransport ? { agent: clockTransport.agent } : {}) });
    ws = socket;
    socket.on('open', () => { if (ws === socket) { state = 'online'; attempt = 0; networkError = null; clockCompatible = socket._socket?.bridgeClockCompatible === true; } });
    socket.on('close', () => disconnect(socket)); socket.on('error', error => { if (ws === socket && !stopped) networkError = classifyNetworkError(error); disconnect(socket); });
    socket.on('message', (data, isBinary) => {
      try {
        if (ws !== socket || stopped) return;
        const message = decode(data, isBinary);
        if (message.type === 'request') {
          if (requests.has(message.id) || typeof message.method !== 'string' || typeof message.path !== 'string' || !message.headers || typeof message.headers !== 'object' || Array.isArray(message.headers)) throw new Error('Invalid request');
          if (!allowedBridgeRequest(message.method, message.path)) { control(socket, { type: 'error', id: message.id, code: 'BRIDGE_ROUTE_UNSUPPORTED' }); return; }
          if (requests.size >= maxInFlight) { control(socket, { type: 'error', id: message.id, code: 'BRIDGE_BUSY' }); return; }
          const request = { id: message.id, ws: socket, method: message.method, path: message.path, headers: message.headers, uploadBytes: 0, uploadPending: false, uploadEnded: false, cancelled: false, downloadAck: null };
          if (message.path === '/api/collaboration') {
            if (!message.collaboration || Object.keys(message.collaboration).length !== 2 || message.collaboration.targetDeviceId !== deviceId || typeof message.collaboration.sourceDeviceId !== 'string') throw new Error('Invalid collaboration identity');
            request.collaboration = message.collaboration; request.parts = [];
          } else if (message.collaboration) throw new Error('Unexpected collaboration identity');
          requests.set(message.id, request);
          request.timer = setTimeout(() => fail(request), requestTimeoutMs);
          const length = request.headers?.['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > UPLOAD_LIMIT)) throw new Error('Invalid length');
          if (!request.collaboration) upstream(request);
          return;
        }
        const request = requests.get(message.id);
        if (!request) return;
        if (message.type === 'cancel') dispose(request);
        else if (message.type === 'ack' && message.direction === 'download' && request.downloadAck) { const resolve = request.downloadAck; request.downloadAck = null; resolve(); }
        else if (message.type === 'data' && !request.uploadPending && !request.uploadEnded) {
          request.uploadBytes += message.bytes.length;
          if (request.uploadBytes > UPLOAD_LIMIT || request.method === 'GET') throw new Error('Upload too large');
          if (request.collaboration) { if (request.uploadBytes > 65536) throw new Error('Collaboration body too large'); request.parts.push(message.bytes); control(socket, { type: 'ack', id: request.id, direction: 'upload' }); return; }
          request.uploadPending = true;
          request.http.write(message.bytes, error => {
            if (request.cancelled) return;
            if (error) { fail(request); return; }
            request.uploadPending = false;
            try { control(socket, { type: 'ack', id: request.id, direction: 'upload' }); } catch { disconnect(socket); }
          });
        } else if (message.type === 'end' && message.direction === 'upload' && !request.uploadPending && !request.uploadEnded) { request.uploadEnded = true; if (request.collaboration) void collaborate(request); else request.http.end(); }
        else throw new Error('Unexpected frame');
      } catch { socket.close(1008, 'Invalid transport frame'); disconnect(socket); }
    });
  }
  void connect();
  return {
    stop() { stopped = true; clearTimeout(timer); acquiringHttp?.destroy(new Error('Connector stopped')); state = 'stopped'; for (const request of [...requests.values()]) dispose(request); ws?.close(1000, 'Connector stopped'); ws = null; },
    status() { return { state, connected: state === 'online', inFlight: requests.size, clockCompatible: state === 'online' && clockCompatible, networkError: stopped ? null : networkError, lastError: !stopped && networkError ? networkErrorMessage(networkError) : null }; },
  };
}
