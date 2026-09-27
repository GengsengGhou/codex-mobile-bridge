import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePendingRequest, normalizeAsyncQuestions, validateResponse, asyncReply, publicPendingRequest } from '../src/pending-requests.mjs';

const ID = '00000000-0000-0000-0000-000000000001';
const context = { threadId: ID, ownerClientId: 'owner', latestTurnId: 'turn-1', cwd: 'E:/work' };
const raw = (method, params = {}) => ({ id: 12, method, params: { threadId: ID, turnId: 'turn-1', ...params } });
const command = params => normalizePendingRequest(raw('item/commandExecution/requestApproval', { command: 'echo exact', ...params }), context, 'secret-key');
const input = params => normalizePendingRequest(raw('item/tool/requestUserInput', { questions: [{ id: 'q', header: '选择', question: 'Which?', isOther: false, isSecret: true, options: [{ label: 'A', description: 'First' }] }], ...params }), context, 'secret-key');

test('command approval retains exact command/cwd/reason with one-time decisions only', () => {
  const pending = command({ command: 'echo "first"\nexit 0', reason: 'Reason' });
  assert.equal(pending.actionable, true); assert.equal(pending.command, 'echo "first"\nexit 0'); assert.equal(pending.cwd, 'E:/work');
  assert.deepEqual(validateResponse(pending, { requestId: 12, token: pending.token, decision: 'accept' }), { decision: 'accept' });
  for (const decision of ['acceptForSession', 'acceptWithExecpolicyAmendment', { acceptWithExecpolicyAmendment: {} }]) assert.throws(() => validateResponse(pending, { decision }), { code: 'INVALID_REQUEST' });
});
test('incomplete, oversized or additional-scope approvals are readonly without truncating an approvable command', () => {
  for (const params of [{ command: undefined }, { command: 'x'.repeat(20001) }, { additionalPermissions: { network: true } }, { networkApprovalContext: {} }, { proposedExecpolicyAmendment: ['echo'] }, { availableDecisions: ['acceptForSession'] }]) {
    const pending = command(params); assert.equal(pending.actionable, false);
    assert.throws(() => validateResponse(pending, { decision: 'accept' }), { code: 'REQUEST_READ_ONLY' });
  }
  assert.equal(command({ command: 'x'.repeat(20001) }).command, null);
});
test('file approvals require complete native fileChange evidence and bind cwd, diffs and move paths', () => {
  const request = raw('item/fileChange/requestApproval', { itemId: 'file-1', reason: 'Change' });
  const item = { id: 'file-1', type: 'fileChange', changes: [{ path: 'old.txt', kind: { type: 'update', move_path: 'new.txt' }, diff: '@@\n-old\n+new' }] };
  const pending = normalizePendingRequest(request, { ...context, item }, 'key');
  assert.equal(pending.actionable, true); assert.equal(pending.cwd, 'E:/work');
  assert.deepEqual(pending.files, [{ path: 'old.txt', type: 'update', diff: '@@\n-old\n+new', movePath: 'new.txt' }]);
  assert.notEqual(pending.token, normalizePendingRequest(request, { ...context, cwd: 'E:/other', item }, 'key').token);
  assert.equal(normalizePendingRequest(request, context, 'key').actionable, false);
  assert.equal(normalizePendingRequest(raw('item/fileChange/requestApproval', { grantRoot: 'E:/' }), { ...context, item }, 'key').actionable, false);
  item.changes[0].diff = 'x'.repeat(60001);
  assert.equal(normalizePendingRequest(request, { ...context, item }, 'key').actionable, false);
});
test('standard question schema preserves options, descriptions, secret and freeform flags and validates answers', () => {
  const pending = input(); assert.equal(pending.actionable, true); assert.equal(pending.questions[0].isSecret, true);
  assert.equal(pending.questions[0].options[0].description, 'First');
  assert.deepEqual({ ...validateResponse(pending, { answers: { q: { answers: ['A'] } } }).answers }, { q: { answers: ['A'] } });
  for (const answers of [{ q: { answers: ['invalid'] } }, { q: { answers: ['A', 'A'] } }, {}, { q: { answers: ['A'], permissions: true } }, { q: { answers: ['A'] }, extra: { answers: ['A'] } }]) assert.throws(() => validateResponse(pending, { answers }), { code: 'INVALID_REQUEST' });
  const custom = input({ questions: [{ id: 'q', question: 'Free?', options: [{ label: 'A' }], isOther: true }] });
  assert.doesNotThrow(() => validateResponse(custom, { answers: { q: { answers: ['Custom'] } } }));
  assert.equal(input({ questions: [{ id: 'q', question: 'Unknown', isMultiSelect: true }] }).actionable, false);
});
test('token binds request contents, owner and latest turn but durable attempt identity survives HMAC key rotation', () => {
  const request = raw('item/commandExecution/requestApproval', { command: 'echo exact' });
  const a = normalizePendingRequest(request, context, 'key-a'), b = normalizePendingRequest(request, context, 'key-b');
  assert.notEqual(a.token, b.token); assert.equal(a.attemptId, b.attemptId); assert.equal(a.fingerprint, b.fingerprint);
  assert.notEqual(a.token, normalizePendingRequest(request, { ...context, ownerClientId: 'other' }, 'key-a').token);
  assert.notEqual(a.token, normalizePendingRequest(request, { ...context, latestTurnId: 'other' }, 'key-a').token);
  assert.notEqual(a.token, normalizePendingRequest(raw(request.method, { command: 'different' }), context, 'key-a').token);
  assert.equal(publicPendingRequest({ ...a, rawToolArgs: 'private' }).rawToolArgs, undefined);
  assert.equal(publicPendingRequest(a).fingerprint, undefined); assert.equal(publicPendingRequest(a).attemptId, undefined);
});
test('async questions come from agentMessage and exact native replies resolve them; older unresolved stays readonly', () => {
  const turn = { turnId: 'turn-1', status: 'completed', items: [{ type: 'agentMessage', id: 'message', questions: [{ title: 'Async?', options: ['A', 'B'] }] }] };
  const pending = normalizeAsyncQuestions([turn], { ...context, latestTurn: turn }, 'key')[0];
  assert.equal(pending.kind, 'asyncUserInput'); assert.equal(pending.actionable, true);
  assert.equal(pending.questions[0].id, JSON.stringify(['request_user_input_async', 'message', 0]));
  const body = { answers: { [pending.questions[0].id]: { answers: ['A'] } } };
  const reply = asyncReply(pending, validateResponse(pending, body).answers);
  const answered = { turnId: 'turn-2', params: { input: [{ type: 'text', text: reply }] }, items: [] };
  assert.equal(normalizeAsyncQuestions([turn, answered], { ...context, latestTurnId: 'turn-2', latestTurn: answered }, 'key').length, 0);
  const unrelated = { ...answered, params: { input: [{ type: 'text', text: 'Unrelated new message' }] } };
  const old = normalizeAsyncQuestions([turn, unrelated], { ...context, latestTurnId: 'turn-2', latestTurn: unrelated }, 'key')[0];
  assert.equal(old.actionable, false); assert.equal(old.turnId, 'turn-1');
  const malformed = { ...answered, params: { input: [{ type: 'text', text: '<send_user_message_question_reply>\n[{"questionItemId":' + JSON.stringify(pending.questions[0].id) + '}]\n</send_user_message_question_reply>' }] } };
  assert.equal(normalizeAsyncQuestions([turn, malformed], { ...context, latestTurn: malformed }, 'key').length, 1);
});

test('only an ordered continued exchange makes partially answered siblings historical', () => {
  const group = (id, count) => ({ type: 'agentMessage', id, questions: Array.from({ length: count }, (_, index) => ({ title: `Question ${index}`, options: ['A'] })) });
  const reply = (id, index, status = 'accepted') => ({ type: 'steeringUserMessage', status, input: [{ type: 'text', text: `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', id, index]), question: `Question ${index}`, answer: 'A' }])}\n</send_user_message_question_reply>` }] });
  const original = group('original', 2), newer = group('newer', 1);
  const normalize = items => {
    const turn = { turnId: 'turn-1', status: 'completed', items };
    return normalizeAsyncQuestions([turn], { ...context, latestTurn: turn }, 'key');
  };
  const history = normalize([original, reply('original', 0), newer, reply('newer', 0)]);
  assert.equal(history.length, 1); assert.equal(history[0].historical, true); assert.equal(history[0].actionable, false);
  assert.equal(history[0].questions[0].id, JSON.stringify(['request_user_input_async', 'original', 1]));
  for (const items of [
    [original], // Latest idle unanswered questions still require an answer.
    [original, newer, reply('newer', 0)], // Entirely unanswered original group.
    [original, reply('original', 0), newer], // Newer group has no reply.
    [original, reply('original', 0), newer, reply('newer', 0, 'rejected')],
    [original, reply('original', 0), newer, reply('different-id', 0)],
    [original, reply('original', 0), reply('newer', 0), newer], // Reply predates creation.
    [original, newer, reply('original', 0), reply('newer', 0)], // No partial reply before continuation.
    [original, reply('original', 0), newer, newer, reply('newer', 0)], // Ambiguous duplicate source ID.
  ]) assert.equal(normalize(items).find(p => p.requestId === 'async:original').historical, undefined);
  assert.equal(normalize([original])[0].actionable, true);
  const laterTurn = { turnId: 'turn-2', items: [newer, reply('newer', 0)] };
  const older = normalizeAsyncQuestions([{ turnId: 'turn-1', items: [original] }, laterTurn], { ...context, latestTurn: laterTurn }, 'key');
  assert.equal(older[0].historical, undefined); assert.equal(older[0].actionable, false);
});
