import { resolve, basename } from 'node:path';
import { open, mkdir, lstat, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { effectivePolicy, readPrivate, reservePrivate, UUID, fail, definitiveRejection, collaborationAuthorizationMessage } from './collaboration-common.mjs';
import { connectorMayRun } from './connector-control.mjs';

export async function hubCollaboration(config, targetDeviceId, request, { fetchImpl = fetch, timeoutMs = 25000 } = {}) {
  const url = new URL(config.hubOrigin);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !(url.protocol === 'https:' || config.allowInsecureLocal && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) fail('INVALID_HUB', 400);
  if (!UUID.test(config.deviceId || '') || !/^[A-Za-z0-9_-]{43}$/.test(config.deviceToken || '')) fail('INVALID_DEVICE', 400);
  const response = await fetchImpl(url.origin + '/api/hub/collaboration/devices' + (targetDeviceId ? '/' + targetDeviceId : ''), { method: targetDeviceId ? 'POST' : 'GET', redirect: 'error', headers: { authorization: `Bearer ${config.deviceToken}`, 'x-bridge-client': 'computer-v1', ...(targetDeviceId ? { 'content-type': 'application/json' } : {}) }, body: targetDeviceId ? JSON.stringify(request) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if ([404, 405].includes(response.status) && !targetDeviceId || response.status === 401 && !response.headers.get('content-type')?.includes('json')) fail('FEATURE_UNAVAILABLE', 503, '服务器尚未支持电脑协作，请由管理员更新服务器后重试。');
  let size = 0; const parts = [];
  for await (const part of response.body) { size += part.length; if (size > 2 * 1024 * 1024) fail('RESULT_TOO_LARGE', 413); parts.push(part); }
  let result; try { result = JSON.parse(Buffer.concat(parts).toString()); } catch { fail('FEATURE_UNAVAILABLE', 503, '服务器尚未支持电脑协作，请由管理员更新服务器后重试。'); }
  if (!targetDeviceId && !response.ok && ['FORBIDDEN', 'LOGIN_REQUIRED', 'NOT_FOUND'].includes(result.code)) fail('FEATURE_UNAVAILABLE', 503, '服务器尚未支持电脑协作，请由管理员更新服务器后重试。');
  if (!response.ok) fail(result.code || 'FEATURE_UNAVAILABLE', response.status, result.code === 'DEVICE_REVOKED' ? '服务器未接受当前设备凭据。请核对当前服务器和配对身份；必要时重新配对，再明确保存电脑协作授权。' : result.error);
  if (!targetDeviceId && (result.version !== 1 || result.sourceDeviceId !== config.deviceId || !Array.isArray(result.devices))) fail('FEATURE_UNAVAILABLE', 503);
  return result;
}
export function createCollaborationClient({ root, fetchImpl = fetch } = {}) {
  root = resolve(root);
  const configPath = resolve(root, '.local/hub-connector.json'), policyPath = resolve(root, '.local/computer-collaboration.json'), journalPath = resolve(root, '.local/collaboration-outbox');
  let queue = Promise.resolve();
  const serialize = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function enabled() {
    if (!await connectorMayRun(root)) fail('COLLABORATION_CONNECTOR_PAUSED', 403, '连接器已断开。请先连接，再使用电脑协作。');
    try { await access(root + '.upgrade-journal.json'); fail('COLLABORATION_UPGRADING', 503, '连接器正在升级，请完成升级后重新加载 Codex 连接。'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const config = await readPrivate(configPath); const policy = effectivePolicy(await readPrivate(policyPath), config);
    if (policy.requiresAuthorization) fail('COLLABORATION_BINDING_CHANGED', 403, collaborationAuthorizationMessage);
    if (policy.controlPending) fail('COLLABORATION_SETTINGS_PENDING', 503, '电脑协作设置正在保存，请稍后重试。');
    if (!config || !policy.controlEnabled) {
      const registration = await readPrivate(resolve(root, '.local/collaboration-registration-state.json'));
      if (registration?.status === 'error') fail(registration.code || 'COLLABORATION_REGISTRATION_FAILED', 409, registration.message || '电脑协作注册未完成。请在连接器设置中检查错误后重试。');
      fail('COLLABORATION_CONTROL_DISABLED', 403, '请在连接器设置中开启“本机 Codex 指挥其他电脑”。');
    }
    return config;
  }
  async function remote(deviceId, request, options = {}) {
    const config = await enabled();
    if (!UUID.test(deviceId || '') || deviceId === config.deviceId) fail('INVALID_DEVICE', 400);
    const result = await hubCollaboration(config, deviceId, request, { fetchImpl, ...options });
    try { const current = await enabled(); if (current.deviceId !== config.deviceId || current.hubOrigin !== config.hubOrigin) fail('COLLABORATION_BINDING_CHANGED'); }
    catch (e) { e.collaborationDispatched = ['accepted', 'created', 'unknown'].includes(result?.state); throw e; }
    return result;
  }
  return {
    async devices() {
      const config = await enabled(); const data = await hubCollaboration(config, null, null, { fetchImpl }); const devices = [];
      const probes = await Promise.all(data.devices.slice(0, 10).map(async item => {
        if (!UUID.test(item.id || '') || !item.online) return null;
        try { const capability = await remote(item.id, { operation: 'capabilities' }, { timeoutMs: 5000 }); if (capability.deviceId !== item.id || capability.version !== 1) fail('DESKTOP_PROTOCOL_ERROR', 502); return { id: item.id, name: item.name, online: true }; }
        catch { return null; }
      }));
      await enabled(); return { devices: probes.filter(Boolean), authorizedOnly: true, discoveryTimeoutMs: 5000 };
    },
    async call(deviceId, request) {
      if (request.operation === 'create' || request.operation === 'send') return serialize(async () => {
        const config = await enabled();
        if (!UUID.test(deviceId || '') || deviceId === config.deviceId || typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 12000 || request.operation === 'send' && !UUID.test(request.threadId || '') || request.operation === 'create' && (typeof request.projectId !== 'string' || !request.projectId || request.projectId.length > 256) || request.title !== undefined && (typeof request.title !== 'string' || request.title.length > 200)) fail('INVALID_OPERATION', 400);
        const operationId = request.operationId || randomUUID(); if (!UUID.test(operationId)) fail('INVALID_OPERATION_ID', 400);
        const payload = { ...request, operationId }, payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const recordPath = resolve(journalPath, operationId + '.json'); const existing = await readPrivate(recordPath);
        if (existing) {
          if (existing.deviceId !== deviceId || existing.sourceDeviceId !== config.deviceId || existing.hubOrigin !== config.hubOrigin || existing.payloadHash !== payloadHash) fail('OPERATION_CONFLICT', 409);
          try { return await remote(deviceId, { operation: 'receipt', operationId }); }
          catch (e) { return { state: 'unknown', operationId, code: e.code || 'TRANSPORT_UNAVAILABLE', message: 'Receipt query failed. Do not resend this operation or create a replacement ID.' }; }
        }
        const entry = { deviceId, sourceDeviceId: config.deviceId, hubOrigin: config.hubOrigin, payloadHash, operation: payload.operation };
        if (!await reservePrivate(recordPath, entry)) {
          const concurrent = await readPrivate(recordPath);
          if (JSON.stringify(concurrent) !== JSON.stringify(entry)) fail('OPERATION_CONFLICT', 409);
          try { return await remote(deviceId, { operation: 'receipt', operationId }); }
          catch (e) { return { state: 'unknown', operationId, code: e.code || 'TRANSPORT_UNAVAILABLE', message: 'Receipt query failed. Do not resend this operation.' }; }
        }
        try { return await remote(deviceId, payload); }
        catch (e) { const rejected = !e.collaborationDispatched && definitiveRejection(e.code); return { state: rejected ? 'rejected' : 'unknown', operationId, code: e.collaborationDispatched ? 'DELIVERY_UNKNOWN' : e.code || 'TRANSPORT_UNAVAILABLE', message: rejected ? 'The request was rejected before target acceptance.' : 'Query this operation receipt. Do not resend or create a replacement ID.' }; }
      });
      return remote(deviceId, request);
    },
    async wait(deviceId, threadId, { timeoutMs = 15000, turnId } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 20000) fail('INVALID_WAIT', 400);
      const deadline = Date.now() + timeoutMs;
      let status;
      do {
        try { status = await remote(deviceId, { operation: 'status', threadId }, { timeoutMs: Math.max(1, Math.min(5000, timeoutMs === 0 ? 5000 : deadline - Date.now())) }); }
        catch (e) { return { threadId, available: false, timedOut: Date.now() >= deadline, code: e.code || 'STATUS_UNAVAILABLE' }; }
        if (!status.available || status.needsAttention || !status.turnId || turnId && status.turnId !== turnId) return { ...status, timedOut: false };
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
      } while (Date.now() <= deadline);
      return { ...status, timedOut: true };
    },
    async download(deviceId, threadId, path) {
      const result = await remote(deviceId, { operation: 'file', threadId, path });
      if (result.threadId !== threadId || result.path !== path || typeof result.bytes !== 'string' || !/^[a-f0-9]{64}$/.test(result.sha256 || '') || result.size > 1024 * 1024) fail('FILE_PROTOCOL_ERROR', 502);
      const bytes = Buffer.from(result.bytes, 'base64');
      if (bytes.length !== result.size || createHash('sha256').update(bytes).digest('hex') !== result.sha256) fail('FILE_PROTOCOL_ERROR', 502);
      const directory = resolve(root, '.local/collaboration-downloads');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      if ((await lstat(directory)).isSymbolicLink() || (await lstat(resolve(root, '.local'))).isSymbolicLink()) fail('DOWNLOAD_DIRECTORY_UNSAFE');
      const name = basename(path).replace(/[^a-zA-Z0-9._-]/g, '_').slice(-100) || 'result';
      const destination = resolve(directory, randomUUID() + '-' + name);
      const handle = await open(destination, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      return { deviceId, threadId, path, localPath: destination, size: bytes.length, sha256: result.sha256 };
    }
  };
}
