import { createHash, createHmac } from 'node:crypto';
import { BridgeError } from './desktop.mjs';

const kinds = { 'item/commandExecution/requestApproval': 'commandApproval', 'item/fileChange/requestApproval': 'fileApproval', 'item/tool/requestUserInput': 'userInput' };
const text = (v, max = 20000) => typeof v === 'string' && v.length <= max ? v : null;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const validId = v => (typeof v === 'string' && v.length > 0 && v.length <= 256) || (typeof v === 'number' && Number.isSafeInteger(v));
const knownFields = (v, fields) => Object.keys(v).every(k => fields.includes(k));
const error = (message, code = 'INVALID_REQUEST', status = 400) => new BridgeError(message, code, status);
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function bind(value, raw, context, key) {
  const fingerprint = createHash('sha256').update(JSON.stringify(stable({ raw, threadId: context.threadId, ownerClientId: context.ownerClientId, latestTurnId: context.latestTurnId, evidence: context.evidence }))).digest('hex');
  const token = createHmac('sha256', key).update(fingerprint).digest('hex');
  const hex = createHash('sha256').update(`pending:${fingerprint}`).digest('hex');
  return { ...value, token, fingerprint, attemptId: `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}` };
}
function questions(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 3) return null;
  const result = [];
  for (const q of raw) {
    if (!object(q) || !knownFields(q, ['id', 'header', 'question', 'isOther', 'isSecret', 'options']) || !text(q.id, 256) || text(q.header ?? '', 1000) === null || !text(q.question)?.trim() || typeof q.isOther !== 'undefined' && typeof q.isOther !== 'boolean' || typeof q.isSecret !== 'undefined' && typeof q.isSecret !== 'boolean') return null;
    if (q.options != null && (!Array.isArray(q.options) || q.options.length > 30)) return null;
    const options = [];
    for (const o of q.options ?? []) {
      if (!object(o) || !knownFields(o, ['label', 'description']) || !text(o.label, 1000) || o.description != null && text(o.description) === null) return null;
      options.push({ label: o.label, description: o.description ?? '' });
    }
    if (new Set(options.map(o => o.label)).size !== options.length) return null;
    result.push({ id: q.id, header: q.header ?? '', question: q.question, options, isOther: q.isOther === true, isSecret: q.isSecret === true });
  }
  return new Set(result.map(q => q.id)).size === result.length ? result : null;
}

export function normalizePendingRequest(raw, context, key) {
  const p = object(raw.params) ? raw.params : {}, kind = kinds[raw.method] ?? 'unsupported';
  const value = { requestId: validId(raw.id) ? raw.id : 'invalid', kind, turnId: text(p.turnId, 256), title: { commandApproval: '命令审批', fileApproval: '文件变更审批', userInput: '等待回答' }[kind] ?? '暂不支持的请求', actionable: true, disabledReason: null };
  let incomplete = !validId(raw.id) || !value.turnId || p.threadId !== context.threadId || raw.completed === true;
  if (kind === 'commandApproval') {
    value.command = text(p.command); value.cwd = text(p.cwd ?? context.turn?.params?.cwd ?? context.cwd, 4096); value.reason = p.reason == null ? null : text(p.reason);
    incomplete ||= !value.command || !value.cwd || p.reason != null && value.reason === null;
    // These approvals describe additional policy scope; simple accept cannot stand in for it.
    incomplete ||= p.networkApprovalContext != null || p.proposedNetworkPolicyAmendments?.length > 0 || p.proposedExecpolicyAmendment?.length > 0;
    incomplete ||= !knownFields(p, ['threadId', 'turnId', 'itemId', 'command', 'cwd', 'reason', 'commandActions', 'approvalId', 'availableDecisions', 'networkApprovalContext', 'proposedNetworkPolicyAmendments', 'proposedExecpolicyAmendment']);
  } else if (kind === 'fileApproval') {
    value.reason = p.reason == null ? null : text(p.reason); value.files = []; value.cwd = text(p.cwd ?? context.turn?.params?.cwd ?? context.cwd, 4096);
    const changes = context.item?.type === 'fileChange' ? context.item.changes : null;
    incomplete ||= !Array.isArray(changes) || !changes.length || changes.length > 100 || p.grantRoot != null || p.reason != null && value.reason === null;
    incomplete ||= !value.cwd || !knownFields(p, ['threadId', 'turnId', 'itemId', 'reason', 'grantRoot', 'cwd', 'availableDecisions']);
    if (Array.isArray(changes) && changes.length <= 100) for (const change of changes) {
      const path = text(change?.path, 4096), type = change?.kind?.type, diff = text(change?.diff, 60000), movePath = change?.kind?.move_path ?? null;
      if (!path || !['add', 'update', 'delete'].includes(type) || diff === null || movePath != null && text(movePath, 4096) === null) incomplete = true;
      value.files.push({ path, type: ['add', 'update', 'delete'].includes(type) ? type : 'unknown', diff, ...(movePath ? { movePath } : {}) });
    }
    if (value.files.reduce((n, f) => n + (f.diff?.length ?? 0), 0) > 120000) { value.files = []; incomplete = true; }
  } else if (kind === 'userInput') {
    value.questions = questions(p.questions) ?? []; incomplete ||= !value.questions.length;
    value.questionIds = value.questions.map(q => q.id);
  } else incomplete = true;
  if (['commandApproval', 'fileApproval'].includes(kind) && p.availableDecisions != null && (!Array.isArray(p.availableDecisions) || !p.availableDecisions.includes('accept') || !p.availableDecisions.includes('decline'))) incomplete = true;
  if (incomplete) { value.actionable = false; value.disabledReason = '请求类型或完整上下文无法安全确认'; }
  return bind(value, raw, { ...context, evidence: { item: context.item ?? null, cwd: value.cwd ?? null } }, key);
}

const REPLY_START = '<send_user_message_question_reply>', REPLY_END = '</send_user_message_question_reply>';
function replyIds(input) {
  if (!Array.isArray(input) || input.length !== 1 || input[0]?.type !== 'text') return [];
  const content = input[0].text?.trim();
  if (!content?.startsWith(REPLY_START) || !content.endsWith(REPLY_END)) return [];
  try {
    const parsed = JSON.parse(content.slice(REPLY_START.length, -REPLY_END.length));
    const values = Array.isArray(parsed) ? parsed : [parsed];
    return values.every(reply => typeof reply?.questionItemId === 'string' && typeof reply.question === 'string' && typeof reply.answer === 'string') ? values.map(reply => reply.questionItemId) : [];
  } catch { return []; }
}
function acceptedReplyIds(item) {
  return item.type === 'userMessage' ? replyIds(item.content) : item.type === 'steeringUserMessage' && item.status === 'accepted' ? replyIds(item.input) : [];
}
function replies(entities) {
  const answered = new Set();
  for (const turn of entities) {
    const inputs = [turn.params?.input, ...(turn.items ?? []).filter(i => i.type === 'userMessage' || i.type === 'steeringUserMessage' && i.status === 'accepted').map(i => i.type === 'userMessage' ? i.content : i.input)];
    for (const input of inputs) {
      for (const id of replyIds(input)) answered.add(id);
    }
  }
  return answered;
}
function continuedQuestionGroup(items, sourceIndex, questionIds) {
  const source = items[sourceIndex];
  if (typeof source.id !== 'string' || items.filter(item => item.id === source.id).length !== 1) return false;
  let partialReplySeen = false;
  for (let index = sourceIndex + 1; index < items.length; index++) {
    if (acceptedReplyIds(items[index]).some(id => questionIds.includes(id))) partialReplySeen = true;
    const later = items[index];
    if (!partialReplySeen || later.type !== 'agentMessage' || !Array.isArray(later.questions) || !later.questions.length || typeof later.id !== 'string' || items.filter(item => item.id === later.id).length !== 1) continue;
    if (!later.questions.every(q => object(q) && knownFields(q, ['title', 'options']) && text(q.title)?.trim() && (q.options == null || Array.isArray(q.options) && q.options.every(o => typeof o === 'string')))) continue;
    const laterIds = later.questions.map((_, q) => JSON.stringify(['request_user_input_async', later.id, q]));
    // A continued exchange is historical, not an invented answer to its skipped sibling.
    if (items.slice(index + 1).some(item => acceptedReplyIds(item).some(id => laterIds.includes(id)))) return true;
  }
  return false;
}
export function normalizeAsyncQuestions(entities, context, key) {
  const latest = context.latestTurn, answered = replies(entities), result = [];
  if (!latest?.turnId) return result;
  for (const sourceTurn of entities) for (const [sourceIndex, item] of (sourceTurn.items ?? []).entries()) {
    if (item.type !== 'agentMessage' || !Array.isArray(item.questions) || !item.questions.length) continue;
    const rawQuestions = item.questions.map((q, index) => ({ id: JSON.stringify(['request_user_input_async', item.id, index]), header: '', question: q.title, options: (q.options ?? []).map(label => ({ label, description: '' })), isOther: true, isSecret: false }));
    const unresolved = rawQuestions.filter(q => !answered.has(q.id));
    if (!unresolved.length) continue;
    const knownSchema = item.questions.every(q => object(q) && knownFields(q, ['title', 'options']) && (q.options == null || Array.isArray(q.options) && q.options.every(o => typeof o === 'string')));
    const normalized = knownSchema ? questions(unresolved) : null, isLatest = sourceTurn.turnId === latest.turnId;
    // Older unresolved questions remain visible; a later turn is not proof of an answer.
    const historical = !!normalized && unresolved.length < rawQuestions.length && continuedQuestionGroup(sourceTurn.items, sourceIndex, rawQuestions.map(q => q.id));
    const value = { requestId: `async:${item.id}`, kind: 'asyncUserInput', turnId: sourceTurn.turnId, title: historical ? '旧提问（未逐项作答）' : '等待回答', questions: normalized ?? [], actionable: !historical && !!normalized && validId(`async:${item.id}`) && isLatest, disabledReason: historical ? '此后已继续新的问答，保留为旧提问' : !isLatest ? '问题不在最新轮次，暂不能从网页回答' : normalized ? null : '异步问题格式不受支持', ...(historical ? { historical: true } : {}) };
    result.push(bind(value, { sourceItemId: item.id, questions: item.questions }, { ...context, evidence: null }, key));
  }
  return result;
}
export function validateResponse(pending, body) {
  if (!object(body) || Object.keys(body).some(k => !['requestId', 'token', 'decision', 'answers'].includes(k))) throw error('回复字段无效');
  if (!pending.actionable) throw error(pending.disabledReason ?? '请求不可回复', 'REQUEST_READ_ONLY', 409);
  if (['commandApproval', 'fileApproval'].includes(pending.kind)) {
    if (!['accept', 'decline'].includes(body.decision) || body.answers !== undefined) throw error('仅支持此次允许或拒绝');
    return { decision: body.decision };
  }
  if (!['userInput', 'asyncUserInput'].includes(pending.kind) || body.decision !== undefined || !object(body.answers)) throw error('回答格式无效');
  const keys = Object.keys(body.answers);
  if (keys.length !== pending.questions.length || keys.some(k => !pending.questions.some(q => q.id === k))) throw error('回答与当前问题不匹配');
  const answers = Object.create(null);
  for (const q of pending.questions) {
    const answer = body.answers[q.id];
    if (!object(answer) || Object.keys(answer).length !== 1 || !Array.isArray(answer.answers) || answer.answers.length !== 1 || !text(answer.answers[0])?.trim()) throw error('每个问题需要一个有效回答');
    const value = answer.answers[0];
    if (q.options.length && !q.isOther && !q.options.some(o => o.label === value)) throw error('回答不在当前选项内');
    answers[q.id] = { answers: [value] };
  }
  return { answers };
}
export function asyncReply(pending, answers) {
  const values = pending.questions.map(q => ({ questionItemId: q.id, question: q.question, answer: answers[q.id].answers[0] }));
  return `${REPLY_START}\n${JSON.stringify(values)}\n${REPLY_END}`;
}
export function publicPendingRequest(pending) {
  const fields = ['requestId', 'kind', 'turnId', 'token', 'title', 'actionable', 'disabledReason', 'command', 'cwd', 'reason', 'files', 'questions'];
  return Object.fromEntries(fields.filter(k => Object.hasOwn(pending, k)).map(k => [k, pending[k]]));
}
