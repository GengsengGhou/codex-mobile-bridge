import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { DesktopControl, controlFrame, summarizeSnapshot } from '../src/desktop-control.mjs';

const ID = '00000000-0000-7000-8000-000000000001';
const OWNER = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
function fixture({ current = 'turn-1', mutation = 'success', canonical = false, requests = [], ownerError, snapshotVersion = 11, items = [], owner = OWNER, revision = 8 } = {}) {
  const messages = [], sockets = [];
  const connect = () => {
    const socket = new EventEmitter(); socket.destroyed = false; sockets.push(socket);
    socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; queueMicrotask(() => socket.emit('close')); } };
    const deliver = message => queueMicrotask(() => { if (!socket.destroyed) socket.emit('data', controlFrame(message)); });
    socket.write = frame => {
      const message = JSON.parse(frame.subarray(4)); messages.push(message);
      const response = result => deliver({ type: 'response', requestId: message.requestId, method: message.method, resultType: 'success', handledByClientId: typeof owner === 'function' ? owner() : owner, result });
      if (message.method === 'initialize') response({ clientId: CLIENT });
      else if (message.method === 'thread-owner-discovery') {
        if (ownerError) deliver({ type: 'response', requestId: message.requestId, resultType: 'error', error: ownerError });
        else response({ supportsUntrustedAppInput: true });
      }
      else if (message.method === 'thread-stream-following-changed') {
        const turns = current ? [{ turnId: current, status: 'inProgress', items }] : [{ turnId: 'completed', status: 'completed', items }];
        const state = { id: ID, cwd: 'E:/workspace', turns: canonical ? [] : turns, requests, ...(canonical ? { turnHistory: { kind: 'canonical', history: { entitiesByKey: { key: turns[0] } } } } : {}) };
        deliver({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: typeof owner === 'function' ? owner() : owner, version: snapshotVersion, params: { conversationId: ID, hostId: 'local', change: { type: 'snapshot', revision: typeof revision === 'function' ? revision() : revision, conversationState: state } } });
      } else if (mutation === 'disconnect') queueMicrotask(() => socket.destroy());
      else if (mutation === 'error') deliver({ type: 'response', requestId: message.requestId, resultType: 'error', error: 'request-timeout' });
      else response(message.method === 'thread-follower-interrupt-turn' ? { ok: true, interruptedTurnId: current } : ['thread-follower-start-turn', 'thread-follower-steer-turn'].includes(message.method) ? { result: { turn: { id: 'new-turn' } } } : { ok: true });
      return true;
    };
    queueMicrotask(() => socket.emit('connect')); return socket;
  };
  return { control: new DesktopControl({ connect, timeoutMs: 100 }), messages, sockets };
}

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
