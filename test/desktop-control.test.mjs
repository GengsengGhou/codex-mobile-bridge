import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopControl, controlFrame, summarizeSnapshot } from '../src/desktop-control.mjs';

const ID = '00000000-0000-7000-8000-000000000001';
const OWNER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
// Native receive fixtures encode independently: outbound controlFrame has a
// deliberately smaller limit than desktop conversation snapshots.
function nativeFrame(message, size) {
  const payload = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  const length = size ?? payload.length;
  assert.ok(length >= payload.length);
  const frame = Buffer.alloc(length + 4, 0x20);
  frame.writeUInt32LE(length); payload.copy(frame, 4);
  return frame;
}
function fixture({ current = 'turn-1', mutation = 'success', canonical = false, requests = [], ownerError, snapshotVersion = 11, items = [], owner = OWNER, revision = 8, stateProperties = {}, incoming = (_message, frame) => [frame], timeoutMs = 100 } = {}) {
  const messages = [], sockets = [];
  const connect = () => {
    const socket = new EventEmitter(); socket.destroyed = false; sockets.push(socket);
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; queueMicrotask(() => socket.emit('close')); } };
    const deliver = message => queueMicrotask(() => {
      for (const chunk of incoming(message, nativeFrame(message))) {
        if (socket.destroyed) break;
        socket.emit('data', chunk);
      }
    });
    socket.write = frame => {
      const message = JSON.parse(frame.subarray(4)); messages.push(message);
      const response = result => deliver({ type: 'response', requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: typeof owner === 'function' ? owner() : owner, result });
      if (message.method === 'initialize') response({ clientId: CLIENT });
      else if (message.method === 'thread-owner-discovery') {
        if (ownerError) deliver({ type: 'response', requestId: message.requestId, resultType: 'error', error: ownerError });
        else response({ supportsUntrustedAppInput: true });
      }
      else if (message.method === 'thread-stream-following-changed') {
        const currentId = typeof current === 'function' ? current() : current;
        const turns = currentId ? [{ turnId: currentId, status: 'inProgress', items }] : [{ turnId: 'completed', status: 'completed', items }];
        const state = { id: ID, cwd: 'E:/workspace', turns: canonical ? [] : turns, requests, ...(canonical ? { turnHistory: { kind: 'canonical', history: { entitiesByKey: { key: turns[0] } } } } : {}), ...stateProperties };
        deliver({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: typeof owner === 'function' ? owner() : owner, version: snapshotVersion, params: { conversationId: ID, hostId: 'local', change: { type: 'snapshot', revision: typeof revision === 'function' ? revision() : revision, conversationState: state } } });
      } else if (mutation === 'disconnect') queueMicrotask(() => socket.destroy());
      else if (mutation === 'error') deliver({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'request-timeout' });
      else response(message.method === 'thread-follower-interrupt-turn' ? { ok: true, interruptedTurnId: current } : ['thread-follower-start-turn', 'thread-follower-steer-turn'].includes(message.method) ? { result: { turn: { id: 'new-turn' } } } : { ok: true });
      return true;
    };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
  return { control: new DesktopControl({ connect, timeoutMs }), messages, sockets };
}

test('long native conversation frames recover the authentic turn and approval across fragmented and coalesced reads', async () => {
  const privateHistory = 'private-history-'.repeat(650000);
  const request = { id: 27, method: 'item/commandExecution/requestApproval', params: { threadId: ID, turnId: 'turn-1', command: 'npm test', cwd: 'E:/workspace' } };
  let receivedBytes = 0;
  const f = fixture({ items: [{ id: 'long-history', type: 'agentMessage', text: privateHistory }], requests: [request], timeoutMs: 1000,
    incoming: (message, frame) => {
      if (message.type !== 'broadcast') return [frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3)];
      receivedBytes = frame.readUInt32LE(0);
      // Unrelated frames in the same read must not disturb owner validation.
      const unrelated = nativeFrame({ type: 'broadcast', method: 'unrelated', params: {} });
      const wrongOwner = nativeFrame({ ...message, sourceClientId: CLIENT });
      const chunks = [Buffer.concat([unrelated, wrongOwner.subarray(0, 2)]), wrongOwner.subarray(2), frame.subarray(0, 1), frame.subarray(1, 3)];
      for (let offset = 3; offset < frame.length; offset += 65537) chunks.push(frame.subarray(offset, offset + 65537));
      chunks[chunks.length - 1] = Buffer.concat([chunks.at(-1), unrelated]);
      return chunks;
    }
  });
  const result = await f.control.snapshot(ID);
  assert.ok(receivedBytes > 8 * 1024 * 1024 && receivedBytes < 32 * 1024 * 1024);
  assert.equal(result.currentTurnId, 'turn-1'); assert.equal(result.ownerClientId, OWNER);
  assert.equal(result.pendingRequests.length, 1); assert.equal(result.pendingRequests[0].requestId, 27);
  assert.equal(result.pendingRequests[0].command, 'npm test'); assert.equal(result.pendingRequests[0].actionable, true);
  assert.ok(!JSON.stringify(result).includes('private-history'));
  assert.equal(f.messages.some(message => message.method.startsWith('thread-follower-')), false);
  assert.ok(f.sockets.every(socket => socket.destroyed));
});

test('the inclusive native receive limit accepts a complete 32 MiB JSON frame', async () => {
  const f = fixture({ timeoutMs: 2000, incoming: (message, frame) => message.type === 'broadcast'
    ? [nativeFrame(message, 32 * 1024 * 1024)] : [frame] });
  const result = await f.control.snapshot(ID);
  assert.equal(result.currentTurnId, 'turn-1'); assert.equal(result.status, 'inProgress');
  assert.ok(f.sockets.every(socket => socket.destroyed));
});

test('oversized headers, zero lengths and malformed frames fail safely and a fresh read can recover', async () => {
  for (const [kind, code, reason] of [['oversize', 'CONTROL_FRAME_TOO_LARGE', 'frame-too-large'], ['zero', 'CONTROL_FRAME_INVALID', 'invalid-frame'], ['json', 'CONTROL_FRAME_INVALID', 'invalid-frame']]) {
    let failOnce = true;
    const f = fixture({ incoming: (message, frame) => {
      if (message.type !== 'broadcast' || !failOnce) return [frame];
      failOnce = false;
      if (kind === 'json') return [nativeFrame('{private transcript and token')];
      const header = Buffer.alloc(4); header.writeUInt32LE(kind === 'oversize' ? 32 * 1024 * 1024 + 1 : 0);
      // No body follows: a rejected length must fail on the header alone.
      return [header.subarray(0, 2), header.subarray(2)];
    } });
    await assert.rejects(f.control.snapshot(ID), error => {
      assert.equal(error.code, code); assert.equal(error.status, 502);
      assert.equal(error.controlDiagnostic.reason, reason); assert.equal(error.controlDiagnostic.phase, 'receive');
      assert.doesNotMatch(JSON.stringify(error.controlDiagnostic), /private|transcript|token/);
      return true;
    });
    assert.equal(f.sockets[0].destroyed, true);
    assert.equal((await f.control.snapshot(ID)).currentTurnId, 'turn-1');
    assert.equal(f.sockets.length, 2);
    assert.equal(f.messages.some(message => message.method.startsWith('thread-follower-')), false);
  }
});

test('a malformed reply after native mutation remains unknown delivery and is never retried', async () => {
  const f = fixture({ incoming: (message, frame) => message.method === 'thread-follower-interrupt-turn'
    ? [nativeFrame('{private malformed reply')] : [frame] });
  await assert.rejects(f.control.stop(ID, 'turn-1'), { code: 'DELIVERY_UNKNOWN', status: 409 });
  assert.equal(f.messages.filter(message => message.method === 'thread-follower-interrupt-turn').length, 1);
  assert.equal(f.sockets.length, 1); assert.equal(f.sockets[0].destroyed, true);
});

test('outgoing requests retain their independent 8 MiB size bound', () => {
  const limit = 8 * 1024 * 1024;
  const prefixBytes = Buffer.byteLength(JSON.stringify({ text: '' }));
  const accepted = controlFrame({ text: 'x'.repeat(limit - prefixBytes) });
  assert.equal(accepted.readUInt32LE(0), limit);
  assert.throws(() => controlFrame({ text: 'x'.repeat(limit - prefixBytes + 1) }), { code: 'INVALID_REQUEST', status: 400 });
});

test('continued async siblings move out of pending and cannot be submitted; native requests remain pending', async () => {
  const group = (id, count) => ({ type: 'agentMessage', id, questions: Array.from({ length: count }, () => ({ title: 'Choose', options: ['A'] })) });
  const reply = id => ({ type: 'steeringUserMessage', status: 'accepted', input: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', id, 0]), question: 'Choose', answer: 'A' }])}\n</send_user_message_question_reply>` }] });
  const f = fixture({ items: [group('old', 2), reply('old'), group('new', 1), reply('new')], requests: [{ id: 13, method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 'turn-1', questions: [{ id: 'q', question: 'Native?' }] } }] });
  const result = await f.control.snapshot(ID);
  assert.deepEqual(result.pendingRequests.map(p => p.requestId), [13]);
  assert.equal(result.historicalQuestions.length, 1);
  const old = result.historicalQuestions[0];
  await assert.rejects(f.control.respond(ID, { requestId: old.requestId, token: old.token, answers: {} }), { code: 'REQUEST_CHANGED' });
  assert.equal(f.messages.some(m => m.method.startsWith('thread-follower-')), false);
});

test('source-defined handshake, owner discovery and snapshot preserve only control metadata', async () => {
  const f = fixture({ requests: [{ id: 13, method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 'turn-1', questions: [{ id: 'q1', question: 'display question', options: [] }] }, privateMetadata: 'private prompt' }] });
  const snapshot = await f.control.snapshot(ID);
  assert.equal(snapshot.currentTurnId, 'turn-1'); assert.equal(snapshot.pendingRequests[0].actionable, true);
  assert.equal(snapshot.pendingRequests[0].questions[0].question, 'display question'); assert.deepEqual(snapshot.pendingRequests[0].questionIds, ['q1']);
  assert.equal(f.messages[0].version, 0); assert.equal(f.messages[0].sourceClientId, 'initializing-client');
  assert.equal(f.messages[1].version, 1); assert.deepEqual(f.messages[1].params, { hostId: 'local', conversationId: ID });
  assert.deepEqual(f.messages[2].targetClientIds, [OWNER]); assert.equal(f.messages[2].version, 1);
  assert.ok(f.sockets.every(s => s.destroyed)); assert.ok(!JSON.stringify(snapshot).includes('private prompt'));
});
test('canonical turns supply active turn and completed turn never permits stopping', async () => {
  assert.equal((await fixture({ canonical: true }).control.snapshot(ID)).currentTurnId, 'turn-1');
  const idle = await fixture({ current: null }).control.snapshot(ID);
  assert.equal(idle.currentTurnId, null); assert.equal(idle.status, 'idle');
});

test('permission send uses fresh ordinary idle owner and verified native profile with compatible model settings', async () => {
  for (const permissionMode of ['full-access', 'request-approval']) {
    const f = fixture({ current: null }); let reservations = 0;
    const result = await f.control.send(ID, 'selected', { permissionMode, model: 'alpha', thinking: 'high' }, { beforeDispatch: fresh => { reservations++; assert.equal(fresh.currentTurnId, null); } });
    assert.equal(result.delivered, true); assert.equal(result.permissionMode, permissionMode); assert.equal(reservations, 1);
    const native = f.messages.at(-1); assert.equal(native.method, 'thread-follower-start-turn'); assert.equal(native.version, 2); assert.equal(native.targetClientId, OWNER);
    const request = native.params.turnStart.request;
    assert.equal(request.threadId, ID); assert.deepEqual(request.input, [{ type: 'text', text: 'selected', text_elements: [] }]);
    assert.equal(request.approvalPolicy, permissionMode === 'full-access' ? 'never' : 'on-request'); assert.equal(request.approvalsReviewer, 'user');
    assert.equal(request.permissions, permissionMode === 'full-access' ? ':danger-full-access' : ':workspace'); assert.equal(request.sandboxPolicy, undefined);
    assert.deepEqual(request.runtimeWorkspaceRoots, ['E:/workspace']); assert.equal(request.model, 'alpha'); assert.equal(request.effort, 'high');
    assert.deepEqual(native.params.turnStart.context, { inheritThreadSettings: true, useAppServerPermissionDefault: false });
  }
});

test('permission overrides reject active, unloaded protocol, and delegated state before reservation', async () => {
  for (const [options, code] of [
    [{ current: 'new-active' }, 'PERMISSION_CHANGE_ACTIVE'],
    [{ current: null, stateProperties: { threadRuntimeStatus: { type: 'active' } } }, 'PERMISSION_CHANGE_ACTIVE'],
    [{ current: null, stateProperties: { parentThreadId: OWNER } }, 'UNSUPPORTED_THREAD'],
    [{ current: null, stateProperties: { currentPermissions: { runtimeWorkspaceRoots: ['invalid\nroot'] } } }, 'PERMISSION_UNAVAILABLE'],
    [{ current: null, snapshotVersion: 12 }, 'PROTOCOL_INCOMPATIBLE'],
  ]) {
    const f = fixture(options); let reserved = false;
    await assert.rejects(f.control.send(ID, 'message', { permissionMode: 'full-access' }, { beforeDispatch: () => { reserved = true; } }), { code });
    assert.equal(reserved, false); assert.equal(f.messages.some(m => m.method === 'thread-follower-start-turn'), false);
  }
});

test('permission sends preserve native model mode privately and permission-only reasoning survives a null summary', async () => {
  const inherited = { mode: 'plan', settings: { model: 'previous', reasoning_effort: 'high', developer_instructions: 'private mode instructions' } };
  const stateProperties = { latestCollaborationMode: inherited, latestReasoningEffort: null, latestThreadSettings: { model: 'previous', effort: 'high', collaborationMode: inherited } };
  const f = fixture({ current: null, stateProperties });
  const snapshot = await f.control.context(ID);
  assert.equal(JSON.stringify(snapshot).includes('private mode instructions'), false);
  await f.control.send(ID, 'permissions only', { permissionMode: 'full-access' });
  const retained = f.messages.at(-1).params.turnStart.request;
  assert.equal(retained.model, 'previous'); assert.equal(retained.effort, 'high'); assert.equal(retained.collaborationMode, undefined);
  assert.equal(f.messages.at(-1).params.turnStart.context.inheritThreadSettings, true);
  await f.control.send(ID, 'selected model', { permissionMode: 'request-approval', model: 'chosen', thinking: 'medium' });
  assert.deepEqual(f.messages.at(-1).params.turnStart.request.collaborationMode, { mode: 'plan', settings: { model: 'chosen', reasoning_effort: 'medium', developer_instructions: 'private mode instructions' } });
  await f.control.send(ID, 'model default', { permissionMode: 'full-access', model: 'chosen' });
  assert.equal(f.messages.at(-1).params.turnStart.request.collaborationMode.settings.reasoning_effort, null);
  assert.equal(f.messages.at(-1).params.turnStart.request.effort, undefined);
});

test('permission unknown delivery remains one attempted native dispatch after reservation', async () => {
  for (const mutation of ['error', 'disconnect']) {
    const f = fixture({ current: null, mutation }); let reservations = 0;
    await assert.rejects(f.control.send(ID, 'message', { permissionMode: 'request-approval' }, { beforeDispatch: () => { reservations++; } }), { code: 'DELIVERY_UNKNOWN' });
    assert.equal(reservations, 1); assert.equal(f.messages.filter(m => m.method === 'thread-follower-start-turn').length, 1);
  }
});

test('permission final snapshot catches desktop activation and changed roots after reservation without dispatch', async () => {
  for (const change of ['active', 'roots']) {
    let reserved = false;
    const stateProperties = {};
    const f = fixture({ current: () => reserved && change === 'active' ? 'desktop-turn' : null, stateProperties });
    await assert.rejects(f.control.send(ID, 'message', { permissionMode: 'full-access' }, { beforeDispatch: () => {
      reserved = true;
      if (change === 'roots') stateProperties.currentPermissions = { runtimeWorkspaceRoots: ['relative-root'] };
    } }), error => error.code === (change === 'active' ? 'PERMISSION_CHANGE_ACTIVE' : 'PERMISSION_UNAVAILABLE') && error.controlNotDispatched === true);
    assert.equal(f.messages.filter(message => message.method === 'thread-owner-discovery').length, 2);
    assert.equal(f.messages.some(message => message.method === 'thread-follower-start-turn'), false);
    assert.equal(f.sockets.every(socket => socket.destroyed), true);
  }
});

test('permission dispatch uses the final verified owner roots and inherited settings after reservation', async () => {
  let owner = OWNER;
  const stateProperties = { latestCollaborationMode: { mode: 'default', settings: { model: 'before', reasoning_effort: 'low' } } };
  const f = fixture({ current: null, owner: () => owner, stateProperties });
  await f.control.send(ID, 'message', { permissionMode: 'request-approval' }, { beforeDispatch: () => {
    owner = '33333333-3333-3333-3333-333333333333';
    stateProperties.cwd = 'E:/new-workspace';
    stateProperties.currentPermissions = { runtimeWorkspaceRoots: ['E:/new-workspace'] };
    stateProperties.latestCollaborationMode = { mode: 'plan', settings: { model: 'after', reasoning_effort: 'high', developer_instructions: 'private updated mode' } };
  } });
  const dispatch = f.messages.at(-1), request = dispatch.params.turnStart.request;
  assert.equal(dispatch.targetClientId, owner);
  assert.deepEqual(request.runtimeWorkspaceRoots, ['E:/new-workspace']);
  assert.equal(request.model, 'after'); assert.equal(request.effort, 'high'); assert.equal(request.collaborationMode, undefined);
});

test('readonly context accepts delegated snapshots while control keeps refusing them', async () => {
  const f = fixture({ current: null, stateProperties: { parentThreadId: OWNER } });
  const readonly = await f.control.context(ID);
  assert.equal(readonly.threadContext.delegated, true); assert.equal(readonly.threadContext.permissions.supported, false);
  await assert.rejects(f.control.snapshot(ID), { code: 'UNSUPPORTED_THREAD' });
});

test('nonlatest async questions move to audit history without moving native unresolved requests', async () => {
  const native = { id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: ID, turnId: 'old', command: 'echo pending', cwd: 'E:/workspace' } };
  const snapshot = summarizeSnapshot({ id: ID, cwd: 'E:/workspace', requests: [native], turns: [
    { turnId: 'old', turnStartedAtMs: 1, items: [{ type: 'agentMessage', id: 'question', questions: [{ title: 'Old decision?', options: ['A'] }] }] },
    { turnId: 'current', turnStartedAtMs: 2, status: 'inProgress', items: [] },
  ] }, ID, OWNER, 1);
  assert.deepEqual(snapshot.pendingRequests.map(request => request.requestId), [3]);
  assert.equal(snapshot.pendingRequests[0].actionable, true);
  assert.equal(snapshot.historicalQuestions[0].reasonCode, 'NOT_LATEST_TURN');
  assert.equal(snapshot.historicalQuestions[0].actionable, false);
});
test('stop uses fresh snapshot and exact expected-turn owner-targeted native contract', async () => {
  const f = fixture(); const result = await f.control.stop(ID, 'turn-1');
  assert.equal(result.stopped, true); assert.equal(result.interruptedTurnId, 'turn-1');
  const command = f.messages.at(-1);
  assert.equal(command.method, 'thread-follower-interrupt-turn'); assert.equal(command.version, 4);
  assert.equal(command.targetClientId, OWNER); assert.equal(command.hostId, undefined);
  assert.deepEqual(command.params, { conversationId: ID, mode: 'user-stop', expectedTurnId: 'turn-1' });
});
test('a changed turn fails closed before any stop mutation', async () => {
  const f = fixture(); await assert.rejects(f.control.stop(ID, 'old-turn'), { code: 'TURN_CHANGED' });
  assert.ok(!f.messages.some(m => m.method === 'thread-follower-interrupt-turn'));
});
test('mutation disconnection and remote error are unknown delivery and never retried', async () => {
  for (const mutation of ['disconnect', 'error']) {
    const f = fixture({ mutation });
    await assert.rejects(f.control.stop(ID, 'turn-1'), { code: 'DELIVERY_UNKNOWN' });
    assert.equal(f.messages.filter(m => m.method === 'thread-follower-interrupt-turn').length, 1);
    assert.equal(f.sockets.length, 1);
  }
});
test('ambiguous turns, delegated tasks, and invalid IDs are rejected', async () => {
  assert.throws(() => summarizeSnapshot({ id: ID, requests: [], parentThreadId: OWNER }, ID, OWNER, 0), { code: 'UNSUPPORTED_THREAD' });
  assert.throws(() => summarizeSnapshot({ id: ID, requests: [], turns: [{ turnId: 'a', status: 'inProgress' }, { turnId: 'b', status: 'inProgress' }] }, ID, OWNER, 0), { code: 'PROTOCOL_ERROR' });
  const f = fixture(); assert.throws(() => f.control.snapshot('invalid'), { code: 'INVALID_REQUEST' });
  assert.equal(f.sockets.length, 0);
});
test('typed pending input answers retain native numeric request ID and reject stale requests', async () => {
  const requests = [{ id: 13, method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 'turn-1', questions: [{ id: 'q1', question: 'Choose', options: [] }] } }];
  const f = fixture({ requests });
  const token = (await f.control.snapshot(ID)).pendingRequests[0].token;
  await f.control.respondUserInput(ID, '13', { q1: { answers: ['value'] } }, token);
  assert.deepEqual(f.messages.at(-1).params, { conversationId: ID, requestId: 13, response: { answers: { q1: { answers: ['value'] } } } });
  assert.equal(f.messages.at(-1).version, 1);
  await assert.rejects(f.control.respondUserInput(ID, 13, { missing: { answers: ['x'] } }, token), { code: 'INVALID_REQUEST' });
  await assert.rejects(f.control.respondApproval(ID, 999, 'decline', token), { code: 'REQUEST_CHANGED' });
});
test('desktop update with owner not yet loaded reports temporary owner absence without guessing versions', async () => {
  const f = fixture({ ownerError: 'no-client-found' });
  await assert.rejects(f.control.snapshot(ID), error => {
    assert.equal(error.code, 'OWNER_UNAVAILABLE'); assert.equal(error.status, 503);
    assert.deepEqual(error.controlDiagnostic, { method: 'thread-owner-discovery', version: 1, reason: 'no-client-found' }); return true;
  });
  assert.equal(f.messages.length, 2); assert.ok(f.sockets.every(s => s.destroyed));
});
test('unknown request or snapshot versions fail closed and do not attempt mutation', async () => {
  for (const options of [{ ownerError: 'request-version-mismatch' }, { ownerError: 'no-handler-for-request' }, { snapshotVersion: 12 }]) {
    const f = fixture(options); await assert.rejects(f.control.stop(ID, 'turn-1'), { code: 'PROTOCOL_INCOMPATIBLE' });
    assert.ok(!f.messages.some(m => m.method === 'thread-follower-interrupt-turn'));
  }
});
test('arbitrary desktop error text is never retained in diagnostics', async () => {
  const f = fixture({ ownerError: 'private task text' });
  await assert.rejects(f.control.snapshot(ID), error => {
    assert.equal(error.controlDiagnostic.reason, 'unknown-desktop-error');
    assert.ok(!JSON.stringify(error).includes('private task text')); return true;
  });
});

test('response tokens reject changed request or owner but tolerate unrelated revisions', async () => {
  const requests = [{ id: 13, method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 'turn-1', questions: [{ id: 'q1', question: 'Choose', options: [] }] } }];
  let revision = 1, owner = OWNER, reservations = 0;
  const f = fixture({ requests, revision: () => revision, owner: () => owner });
  const body = { requestId: 13, token: (await f.control.snapshot(ID)).pendingRequests[0].token, answers: { q1: { answers: ['value'] } } };
  revision++;
  await f.control.respond(ID, body, { beforeDispatch: () => { reservations++; } });
  assert.equal(reservations, 1);
  requests[0].params.questions[0].question = 'Changed';
  await assert.rejects(f.control.respond(ID, body, { beforeDispatch: () => { reservations++; } }), { code: 'REQUEST_CHANGED' });
  requests[0].params.questions[0].question = 'Choose'; owner = CLIENT;
  await assert.rejects(f.control.respond(ID, body, { beforeDispatch: () => { reservations++; } }), { code: 'REQUEST_CHANGED' });
  assert.equal(reservations, 1);
  assert.equal(f.messages.filter(m => m.method === 'thread-follower-submit-user-input').length, 1);
});

test('native async replies use inherited start or steer contracts without permission overrides', async () => {
  for (const current of [null, 'turn-1']) {
    const f = fixture({ current, items: [{ id: 'message-1', type: 'agentMessage', questions: [{ title: 'Choose', options: ['A', 'B'] }] }] });
    const pending = (await f.control.snapshot(ID)).pendingRequests[0];
    await f.control.respond(ID, { requestId: pending.requestId, token: pending.token, answers: { [pending.questions[0].id]: { answers: ['A'] } } });
    const command = f.messages.at(-1);
    assert.equal(command.targetClientId, OWNER);
    assert.equal(command.method, current ? 'thread-follower-steer-turn' : 'thread-follower-start-turn');
    assert.equal(command.version, current ? 1 : 2);
    const input = current ? command.params.input : command.params.turnStart.request.input;
    assert.equal(input[0].text, '<send_user_message_question_reply>\n' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'message-1', 0]), question: 'Choose', answer: 'A' }]) + '\n</send_user_message_question_reply>');
    assert.deepEqual(input[0].text_elements, []);
    if (current) assert.deepEqual(command.params.restoreMessage, { id: command.params.clientUserMessageId, cwd: 'E:/workspace', context: {} });
    else {
      assert.deepEqual(command.params.turnStart.context, { inheritThreadSettings: true });
      assert.equal(command.params.turnStart.request.turnTrigger, 'send_user_message_async_question');
    }
    assert.ok(!JSON.stringify(command.params).match(/approvalPolicy|sandboxPolicy|permissionProfile/));
  }
});

test('response validation precedes reservation and unknown delivery never retries', async () => {
  const requests = [{ id: 13, method: 'item/tool/requestUserInput', params: { threadId: ID, turnId: 'turn-1', questions: [{ id: 'q1', question: 'Choose', options: [] }] } }];
  for (const mutation of ['disconnect', 'error']) {
    const f = fixture({ requests, mutation }); let reservations = 0;
    const token = (await f.control.snapshot(ID)).pendingRequests[0].token;
    await assert.rejects(f.control.respond(ID, { requestId: 13, token, answers: {} }, { beforeDispatch: () => { reservations++; } }), { code: 'INVALID_REQUEST' });
    assert.equal(reservations, 0);
    await assert.rejects(f.control.respond(ID, { requestId: 13, token, answers: { q1: { answers: ['value'] } } }, { beforeDispatch: () => { reservations++; } }), { code: 'DELIVERY_UNKNOWN' });
    assert.equal(reservations, 1);
    assert.equal(f.messages.filter(m => m.method === 'thread-follower-submit-user-input').length, 1);
  }
});
