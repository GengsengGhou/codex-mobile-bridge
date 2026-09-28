import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../src/desktop.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { permissionSelection, currentPermissionMode, permissionRoots } from '../src/permission-settings.mjs';
import { summarizeThreadContext } from '../src/thread-context.mjs';
import { allowedBridgeRequest } from '../hub/protocol.mjs';

test('permission selection validates exact modes and distinguishes inherited/custom/unknown current settings', () => {
  assert.deepEqual(permissionSelection({}), {});
  for (const value of ['inherit', null, {}, 'danger-full-access']) assert.throws(() => permissionSelection({ permissionMode: value }), { code: 'INVALID_REQUEST' });
  assert.equal(currentPermissionMode({}, null), 'unknown');
  assert.equal(currentPermissionMode({ currentPermissions: { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } } }), 'full-access');
  assert.equal(currentPermissionMode({ currentPermissions: { approvalPolicy: 'never', approvalsReviewer: 'guardian_subagent', sandboxPolicy: { type: 'dangerFullAccess' } } }), 'custom');
});

test('permission roots must be absolute and Windows aliases do not add writable authority', () => {
  assert.deepEqual(permissionRoots({ cwd: 'E:/repo', currentPermissions: { runtimeWorkspaceRoots: ['E:\\repo', 'e:/repo', 'C:\\Users\\example\\.codex/visualizations/test'] } }), ['E:\\repo', 'C:\\Users\\example\\.codex/visualizations/test']);
  assert.deepEqual(permissionRoots({ cwd: '/workspace/repo', currentPermissions: { runtimeWorkspaceRoots: ['/workspace/repo/../repo'] } }), ['/workspace/repo/../repo']);
  assert.deepEqual(permissionRoots({ cwd: '\\\\server\\share\\repo' }), ['\\\\server\\share\\repo']);
  for (const root of ['relative', 'C:relative', '\\drive-relative', 'invalid\nroot', 'https://host/repo']) {
    assert.equal(permissionRoots({ cwd: root }), null);
    assert.equal(permissionRoots({ cwd: 'E:/repo', currentPermissions: { runtimeWorkspaceRoots: [root] } }), null);
  }
});
async function fixture(t, { status = 'idle', controlError, deliveryError, controlNotDispatched = false, controlAvailable = true, contextError, sendScope = 'all-local', delegated = false } = {}) {
  const id = randomUUID(), callerThreadId = randomUUID(), store = new DeliveryStore({ path: null });
  let native = 0, ordinary = 0;
  const bridge = { callerThreadId, capabilities: async () => ['read_thread', 'list_threads', 'send_message_to_thread'],
    read: async threadId => ({ thread: { id: threadId, kind: 'codex', hostId: 'local', status, cwd: null, ...(delegated ? { delegated: true } : {}) }, turns: [] }),
    send: async () => { ordinary++; } };
  const control = {
    send: async (threadId, _prompt, selection, { beforeDispatch }) => {
      if (controlError) throw new BridgeError('preflight', controlError, 409);
      await beforeDispatch();
      if (deliveryError && controlNotDispatched) {
        const error = new BridgeError('final preflight', deliveryError, 409);
        Object.defineProperty(error, 'controlNotDispatched', { value: true });
        throw error;
      }
      native++;
      if (deliveryError) throw new BridgeError('uncertain', deliveryError, 409);
      return { threadId, delivered: true, permissionMode: selection.permissionMode };
    },
    context: async threadId => {
      if (contextError) throw new BridgeError('private native data', contextError, 503);
      const threadContext = summarizeThreadContext({ id: threadId, cwd: 'E:/repo', currentPermissions: { approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'dangerFullAccess' } } }, [], null);
      return { threadId, cwd: null, permissionActive: status === 'active', threadContext, ownerClientId: 'private owner' };
    },
  };
  const server = createBridgeServer({ bridge, enableSend: true, allowedSendThreadId: id, sendScope, control: controlAvailable ? control : null, deliveryStore: store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookie = (await fetch(base)).headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'X-Bridge-Client': 'mobile-v1', 'Content-Type': 'application/json' };
  return { id, store, native: () => native, ordinary: () => ordinary,
    post: body => fetch(`${base}/api/threads/${id}/messages`, { method: 'POST', headers, body: JSON.stringify(body) }),
    get: (path, extra = {}) => fetch(base + path, { headers: { ...headers, ...extra } }),
  };
}
test('HTTP defaults inherit and explicit permissions fingerprint receipts and dispatch exactly once', async t => {
  const f = await fixture(t), requestId = randomUUID();
  const body = { requestId, prompt: 'message', permissionMode: 'request-approval' };
  const first = await (await f.post(body)).json(); assert.equal(first.permissionMode, 'request-approval');
  assert.deepEqual(await (await f.post(body)).json(), first); assert.equal(f.native(), 1); assert.equal(f.ordinary(), 0);
  assert.equal((await (await f.post({ ...body, permissionMode: 'full-access' })).json()).code, 'CONFLICT');
  assert.equal((await f.post({ requestId: randomUUID(), prompt: 'inherit' })).status, 200); assert.equal(f.ordinary(), 1);
});
test('preflight failures preserve original errors without reserving, and active/unknown settings cannot bypass gates', async t => {
  for (const [config, code] of [
    [{ status: 'active' }, 'PERMISSION_CHANGE_ACTIVE'], [{ controlAvailable: false }, 'PERMISSION_UNAVAILABLE'],
    [{ controlError: 'UNSUPPORTED_THREAD' }, 'UNSUPPORTED_THREAD'], [{ controlError: 'OWNER_UNAVAILABLE' }, 'OWNER_UNAVAILABLE'],
    [{ delegated: true }, 'SEND_DISABLED'],
  ]) {
    const f = await fixture(t, config), requestId = randomUUID();
    assert.equal((await (await f.post({ requestId, prompt: 'message', permissionMode: 'full-access' })).json()).code, code);
    assert.equal(await f.store.get(requestId), undefined); assert.equal(f.native(), 0);
  }
  const f = await fixture(t);
  for (const extra of [{ permissionMode: 'unknown' }, { sandboxPolicy: {} }, { approvalPolicy: 'never' }]) assert.equal((await f.post({ requestId: randomUUID(), prompt: 'message', ...extra })).status, 400);
});
test('unknown native delivery retains journal and prevents resend', async t => {
  const f = await fixture(t, { deliveryError: 'DELIVERY_UNKNOWN' }), body = { requestId: randomUUID(), prompt: 'message', permissionMode: 'full-access' };
  assert.equal((await f.post(body)).status, 409); assert.equal((await f.post(body)).status, 409); assert.equal(f.native(), 1);
  assert.equal((await f.store.get(body.requestId)).state, 'pending');
});

test('a confirmed final preflight rejection releases its reservation without a native send', async t => {
  for (const deliveryError of ['PERMISSION_CHANGE_ACTIVE', 'PERMISSION_UNAVAILABLE', 'OWNER_UNAVAILABLE']) {
    const f = await fixture(t, { deliveryError, controlNotDispatched: true }), requestId = randomUUID();
    const result = await (await f.post({ requestId, prompt: 'message', permissionMode: 'full-access' })).json();
    assert.equal(result.code, deliveryError); assert.equal(await f.store.get(requestId), undefined); assert.equal(f.native(), 0);
  }
});
test('context is readonly/authenticated, exposes capabilities and fails safely for unloaded owners', async t => {
  const f = await fixture(t);
  const context = await (await f.get(`/api/threads/${f.id}/context`)).json();
  assert.equal(context.available, true); assert.equal(context.permissions.current, 'full-access'); assert.equal(context.permissions.canOverride, true);
  assert.equal(JSON.stringify(context).includes('private owner'), false); assert.equal(JSON.stringify(context).includes('permissionRoots'), false);
  assert.equal((await f.get(`/api/threads/${f.id}/context`, { cookie: '' })).status, 401);
  assert.equal((await f.get(`/api/threads/${f.id}/context`, { Origin: 'https://evil.example' })).status, 403);
  const old = await fixture(t, { contextError: 'OWNER_UNAVAILABLE' });
  const unavailable = await (await old.get(`/api/threads/${old.id}/context`)).json();
  assert.equal(unavailable.available, false); assert.equal(unavailable.code, 'OWNER_UNAVAILABLE'); assert.equal(unavailable.permissions.canOverride, false);
  assert.equal(JSON.stringify(unavailable).includes('private native data'), false);
  assert.equal(allowedBridgeRequest('GET', `/api/threads/${f.id}/context`), true);
  assert.equal(allowedBridgeRequest('POST', `/api/threads/${f.id}/context`), false);
});
