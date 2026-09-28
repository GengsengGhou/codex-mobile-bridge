export const VERSION = 1;
export const FRAME_BYTES = 64 * 1024;
export const MAX_PAYLOAD = FRAME_BYTES + 36;
export const UPLOAD_LIMIT = 20 * 1024 * 1024;
export const DOWNLOAD_LIMIT = 100 * 1024 * 1024;
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const uuid = new RegExp(`^${UUID}$`);
export const REQUEST_HEADERS = ['content-type', 'content-length', 'range', 'if-range', 'if-none-match', 'if-modified-since'];
export const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
export function allowedBridgeRequest(method, path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20]/.test(path)) return false;
  let url; try { url = new URL(path, 'http://127.0.0.1'); } catch { return false; }
  if (url.hash || url.pathname.includes('%')) return false;
  const p = url.pathname;
  if (method === 'GET' && /^\/api\/(status|recovery|sidebar-order|projects|threads|archives)$/.test(p)) return true;
  if (method === 'PUT' && p === '/api/sidebar-order') return true;
  if (method === 'POST' && p === '/api/threads') return true;
  if (method === 'GET' && new RegExp(`^/api/thread-creations/${UUID}$`).test(p)) return true;
  if (method === 'POST' && new RegExp(`^/api/archives/${UUID}/restore$`).test(p)) return true;
  if (method === 'GET' && new RegExp(`^/api/threads/${UUID}(?:/(?:context|control|files|file|messages/${UUID}|uploads/${UUID}))?$`).test(p)) return true;
  return method === 'POST' && new RegExp(`^/api/threads/${UUID}/(?:messages|settings|control|stop|respond|uploads/${UUID})$`).test(p);
}
export function selectHeaders(headers, allowed) {
  const result = {};
  for (const name of allowed) if (typeof headers?.[name] === 'string' && headers[name].length <= 4096 && !/[\r\n]/.test(headers[name])) result[name] = headers[name];
  return result;
}
export function control(ws, message) {
  const text = JSON.stringify({ v: VERSION, ...message });
  if (Buffer.byteLength(text) > 16384 || ws.readyState !== 1) throw new Error('Transport unavailable');
  ws.send(text);
}
export function binary(ws, id, bytes) {
  if (!uuid.test(id) || bytes.length > FRAME_BYTES || ws.readyState !== 1) throw new Error('Invalid frame');
  ws.send(Buffer.concat([Buffer.from(id, 'ascii'), bytes]));
}
export function decode(data, isBinary) {
  if (isBinary) {
    if (data.length <= 36 || data.length > MAX_PAYLOAD) throw new Error('Invalid frame');
    const id = data.subarray(0, 36).toString('ascii');
    if (!uuid.test(id)) throw new Error('Invalid identifier');
    return { type: 'data', id, bytes: data.subarray(36) };
  }
  if (data.length > 16384) throw new Error('Control too large');
  const value = JSON.parse(data.toString());
  if (!value || value.v !== VERSION || !uuid.test(value.id) || !['request', 'response', 'end', 'ack', 'cancel', 'error'].includes(value.type)) throw new Error('Invalid control');
  return value;
}
export class HubTransportError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
