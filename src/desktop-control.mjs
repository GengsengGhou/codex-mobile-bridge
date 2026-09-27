import net from 'node:net';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { BridgeError } from './desktop.mjs';
import { normalizePendingRequest, normalizeAsyncQuestions, validateResponse, asyncReply } from './pending-requests.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIPE = '\\\\.\\pipe\\codex-ipc';
const MAX_FRAME = 8 * 1024 * 1024;
// Both inspected 26.924.1866 and 26.924.2738 builds use this contract.
// Their initialize response has no method-version negotiation payload.
export const CONTROL_PROTOCOL = Object.freeze({ initialize: 0, owner: 1, following: 1, snapshot: 11, interrupt: 4, response: 1, start: 2, steer: 1 });
const fail = (message, code = 'CONTROL_UNAVAILABLE', status = 503) => new BridgeError(message, code, status);
function rejectedRequest(pending, nativeError) {
  const reason = ['no-client-found', 'client-disconnected', 'server-closed', 'request-timeout', 'request-version-mismatch', 'no-handler-for-request'].includes(nativeError) ? nativeError : 'unknown-desktop-error';
  const incompatible = ['request-version-mismatch', 'no-handler-for-request'].includes(reason);
  const unavailable = ['no-client-found', 'client-disconnected', 'server-closed', 'request-timeout'].includes(reason);
  const error = pending.mutation
    ? fail('Control delivery unknown; inspect desktop before retrying', 'DELIVERY_UNKNOWN', 409)
    : incompatible ? fail('Desktop control protocol is incompatible with this bridge', 'PROTOCOL_INCOMPATIBLE', 502)
      : unavailable ? fail('Desktop conversation owner is not currently available', 'OWNER_UNAVAILABLE', 503)
        : fail('Desktop owner rejected control request', 'DESKTOP_REJECTED', 502);
  // Safe diagnostics only: never retain arbitrary native error text or task data.
  error.controlDiagnostic = { method: pending.method, version: pending.version, reason };
  return error;
}
function threadId(value) {
  if (!UUID.test(value ?? '')) throw fail('Invalid local conversation ID', 'INVALID_REQUEST', 400);
  return value;
}
function requestId(value) {
  if ((typeof value !== 'string' || !value || value.length > 256) && !(typeof value === 'number' && Number.isSafeInteger(value))) {
    throw fail('Invalid request ID', 'INVALID_REQUEST', 400);
  }
  return value;
}
export function controlFrame(message) {
  const payload = Buffer.from(JSON.stringify(message));
  if (payload.length > MAX_FRAME) throw fail('Control request too large', 'INVALID_REQUEST', 400);
  const frame = Buffer.alloc(payload.length + 4); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
  return frame;
}

// Installed 26.924 desktop source: IpcClient/IpcRouter in src-Z8EKS_tU.js,
// method versions in src-B5IOaahd.js, native owner dispatch in main-DhsWCh3w.js.
// This connects an existing router only. Each operation closes its peer socket.
class ControlPeer {
  constructor({ pipePath, connect, timeoutMs, tokenKey }) {
    this.pipePath = pipePath; this.connectSocket = connect; this.timeoutMs = timeoutMs;
    this.tokenKey = tokenKey;
    this.clientId = 'initializing-client'; this.pending = new Map(); this.buffer = Buffer.alloc(0);
  }
  async open() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(fail('Desktop control connection timed out')); }, this.timeoutMs);
      try { this.socket = this.connectSocket(this.pipePath); } catch { clearTimeout(timer); reject(fail('Desktop control connection unavailable')); return; }
      this.socket.on('data', chunk => this.onData(chunk));
      this.socket.on('error', () => { clearTimeout(timer); reject(fail('Desktop control connection unavailable')); this.disconnect(); });
      this.socket.on('close', () => this.disconnect());
      this.socket.once('connect', () => { clearTimeout(timer); resolve(); });
    });
    const initialized = await this.request('initialize', { clientType: 'mobile-bridge' }, CONTROL_PROTOCOL.initialize);
    if (!UUID.test(initialized?.result?.clientId ?? '')) throw fail('Desktop control handshake incompatible', 'PROTOCOL_ERROR', 502);
    this.clientId = initialized.result.clientId;
  }
  write(message) { this.socket.write(controlFrame(message)); }
  request(method, params, version, { targetClientId, mutation = false } = {}) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(fail(mutation ? 'Control delivery unknown; inspect desktop before retrying' : 'Desktop control request timed out', mutation ? 'DELIVERY_UNKNOWN' : 'CONTROL_UNAVAILABLE', mutation ? 409 : 503));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, mutation, method, version });
      try { this.write({ type: 'request', requestId: id, sourceClientId: this.clientId, version, method, params, targetClientId, timeoutMs: this.timeoutMs }); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(fail('Desktop control request failed', mutation ? 'DELIVERY_UNKNOWN' : 'CONTROL_UNAVAILABLE', mutation ? 409 : 503)); }
    });
  }
  onData(chunk) {
    try {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > MAX_FRAME) throw new Error('frame');
        if (this.buffer.length < size + 4) return;
        const message = JSON.parse(this.buffer.subarray(4, size + 4)); this.buffer = this.buffer.subarray(size + 4);
        if (message.type === 'client-discovery-request') {
          this.write({ type: 'client-discovery-response', requestId: message.requestId, response: { canHandle: false } });
        } else if (message.type === 'response') {
          const pending = this.pending.get(message.requestId); if (!pending) continue;
          this.pending.delete(message.requestId); clearTimeout(pending.timer);
          if (message.resultType !== 'success') pending.reject(rejectedRequest(pending, message.error));
          else if (message.method !== pending.method) pending.reject(fail('Desktop control response incompatible', pending.mutation ? 'DELIVERY_UNKNOWN' : 'PROTOCOL_ERROR', pending.mutation ? 409 : 502));
          else pending.resolve(message);
        } else if (message.type === 'broadcast') this.onBroadcast?.(message);
      }
    } catch { this.disconnect(); this.close(); }
  }
  disconnect() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer); p.reject(fail(p.mutation ? 'Control delivery unknown; inspect desktop before retrying' : 'Desktop control disconnected', p.mutation ? 'DELIVERY_UNKNOWN' : 'CONTROL_UNAVAILABLE', p.mutation ? 409 : 503));
    }
    this.pending.clear(); this.onDisconnect?.();
  }
  close() { this.socket?.destroy(); }
  async owner(id) {
    const result = await this.request('thread-owner-discovery', { hostId: 'local', conversationId: id }, CONTROL_PROTOCOL.owner);
    if (!UUID.test(result.handledByClientId ?? '')) throw fail('Desktop owner unavailable');
    return result.handledByClientId;
  }
  async snapshot(id) {
    const ownerClientId = await this.owner(id);
    return new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer); this.onBroadcast = null; this.onDisconnect = null;
        error ? reject(error) : resolve(value);
      };
      const timer = setTimeout(() => finish(fail('Desktop snapshot timed out')), this.timeoutMs);
      this.onDisconnect = () => finish(fail('Desktop snapshot disconnected'));
      this.onBroadcast = message => {
        const p = message.params;
        if (message.method !== 'thread-stream-state-changed' || message.sourceClientId !== ownerClientId || p?.conversationId !== id || p.hostId !== 'local') return;
        if (message.version !== CONTROL_PROTOCOL.snapshot) {
          finish(fail('Desktop snapshot protocol is incompatible with this bridge', 'PROTOCOL_INCOMPATIBLE', 502)); return;
        }
        if (p.change?.type !== 'snapshot') return;
        if (!Number.isSafeInteger(p.change.revision)) { finish(fail('Desktop snapshot incompatible', 'PROTOCOL_ERROR', 502)); return; }
        try { finish(null, summarizeSnapshot(p.change.conversationState, id, ownerClientId, p.change.revision, this.tokenKey)); }
        catch (error) { finish(error); }
      };
      try {
        this.write({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId: this.clientId, targetClientIds: [ownerClientId], params: { hostId: 'local', conversationId: id, following: true }, version: CONTROL_PROTOCOL.following });
      } catch { finish(fail('Desktop snapshot request failed')); }
    });
  }
}

export function summarizeSnapshot(state, id, ownerClientId, revision, tokenKey = 'snapshot-test-key') {
  if (state?.id !== id || !Array.isArray(state.requests)) throw fail('Desktop snapshot incompatible', 'PROTOCOL_ERROR', 502);
  if (state.requests.length > 100 || new Set(state.requests.map(r => String(r.id))).size !== state.requests.length) throw fail('Desktop pending requests incompatible', 'PROTOCOL_ERROR', 502);
  const source = state.source;
  if (state.parentThreadId || state.agentNickname || (source && typeof source === 'object' && ('subAgent' in source || 'subagent' in source))) {
    throw fail('Only ordinary local conversations support control', 'UNSUPPORTED_THREAD', 409);
  }
  const entities = state.turnHistory?.kind === 'canonical' ? Object.values(state.turnHistory.history?.entitiesByKey ?? {}) : state.turns ?? [];
  const active = [...new Map(entities.filter(t => t?.status === 'inProgress' && typeof t.turnId === 'string').map(t => [t.turnId, t])).values()];
  if (active.length > 1) throw fail('Desktop current turn is ambiguous', 'PROTOCOL_ERROR', 502);
  const ordered = entities.filter(t => t?.turnId).sort((a,b) => (a.turnStartedAtMs ?? 0) - (b.turnStartedAtMs ?? 0));
  const latestTurn = active[0] ?? ordered.at(-1), latestTurnId = latestTurn?.turnId ?? null;
  const context = { threadId: id, ownerClientId, latestTurnId, latestTurn, cwd: state.cwd };
  const pendingRequests = state.requests.filter(r => r.completed !== true).map(r => {
    const turn = entities.find(t => t.turnId === r.params?.turnId);
    const item = turn?.items?.find(i => i.id === r.params?.itemId && i.type === 'fileChange');
    return normalizePendingRequest(r, { ...context, turn, item }, tokenKey);
  });
  const asyncQuestions = normalizeAsyncQuestions(entities, context, tokenKey);
  pendingRequests.push(...asyncQuestions.filter(request => !request.historical));
  const historicalQuestions = asyncQuestions.filter(request => request.historical);
  return { threadId: id, ownerClientId, revision, currentTurnId: active[0]?.turnId ?? null, latestTurnId, status: active.length ? 'inProgress' : 'idle', pendingRequests, historicalQuestions, cwd: state.cwd ?? null };
}

export class DesktopControl {
  constructor({ pipePath = PIPE, connect = path => net.createConnection(path), timeoutMs = 12000 } = {}) {
    this.options = { pipePath, connect, timeoutMs, tokenKey: randomBytes(32) };
  }
  async withPeer(operation) {
    const peer = new ControlPeer(this.options);
    try { await peer.open(); return await operation(peer); } finally { peer.close(); }
  }
  snapshot(id) { threadId(id); return this.withPeer(peer => peer.snapshot(id)); }
  async stop(id, expectedTurnId) {
    threadId(id);
    if (typeof expectedTurnId !== 'string' || !expectedTurnId || expectedTurnId.length > 256) throw fail('An expected turn ID is required', 'INVALID_REQUEST', 400);
    return this.withPeer(async peer => {
      const fresh = await peer.snapshot(id);
      if (fresh.currentTurnId !== expectedTurnId) throw fail('The current turn changed; refresh before stopping', 'TURN_CHANGED', 409);
      const response = await peer.request('thread-follower-interrupt-turn', { conversationId: id, mode: 'user-stop', expectedTurnId }, CONTROL_PROTOCOL.interrupt, { targetClientId: fresh.ownerClientId, mutation: true });
      if (response.handledByClientId !== fresh.ownerClientId || response.result?.ok !== true || (response.result.interruptedTurnId !== null && response.result.interruptedTurnId !== expectedTurnId)) throw fail('Desktop stop result unknown', 'DELIVERY_UNKNOWN', 409);
      return { threadId: id, interruptedTurnId: response.result.interruptedTurnId, stopped: response.result.interruptedTurnId === expectedTurnId, goalPauseError: Boolean(response.result.goalPauseError) };
    });
  }
  respondApproval(id, pendingId, decision, token, options) { return this.respond(id, { requestId: pendingId, decision, token }, options); }
  respondUserInput(id, pendingId, answers, token, options) { return this.respond(id, { requestId: pendingId, answers, token }, options); }
  async respond(id, body, { beforeDispatch = async () => {} } = {}) {
    threadId(id); requestId(body?.requestId);
    if (!/^[a-f0-9]{64}$/.test(body.token ?? '')) throw fail('缺少当前请求校验凭据，请刷新', 'INVALID_REQUEST', 400);
    return this.withPeer(async peer => {
      const fresh = await peer.snapshot(id), pending = fresh.pendingRequests.find(r => String(r.requestId) === String(body.requestId));
      if (!pending || !timingSafeEqual(Buffer.from(pending.token), Buffer.from(body.token))) throw fail('待回复请求或上下文已变化，请刷新', 'REQUEST_CHANGED', 409);
      const validated = validateResponse(pending, body);
      let method, params, version = CONTROL_PROTOCOL.response;
      if (pending.kind === 'asyncUserInput') {
        const input = [{ type: 'text', text: asyncReply(pending, validated.answers), text_elements: [] }], clientUserMessageId = randomUUID();
        if (fresh.currentTurnId) {
          method = 'thread-follower-steer-turn'; version = CONTROL_PROTOCOL.steer;
          params = { conversationId: id, input, clientUserMessageId, restoreMessage: { id: clientUserMessageId, cwd: fresh.cwd, context: {} } };
        } else {
          method = 'thread-follower-start-turn'; version = CONTROL_PROTOCOL.start;
          params = { conversationId: id, turnStart: { request: { threadId: id, input, clientUserMessageId, turnTrigger: 'send_user_message_async_question' }, context: { inheritThreadSettings: true } } };
        }
      } else {
        method = pending.kind === 'commandApproval' ? 'thread-follower-command-approval-decision' : pending.kind === 'fileApproval' ? 'thread-follower-file-approval-decision' : 'thread-follower-submit-user-input';
        params = { conversationId: id, requestId: pending.requestId, ...(validated.decision ? { decision: validated.decision } : { response: validated }) };
      }
      await beforeDispatch(pending);
      const response = await peer.request(method, params, version, { targetClientId: fresh.ownerClientId, mutation: true });
      if (response.handledByClientId !== fresh.ownerClientId || (pending.kind !== 'asyncUserInput' ? response.result?.ok !== true : response.result?.result == null)) throw fail('Desktop response result unknown', 'DELIVERY_UNKNOWN', 409);
      // Native handlers can acknowledge a raced-away request; this is delivery only.
      return { threadId: id, requestId: pending.requestId, delivered: true };
    });
  }
}
