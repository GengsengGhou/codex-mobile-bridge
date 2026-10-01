import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pipeline, finished } from 'node:stream/promises';
import { RemoteAuthError } from './remote-auth.mjs';
import { publicAssets, appCsp } from './static-assets.mjs';

const COOKIE = '__Host-bridge_remote';
const ASSETS = publicAssets;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const API = new RegExp(`^/api/(?:status|recovery|sidebar-order|projects|threads|archives|thread-creations/${UUID}|archives/${UUID}/restore|threads/${UUID}(?:/(?:messages(?:/${UUID})?|settings|context|control|stop|respond|files|file|uploads/${UUID}))?)$`);
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
const securityHeaders = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': appCsp,
};
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
const loopback = ip => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function parseOrigin(input, remote) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (remote ? url.protocol !== 'https:' : url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Invalid gateway origin');
  return url;
}
async function readBody(req, limit) {
  if (req.headers['content-length'] && (!/^\d+$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > limit)) throw new RemoteAuthError('BODY_TOO_LARGE', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new RemoteAuthError('BODY_TOO_LARGE', 413); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}

// TLS terminates at the tunnel. Its only upstream must be this loopback listener.
export function createRemoteGateway({ publicOrigin, bridgeOrigin = 'http://127.0.0.1:4317', auth, publicRoot = new URL('../public/', import.meta.url), timeoutMs = 30000, maxBodyBytes = 20 * 1024 * 1024 } = {}) {
  const publicURL = parseOrigin(publicOrigin, true), backend = parseOrigin(bridgeOrigin, false);
  const origin = publicURL.origin;
  let bridgeCookie = null, acquiring = null, inFlight = 0;
  function upstream(path, method, headers = {}, body, signal) {
    return new Promise((resolve, reject) => {
      const request = http.request(new URL(path, backend), { method, headers: { ...headers, host: backend.host, origin: backend.origin, 'x-bridge-client': 'mobile-v1', ...(bridgeCookie ? { cookie: bridgeCookie } : {}) }, signal }, resolve);
      request.on('error', reject); request.setTimeout(timeoutMs, () => request.destroy(new Error('timeout')));
      request.end(body);
    });
  }
  async function acquire() {
    if (!acquiring) {
      acquiring = (async () => {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await upstream('/', 'GET', {}, undefined, controller.signal);
          const cookie = response.headers['set-cookie']?.find(value => /^bridge_session=[a-f0-9]+;/.test(value));
          response.resume(); await finished(response);
          if (response.statusCode !== 200 || !cookie) throw new Error('backend authentication unavailable');
          bridgeCookie = cookie.split(';')[0];
        } finally { clearTimeout(timer); }
      })().finally(() => { acquiring = null; });
    }
    return acquiring;
  }
  const server = http.createServer(async (req, res) => {
    for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
    let timer, controller, counted = false;
    try {
      if (!loopback(req.socket.remoteAddress) || req.headers.host !== publicURL.host) throw new RemoteAuthError('FORBIDDEN', 403);
      if (!req.url.startsWith('/') || req.url.startsWith('//') || /[\\\x00-\x20]/.test(req.url)) throw new RemoteAuthError('INVALID_REQUEST', 400);
      if ((req.headers.origin && req.headers.origin !== origin) || (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site']))) throw new RemoteAuthError('FORBIDDEN', 403);
      const url = new URL(req.url, origin);
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation && (req.headers.origin !== origin || req.headers['x-bridge-client'] !== 'mobile-v1')) throw new RemoteAuthError('FORBIDDEN', 403);
      if (!['GET', 'HEAD', 'POST', 'PUT', 'DELETE'].includes(req.method)) throw new RemoteAuthError('METHOD_NOT_ALLOWED', 405);
      const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
      const token = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : null;
      const session = auth ? await auth.authenticate(token) : null;
      if (req.method === 'GET' && url.pathname === '/auth/status') { json(res, 200, { authenticated: !!session }); return; }
      if (req.method === 'GET' && ['/login', '/login.js', '/login.css', '/i18n.js', '/i18n-messages.js'].includes(url.pathname)) {
        const file = url.pathname === '/login' ? 'login.html' : url.pathname.slice(1);
        const content = await readFile(new URL(file, publicRoot));
        res.setHeader('Content-Type', `${file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html'}; charset=utf-8`); res.end(content); return;
      }
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        if (!auth || !await auth.isConfigured()) throw new RemoteAuthError('AUTH_NOT_CONFIGURED');
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) throw new RemoteAuthError('INVALID_REQUEST', 400);
        let value; try { value = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (error) { if (error instanceof RemoteAuthError) throw error; throw new RemoteAuthError('INVALID_REQUEST', 400); }
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'password')) throw new RemoteAuthError('INVALID_REQUEST', 400);
        const grant = await auth.login(value.password);
        res.setHeader('Set-Cookie', `${COOKIE}=${grant.token}; Secure; HttpOnly; SameSite=Strict; Path=/; Expires=${new Date(grant.expiresAt).toUTCString()}`);
        json(res, 200, { authenticated: true, expiresAt: grant.expiresAt }); return;
      }
      if (!session) {
        if (['GET', 'HEAD'].includes(req.method) && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) { res.writeHead(302, { Location: '/login' }); res.end(); }
        else json(res, 401, { code: 'LOGIN_REQUIRED', error: 'Login required' });
        return;
      }
      if (req.method === 'POST' && ['/auth/logout', '/auth/revoke-all'].includes(url.pathname)) {
        if (url.pathname === '/auth/logout') await auth.logout(token); else await auth.revokeAll();
        res.setHeader('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        json(res, 200, { authenticated: false }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/access') { json(res, 200, { mode: 'remote', authenticated: true, expiresAt: session.expiresAt }); return; }
      if (!ASSETS.has(url.pathname) && !API.test(url.pathname)) throw new RemoteAuthError('NOT_FOUND', 404);
      if (url.pathname.endsWith('/context') && req.method !== 'GET') throw new RemoteAuthError('METHOD_NOT_ALLOWED', 405);
      if (ASSETS.has(url.pathname) && !['GET', 'HEAD'].includes(req.method)) throw new RemoteAuthError('METHOD_NOT_ALLOWED', 405);
      if (inFlight >= 16) throw new RemoteAuthError('GATEWAY_BUSY', 503);
      inFlight++; counted = true;
      controller = new AbortController(); timer = setTimeout(() => { controller.abort(); if (!req.complete) req.destroy(); }, timeoutMs);
      req.on('aborted', () => controller.abort()); res.on('close', () => { if (!res.writableFinished) controller.abort(); });
      const body = mutation ? await readBody(req, maxBodyBytes) : undefined;
      if (!bridgeCookie) await acquire();
      const headers = {};
      for (const name of ['content-type', 'range', 'if-range', 'if-none-match', 'if-modified-since']) if (req.headers[name]) headers[name] = req.headers[name];
      if (body?.length || req.headers['content-length']) headers['content-length'] = body.length;
      let response = await upstream(`${url.pathname}${url.search}`, req.method, headers, body, controller.signal);
      if (response.statusCode === 401 && !mutation) {
        response.on('error', () => {}); response.destroy(); await acquire();
        response = await upstream(`${url.pathname}${url.search}`, req.method, headers, undefined, controller.signal);
      }
      for (const name of RESPONSE_HEADERS) if (response.headers[name] !== undefined) res.setHeader(name, response.headers[name]);
      if (ASSETS.has(url.pathname) && url.pathname !== '/' && response.headers['cache-control'] === 'private, no-cache') res.setHeader('Cache-Control', 'private, no-cache');
      res.statusCode = response.statusCode;
      await pipeline(response, res, { signal: controller.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const mutation = !['GET', 'HEAD'].includes(req.method);
        const code = error instanceof RemoteAuthError ? error.code : mutation && counted ? 'DELIVERY_UNKNOWN' : 'GATEWAY_UNAVAILABLE';
        json(res, error instanceof RemoteAuthError ? error.status : 502, { code, error: code });
      } else if (!res.destroyed) res.destroy();
    } finally { clearTimeout(timer); if (counted) inFlight--; if (!req.complete && !req.destroyed) req.resume(); }
  });
  server.requestTimeout = timeoutMs; server.headersTimeout = Math.min(timeoutMs, 10000);
  return server;
}
