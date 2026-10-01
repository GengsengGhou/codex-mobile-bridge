import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { HubStore } from './store.mjs';
import { HubAuth } from './auth.mjs';
import { HubError } from './errors.mjs';
import { HubRelay } from './relay.mjs';
import { allowedBridgeRequest } from './protocol.mjs';
import { hubResources } from './resources.mjs';
import { publicAssets, assetContentType, appCsp } from '../src/static-assets.mjs';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DEVICE_ROUTE = new RegExp(`^/devices/(${UUID})(/.*)?$`, 'i');
const DEVICE_API = new RegExp(`^/api/hub/devices/(${UUID})$`, 'i');
const ASSETS = new Set([...publicAssets, '/device-context.js']);
const sharedPublic = new URL('../public/', import.meta.url);
const hubPublic = new URL('./public/', import.meta.url);
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
async function readJson(req, keys) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HubError('需要 JSON 请求。', 'INVALID_REQUEST', 400);
  let size = 0; const parts = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw new HubError('请求过大。', 'BODY_TOO_LARGE', 413); parts.push(chunk); }
  let value; try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw new HubError('JSON 格式无效。', 'INVALID_REQUEST', 400); }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !keys.includes(key))) throw new HubError('请求参数无效。', 'INVALID_REQUEST', 400);
  return value;
}
function originSetting(value, insecure) {
  if (!value && insecure) return null;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(insecure && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) throw new Error('HUB_PUBLIC_ORIGIN must be an HTTPS origin.');
  return url.origin;
}

export function createHubServer({ store = new HubStore(), publicOrigin, allowInsecureLocal = false, relay, auth = new HubAuth(store), trustPrivateProxy = false, resources = hubResources(), maintenanceIntervalMs = 86400000 } = {}) {
  const configuredOrigin = originSetting(publicOrigin, allowInsecureLocal);
  const cookieName = allowInsecureLocal ? 'hub_session' : '__Host-hub_session';
  const validRequest = context => {
    const session = store.session(context.sessionToken);
    return Boolean(session && session.user.id === context.userId && store.device(context.deviceId, context.userId));
  };
  relay ||= new HubRelay({ ...resources, validateRequest: validRequest });
  store.maintenance();
  const maintenance = setInterval(() => {
    try { store.maintenance(); } catch { console.error('Hub metadata maintenance failed.'); }
  }, maintenanceIntervalMs);
  maintenance.unref();
  let activeHttp = 0;
  function requestOrigin(req) {
    const origin = configuredOrigin || `http://127.0.0.1:${server.address()?.port}`;
    if (req.headers.host !== new URL(origin).host) throw new HubError('入口地址不匹配。', 'FORBIDDEN', 403);
    if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) throw new HubError('拒绝跨站请求。', 'FORBIDDEN', 403);
    return origin;
  }
  function sessionToken(req) {
    const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
    return values.length === 1 ? values[0].slice(cookieName.length + 1) : null;
  }
  function sessionCookie(res, token, expiresAt) {
    res.setHeader('Set-Cookie', `${cookieName}=${token}; ${allowInsecureLocal ? '' : 'Secure; '}HttpOnly; SameSite=Strict; Path=/; ${token ? `Expires=${new Date(expiresAt).toUTCString()}` : 'Max-Age=0'}`);
  }
  const visibleDevices = userId => store.devices(userId).map(device => ({ ...device, online: relay.status(device.id) }));
  function clientIp(req) {
    const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!trustPrivateProxy) return peer;
    const privatePeer = peer === '::1' || /^127\./.test(peer) || /^10\./.test(peer) || /^192\.168\./.test(peer) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(peer);
    const client = req.headers['x-hub-client-ip'];
    if (!privatePeer || typeof client !== 'string' || !isIP(client)) throw new HubError('反向代理来源配置无效。', 'PROXY_CONFIGURATION', 503);
    return client.replace(/^::ffff:/, '');
  }
  async function serveAsset(req, res, file, directory) {
    const data = await readFile(new URL(file, directory));
    res.setHeader('Content-Type', assetContentType(file));
    if (file !== 'index.html') {
      const etag = `"${createHash('sha256').update(data).digest('hex')}"`;
      res.setHeader('ETag', etag); res.setHeader('Cache-Control', 'private, no-cache');
      if (req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
    }
    res.end(data);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', appCsp);
    if (!allowInsecureLocal) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    if (activeHttp >= resources.maxHttpRequests) { json(res, 503, { code: 'HUB_BUSY', error: 'HUB_BUSY' }); req.resume(); return; }
    activeHttp++;
    let released = false;
    const release = () => { if (!released) { released = true; activeHttp--; } };
    res.once('finish', release); res.once('close', release);
    try {
      const origin = requestOrigin(req);
      if (!req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url) || /%(?:2f|5c)/i.test(req.url.split('?')[0])) throw new HubError('请求地址无效。', 'INVALID_REQUEST', 400);
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/healthz') { json(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && ['/', '/hub.js', '/hub.css'].includes(url.pathname)) { await serveAsset(req, res, url.pathname === '/' ? 'index.html' : url.pathname.slice(1), hubPublic); return; }
      if (req.method === 'GET' && ['/hub-boot.js', '/i18n.js', '/i18n-messages.js'].includes(url.pathname)) { await serveAsset(req, res, url.pathname.slice(1), url.pathname === '/hub-boot.js' ? hubPublic : sharedPublic); return; }
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && (req.headers.origin !== origin || req.headers['x-bridge-client'] !== 'mobile-v1')) throw new HubError('拒绝跨站请求。', 'FORBIDDEN', 403);
      if (url.pathname.startsWith('/api/') && req.headers['x-bridge-client'] !== 'mobile-v1') throw new HubError('请求来源无效。', 'FORBIDDEN', 403);
      const token = sessionToken(req);
      const session = store.session(token);
      if (req.method === 'POST' && ['/api/hub/login', '/api/hub/register', '/api/hub/connect'].includes(url.pathname)) {
        auth.limit(clientIp(req));
        if (url.pathname === '/api/hub/connect') {
          const body = await readJson(req, ['pairingCode', 'name']);
          if (typeof body.pairingCode !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.pairingCode)) throw new HubError('配对码格式无效。', 'INVALID_PAIRING', 400);
          json(res, 200, store.consumePairing(body.pairingCode, body.name)); return;
        }
        const body = await readJson(req, url.pathname.endsWith('login') ? ['username', 'password'] : ['username', 'password', 'invite']);
        const grant = url.pathname.endsWith('login') ? await auth.login(body.username, body.password) : await auth.register(body.username, body.password, body.invite);
        sessionCookie(res, grant.token, grant.expiresAt);
        json(res, 200, { authenticated: true, user: grant.user, expiresAt: grant.expiresAt, devices: visibleDevices(grant.user.id) }); return;
      }
      if (!session) throw new HubError('请登录后继续。', 'LOGIN_REQUIRED', 401);
      if (req.method === 'GET' && url.pathname === '/api/hub/me') { json(res, 200, { authenticated: true, ...session, devices: visibleDevices(session.user.id) }); return; }
      if (req.method === 'POST' && url.pathname === '/api/hub/logout') {
        await readJson(req, []); store.logout(token); relay.cancelSession(token); sessionCookie(res, '', 0); json(res, 200, { authenticated: false }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/hub/devices') { json(res, 200, { devices: visibleDevices(session.user.id) }); return; }
      if (req.method === 'POST' && url.pathname === '/api/hub/invitations') { await readJson(req, []); json(res, 200, store.invite(session.user.id)); return; }
      if (req.method === 'POST' && url.pathname === '/api/hub/pairings') { const body = await readJson(req, ['name']); json(res, 200, store.pairing(session.user.id, body.name)); return; }
      const deviceApi = url.pathname.match(DEVICE_API);
      if (deviceApi) {
        if (req.method === 'PATCH') { const body = await readJson(req, ['name']); const device = store.renameDevice(session.user.id, deviceApi[1], body.name); json(res, 200, { device: { id: device.id, name: device.name, online: relay.status(device.id), createdAt: device.createdAt } }); return; }
        if (req.method === 'DELETE') { await readJson(req, []); store.revokeDevice(session.user.id, deviceApi[1]); relay.cancelDevice(deviceApi[1]); json(res, 200, { revoked: true }); return; }
      }
      const deviceRoute = url.pathname.match(DEVICE_ROUTE);
      if (deviceRoute) {
        const deviceId = deviceRoute[1], path = deviceRoute[2] || '/';
        const device = store.device(deviceId, session.user.id);
        if (!device) throw new HubError('设备不存在。', 'NOT_FOUND', 404);
        if (req.method === 'GET' && !deviceRoute[2]) { res.writeHead(308, { Location: `/devices/${device.id}/${url.search}` }); res.end(); return; }
        const context = { mode: 'hub', authenticated: true, user: session.user, device: { id: device.id, name: device.name, online: relay.status(device.id) }, expiresAt: session.expiresAt };
        if (req.method === 'GET' && ['/context', '/api/access'].includes(path)) { json(res, 200, context); return; }
        if (req.method === 'GET' && ASSETS.has(path)) { await serveAsset(req, res, path === '/' ? 'index.html' : path.slice(1), sharedPublic); return; }
        if (req.headers['x-bridge-client'] !== 'mobile-v1') throw new HubError('请求来源无效。', 'FORBIDDEN', 403);
        const bridgePath = `${path}${url.search}`;
        if (!allowedBridgeRequest(req.method, bridgePath)) throw new HubError('此入口未开放该操作。', 'NOT_FOUND', 404);
        await relay.proxy(deviceId, req, res, bridgePath, { userId: session.user.id, sessionToken: token, deviceId }); return;
      }
      throw new HubError('页面不存在。', 'NOT_FOUND', 404);
    } catch (error) {
      if (!res.headersSent && !res.destroyed) json(res, Number.isInteger(error.status) ? error.status : 503, { code: error.code || 'HUB_UNAVAILABLE', error: error instanceof HubError || error.status ? error.message : '入口暂时不可用。' });
      else if (!res.destroyed) res.destroy();
      if (!req.complete && !req.destroyed) req.resume();
    }
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 65572, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    try {
      const origin = requestOrigin(req), url = new URL(req.url, origin);
      if (url.pathname !== '/api/hub/connector' || [...url.searchParams.keys()].some(key => key !== 'deviceId') || req.headers['x-bridge-protocol'] !== '1') throw new HubError('连接协议不兼容。', 'PROTOCOL_ERROR', 400);
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '');
      const credential = match?.[1];
      const device = store.authenticateDevice(credential);
      if (!device || url.searchParams.get('deviceId') !== device.id) throw new HubError('设备凭据无效。', 'DEVICE_REVOKED', 401);
      relay.checkConnection(device.id, device.userId);
      websocket.handleUpgrade(req, socket, head, ws => {
        try { relay.attach(device.id, ws, { userId: device.userId, validateDevice: () => store.authenticateDevice(credential)?.id === device.id }); }
        catch { ws.close(1013, 'Hub busy'); }
      });
    } catch (error) {
      // Rejected WebSocket handshakes stay raw sockets; reset peers can race the refusal response.
      socket.on('error', () => socket.destroy());
      socket.end(`HTTP/1.1 ${error.status || 403} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  });
  server.maxConnections = resources.maxHttpConnections; server.maxRequestsPerSocket = 1000;
  server.requestTimeout = 120000; server.headersTimeout = 10000; server.relay = relay; server.store = store;
  server.on('close', () => { clearInterval(maintenance); relay.close(); websocket.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const resources = hubResources();
  const store = new HubStore({ path: process.env.HUB_DB_PATH || 'data/hub.sqlite', maxUsers: resources.maxUsers, maxDeviceRecords: resources.maxDeviceRecords, revokedRetentionDays: resources.revokedRetentionDays });
  const server = createHubServer({ store, resources, publicOrigin: process.env.HUB_PUBLIC_ORIGIN, trustPrivateProxy: process.env.HUB_TRUST_PRIVATE_PROXY === '1' });
  server.listen(Number(process.env.PORT || 3000), process.env.HUB_BIND_HOST || '0.0.0.0', () => console.log('Hub listening on its private HTTP port.'));
  const stop = () => { server.relay.close(); server.close(() => { store.close(); }); server.closeAllConnections(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
