import { createI18n } from "./i18n.js";
import { appendMarkdown as renderMarkdown } from "./markdown.js";
import { createFilesPanel } from "./files.js";
import { createUploads } from "./uploads.js";
import { createArchivesPanel } from "./archives.js";
import { createRecoveryPanel } from "./recovery.js";
import { buildTurnBlocks, formatWorkSummary, mergeReadThread, projectGroup } from "./presentation.js";
import { createApi, syncPollDelay } from "./connection.js";
import { createDeviceContext, deviceIdFromPath, loadDeviceContext } from "./connection.js";
import { createAccessPanel } from "./access.js";
import { createThreadSnapshotCache } from "./thread-cache.js";
import { threadGroupKey, mergeSidebarOrder, orderProjectKeys, orderThreadRows, moveOrderItem } from "./sidebar-order.js";
import { reconcileOptimisticMessages, transcriptAnchor, restoreTranscriptAnchor, mergeTranscriptTurns } from "./conversation-state.js";
import { createThreadContextPanel } from "./thread-context.js";
import { createAgentViewer } from "./agent-viewer.js";

(async () => {
  const i18n = createI18n({ window, document }), t = i18n.t;
  "use strict";

  let deviceScope;
  try {
    deviceScope = deviceIdFromPath(window.location.pathname)
      ? await loadDeviceContext({ window, fetchImpl: (...args) => fetch(...args) })
      : createDeviceContext({ pathname: window.location.pathname, window, fetchImpl: (...args) => fetch(...args) });
  } catch (error) {
    const notice = document.createElement("p"); i18n.text(notice, () => error.message);
    const back = document.createElement("a"); back.href = "/"; i18n.text(back, () => t("返回设备列表 / 登录"));
    document.body.replaceChildren(notice, back); return;
  }
  const sessionStorage = deviceScope.sessionStorage, localStorage = deviceScope.localStorage;
  const scopedFetch = (...args) => deviceScope.fetch(...args);

  const API_HEADERS = { "X-Bridge-Client": "mobile-v1" };
  const requestApi = createApi({ headers: API_HEADERS, fetchImpl: scopedFetch, onSnapshot: deviceScope.acceptSnapshot });
  const STATUS_POLL_MS = 15000;
  const LIST_POLL_MS = 15000;
  const DRAFT_PREFIX = "codex-mobile-draft:";
  const DRAFT_REVISION_PREFIX = "codex-mobile-draft-revision:";
  const UNKNOWN_PREFIX = "codex-mobile-unknown:";
  const PENDING_PREFIX = "codex-mobile-pending:";
  const CONTROL_FORM_PREFIX = "codex-mobile-control-form:";
  const CONTROL_RESPONSE_PREFIX = "codex-mobile-control-response:";
  const CONTROL_OPEN_PREFIX = "codex-mobile-control-open:";
  const CONTROL_SEEN_PREFIX = "codex-mobile-control-seen:";
  const HISTORY_DISMISSED_PREFIX = "codex-mobile-history-dismissed:";
  const NEW_THREAD_DRAFT_KEY = "codex-mobile-new-thread-draft";
  const NEW_THREAD_PENDING_KEY = "codex-mobile-new-thread-pending";
  const NEW_THREAD_RECEIPT_KEY = "codex-mobile-new-thread-receipt";
  const SELECTED_KEY = "codex-mobile-selected-thread";
  const AGENT_IDS_KEY = "codex-mobile-subagent-threads";
  const PINNED_KEY = "codex-mobile-pinned-threads";
  const PROJECT_OPEN_KEY = "codex-mobile-open-projects";
  const SAFE_REJECTION_CODES = new Set(["DEVICE_OFFLINE", "LOGIN_REQUIRED", "INVALID_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "METHOD_NOT_ALLOWED", "SEND_DISABLED", "SEND_BUSY", "LIMIT_REACHED", "CONFLICT", "UNSUPPORTED_THREAD", "DESKTOP_REJECTED", "DESKTOP_UNAVAILABLE", "DELIVERY_STORE_UNAVAILABLE", "MANAGEMENT_DISABLED", "MANAGEMENT_UNAVAILABLE", "CONTROL_DISABLED", "CONTROL_UNAVAILABLE", "TURN_CHANGED"]);
  const deliveryIsUnknown = error => !SAFE_REJECTION_CODES.has(error.code);
  SAFE_REJECTION_CODES.add("MODEL_UNAVAILABLE");
  SAFE_REJECTION_CODES.add("MODEL_CHANGE_ACTIVE");
  SAFE_REJECTION_CODES.add("PERMISSION_UNAVAILABLE");
  SAFE_REJECTION_CODES.add("PERMISSION_CHANGE_ACTIVE");
  const THREAD_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const $ = (id) => document.getElementById(id);
  const ui = {
    connection: $("connection"), connectionText: $("connectionText"), drawerDeviceRow: $("drawerDeviceRow"), drawerDeviceName: $("drawerDeviceName"), drawerDeviceState: $("drawerDeviceState"), drawerMore: $("drawerMoreDialog"), drawerMoreButton: $("drawerMoreButton"), drawerMoreClose: $("drawerMoreClose"), menuButton: $("menuButton"), drawer: $("taskDrawer"),
    scrim: $("drawerScrim"), closeDrawer: $("closeDrawer"), taskList: $("taskList"), taskCount: $("taskCount"),
    refreshTasks: $("refreshTasks"), refreshButton: $("refreshButton"), taskSearch: $("taskSearch"),
    title: $("threadTitle"), subtitle: $("threadSubtitle"), status: $("threadStatus"), details: $("threadDetails"),
    id: $("threadId"), project: $("threadProject"), cwd: $("threadCwd"),
    notice: $("notice"), olderButton: $("olderButton"), olderRow: $("olderRow"), historyState: $("historyState"), transcript: $("transcript"),
    historicalQuestions: $("historicalQuestions"), historicalQuestionsContent: $("historicalQuestionsContent"),
    welcome: $("welcomeState"), composer: $("composer"), input: $("promptInput"), send: $("sendButton"),
    composerHint: $("composerHint"), fontControl: $("fontControl"), fontSizeValue: $("fontSizeValue"),
    fontDialog: $("fontDialog"), fontRange: $("fontRange"), fontReadout: $("fontReadout"),
    fontDecrease: $("fontDecrease"), fontIncrease: $("fontIncrease"), sortToggle: $("sortToggle"),
    resetOrder: $("resetOrder"), orderState: $("orderState"), threadLoadState: $("threadLoadState"),
    threadLoadText: $("threadLoadText"), retryThread: $("retryThreadButton"), newMessages: $("newMessagesButton"),
    actionDialog: $("threadActionDialog"), actionForm: $("threadActionForm"), actionTitle: $("threadActionTitle"),
    actionHint: $("threadActionHint"), actionError: $("threadActionError"), actionCancel: $("threadActionCancel"),
    actionConfirm: $("threadActionConfirm"), nameInput: $("threadNameInput"), nameLabel: $("threadNameLabel"),
    stop: $("stopButton"), controlState: $("controlState"), controlSummary: $("controlSummary"),
    pendingRequests: $("pendingRequests"), refreshControl: $("refreshControl"), controlToggle: $("controlToggle"), closePending: $("closePendingRequests"),
    closeHistory: $("closeHistoricalQuestions"), showHistory: $("showHistoricalQuestions"),
    newThreadButton: $("newThreadButton"), createCapabilityState: $("createCapabilityState"),
    createDialog: $("newThreadDialog"), createForm: $("newThreadForm"), createProject: $("newThreadProject"),
    projectLoadState: $("projectLoadState"), projectLoadText: $("projectLoadText"), retryProjects: $("retryProjects"), projectDetail: $("projectSelectionDetail"),
    createName: $("newThreadName"), createPrompt: $("newThreadPrompt"), createRecoveryState: $("createRecoveryState"),
    createError: $("createError"), createSubmit: $("createSubmit"), createCancel: $("createCancel"), createClose: $("newThreadClose"),
    createRetry: $("createRetry"), checkCreateReceipt: $("checkCreateReceipt"), enterCreatedFromDialog: $("enterCreatedFromDialog"),
    creationResult: $("creationResult"), creationResultText: $("creationResultText"), enterCreatedThread: $("enterCreatedThread")
  };
  const modelUI = { button: $("modelSettingsButton"), label: $("modelSettingsLabel"), dialog: $("modelSettingsDialog"), model: $("messageModel"), thinking: $("messageThinking"), permission: $("messagePermission"), message: $("modelSettingsState"), createModel: $("createModel"), createThinking: $("createThinking") };
  const followupUI = { dialog: $("followupDraftDialog"), preview: $("followupDraftPreview"), cancel: $("followupDraftCancel"), append: $("followupDraftAppend") };
  const modelSettings = new Map();
  function readModelSettings(id) {
    if (!modelSettings.has(id)) {
      let value = {};
      try { value = JSON.parse(sessionStorage.getItem(`codex-mobile-model:${id}`) || "{}"); } catch { /* Keep the desktop default. */ }
      if (!value || typeof value !== "object" || Array.isArray(value)) value = {};
      modelSettings.set(id, { ...(typeof value.model === "string" && value.model ? { model: value.model } : {}), ...(typeof value.thinking === "string" && value.thinking ? { thinking: value.thinking } : {}) });
    }
    return modelSettings.get(id);
  }
  function modelChoices(mode) { return state.statusSnapshot?.modelOptions?.[mode] || []; }
  function populateModelControls(mode) {
    const id = mode === "create" ? "new" : state.selectedId;
    const selection = readModelSettings(id);
    const model = mode === "create" ? modelUI.createModel : modelUI.model;
    const thinking = mode === "create" ? modelUI.createThinking : modelUI.thinking;
    const models = modelChoices(mode);
    model.replaceChildren(i18n.option(() => mode === "create" ? t("沿用桌面默认") : t("沿用桌面设置"), ""), ...models.map(value => i18n.option(() => value.id, value.id)));
    if (selection.model && !models.some(value => value.id === selection.model)) model.append(i18n.option(() => t`${selection.model}（不可用）`, selection.model));
    model.value = selection.model || "";
    const efforts = models.find(value => value.id === selection.model)?.efforts || [];
    thinking.replaceChildren(i18n.option(() => t("沿用桌面设置"), ""), ...efforts.map(value => i18n.option(() => value, value)));
    if (selection.thinking && !efforts.includes(selection.thinking)) thinking.append(i18n.option(() => t`${selection.thinking}（不可用）`, selection.thinking));
    thinking.value = selection.thinking || "";
    thinking.disabled = !selection.model;
  }
  function saveModelControls(mode, changedModel = false) {
    const id = mode === "create" ? "new" : state.selectedId;
    const model = mode === "create" ? modelUI.createModel : modelUI.model;
    const thinking = mode === "create" ? modelUI.createThinking : modelUI.thinking;
    const value = model.value ? { model: model.value, ...(!changedModel && thinking.value ? { thinking: thinking.value } : {}) } : {};
    modelSettings.set(id, value);
    try { sessionStorage.setItem(`codex-mobile-model:${id}`, JSON.stringify(value)); }
    catch { showNotice(t("本页设置已更新，但浏览器无法保存模型设置。刷新后需重新选择。"), "error"); }
    populateModelControls(mode);
    if (mode === "create") saveCreateDraftFromForm();
    renderModelSettings();
  }
  function renderModelSettings() {
    const selection = readModelSettings(state.selectedId);
    modelUI.button.disabled = !state.selectedId || state.sending;
    i18n.text(modelUI.label, () => selection.model ? `${selection.model}${selection.thinking ? ` · ${selection.thinking}` : ""}` : t("沿用桌面"));
    modelUI.button.dataset.customized = String(!!(selection.model || selection.thinking || modelUI.permission.value));
    i18n.attr(modelUI.button, "title", () => t`下一轮设置：模型、推理强度与权限；${selection.model || t("沿用桌面设置")}${selection.thinking ? ` · ${selection.thinking}` : ""}`);
    i18n.attr(modelUI.button, "aria-label", () => modelUI.button.title);
    i18n.text(modelUI.message, () => state.sendMode === "follow-up" ? t("本轮补充沿用运行中的模型，所选设置用于下一轮。") : !modelChoices("send").length ? t("桌面暂未提供可用模型目录；沿用桌面设置仍可发送。") : "");
  }
  const state = {
    threads: [], selectedId: null, thread: null, turns: new Map(), cursor: null, hasMore: false, agentIds: readKnownAgentIds(), ordinaryIds: new Set(),
    connected: false, canSend: false, inFlight: 0, switching: 0, selecting: 0, loadingOlder: false,
    sending: false, listLoading: false, noticeTimer: null, pollTimer: null, polling: false, forcePoll: false, idlePolls: 0, changeRevision: 0, historyError: false, threadFingerprint: "",
    callerThreadId: null, pagingInitialized: false, drafts: new Map(), unknownSends: new Set(), statusSnapshot: null,
    pinnedOverrides: readPinnedOverrides(), expandedProjects: readExpandedProjects(), openDetails: new Map(), taskDetailsOpen: new Map(), taskListFingerprint: "",
    sendDisabledReason: "", sendMode: "message", pendingMessages: [], pendingByThread: new Map(), readController: null, selectionController: null,
    threadCache: createThreadSnapshotCache({ maxEntries: 20, maxTurns: 1000 }), cachedTurnIds: new Set(),
    lastStatusAt: 0, lastListAt: 0, sidebarOrder: { revision: 0, order: { projects: [], threads: {} } },
    orderLoaded: false, orderConfigured: false, orderSaving: false, orderDirty: false, sorting: false, dragging: null,
    receiptChecks: new Map(), receiptCheckAt: new Map(), draftRevisions: new Map(), threadAction: null, managing: false,
    execution: null, controlReads: new Set(), stopping: false, responding: new Set(), responseStates: new Map(), followupDraft: null, sessionExpired: false,
    pendingCards: new Map(), pendingDrafts: new Map(), controlUnavailable: false, controlRetry: false,
    controlOpen: false, controlSeen: new Set(), historyFingerprint: "", historyDismissed: "",
    projects: [], projectsLoaded: false, projectsLoading: false, projectsCanCreate: null, projectsError: "",
    createDraft: { projectChoice: "", title: "", prompt: "" }, createDraftRevision: 0, createDraftLoaded: false, createDraftStorageFailed: false,
    createAttempt: null, createReceipt: null, createRecoveryError: "", createErrorText: "", creatingThread: false, createSelection: null
  };
  const filesPanel = createFilesPanel({ document, window, fetchImpl: scopedFetch, getThread: () => ({ id: state.selectedId || "", cwd: state.thread?.cwd || state.threads.find(item => item.id === state.selectedId)?.cwd || "" }) });
  const agentViewer = createAgentViewer({ document, window, api: requestApi });
  const contextPanel = createThreadContextPanel({ document, window, api: requestApi, storage: sessionStorage, onViewAgent: item => { void agentViewer.open(item); }, onAgents: rememberAgents, onNotice: showNotice });
  const uploads = createUploads({ document, window, storage: sessionStorage, fetchImpl: scopedFetch, getThread: id => ({ id, cwd: (state.thread?.id === id ? state.thread.cwd : "") || state.threads.find(item => item.id === id)?.cwd || "" }), canUpload: () => maySendSelected() && state.connected && state.canSend, onChange: updateControls });
  createArchivesPanel({ document, window, api: requestApi, onRestored: () => refreshTasks() });
  createRecoveryPanel({ document, api: requestApi });
  createAccessPanel({ document, window, api: requestApi, fetchImpl: scopedFetch, deviceContext: deviceScope.context, onLoginRequired: () => { state.sessionExpired = true; clearFollowupDraft(); } });

  async function api(path, options = {}) {
    state.inFlight += 1;
    updateControls();
    try {
      return await requestApi(path, options);
    } finally {
      state.inFlight -= 1;
      updateControls();
      if (options.method && options.method.toUpperCase() !== "GET") wakeSync();
    }
  }

  function text(value, fallback = "") {
    return typeof value === "string" ? value : (value == null ? fallback : String(value));
  }

  function normalizeStatus(status) {
    const value = text(status, "unknown").toLowerCase().replace(/[ -]/g, "_");
    if (["running", "in_progress", "inprogress", "active", "working", "pending"].includes(value)) return { label: t("进行中"), kind: "running" };
    if (["completed", "complete", "done", "finished", "succeeded", "success"].includes(value)) return { label: t("已完成"), kind: "completed" };
    if (["failed", "error", "errored", "systemerror", "system_error"].includes(value)) return { label: t("系统错误"), kind: "error" };
    if (["interrupted", "cancelled", "canceled", "stopped"].includes(value)) return { label: t("已中断"), kind: "" };
    if (["idle", "not_loaded", "notloaded"].includes(value)) return { label: value === "idle" ? t("空闲") : t("等待继续"), kind: "" };
    if (value === "unknown" || !value) return { label: t("状态未知"), kind: "" };
    return { label: text(status), kind: "" };
  }

  function readPinnedOverrides() {
    try {
      const value = JSON.parse(localStorage.getItem(PINNED_KEY) || "{}");
      return new Map(Object.entries(value).filter(([, pinned]) => typeof pinned === "boolean"));
    } catch { return new Map(); }
  }

  function readKnownAgentIds() {
    try {
      const ids = JSON.parse(sessionStorage.getItem(AGENT_IDS_KEY) || "[]");
      return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === "string" && THREAD_UUID.test(id)).map(id => id.toLowerCase()) : []);
    } catch { return new Set(); }
  }

  function delegatedThread(thread) {
    return thread?.delegated === true || !!thread?.parentThreadId || !!thread?.agentNickname ||
      !!(thread?.source && typeof thread.source === "object" && ("subAgent" in thread.source || "subagent" in thread.source));
  }

  function knownAgent(id) { return typeof id === "string" && state.agentIds.has(id.toLowerCase()); }

  function rememberAgents(items) {
    let changed = false;
    for (const item of items || []) {
      const id = item?.threadId || item?.id;
      if (typeof id !== "string" || !THREAD_UUID.test(id)) continue;
      const normalized = id.toLowerCase();
      if (!state.agentIds.has(normalized)) { state.agentIds.add(normalized); changed = true; }
      state.ordinaryIds.delete(normalized);
      state.threadCache.delete(id);
    }
    if (!changed && !state.threads.some(thread => knownAgent(thread.id))) return;
    state.threads = state.threads.filter(thread => !knownAgent(thread.id));
    try { sessionStorage.setItem(AGENT_IDS_KEY, JSON.stringify([...state.agentIds])); } catch { /* In-memory filtering remains available. */ }
    state.taskListFingerprint = "";
    renderTasks();
  }

  function readExpandedProjects() {
    try {
      const value = JSON.parse(localStorage.getItem(PROJECT_OPEN_KEY) || "{}");
      return new Map(Object.entries(value).filter(([, open]) => typeof open === "boolean"));
    } catch { return new Map(); }
  }

  function isThreadPinned(thread) {
    return state.pinnedOverrides.has(thread.id) ? state.pinnedOverrides.get(thread.id) : !!thread.pinned;
  }

  function sidebarGroupKey(thread) {
    return threadGroupKey({ ...thread, pinned: isThreadPinned(thread) });
  }

  function hasCustomOrder(value) {
    const order = value?.order || value;
    return !!order?.projects?.length || Object.values(order?.threads || {}).some(ids => Array.isArray(ids) && ids.length > 0);
  }

  function maySendSelected() {
    const status = state.statusSnapshot;
    if (!status || status.canSend === false) return false;
    if (status.sendScope === "disabled") return false;
    if (status.sendScope === "all-local") return true;
    if (status.sendScope === "single") return status.allowedSendThreadId === state.selectedId;
    if (Object.prototype.hasOwnProperty.call(status, "allowedSendThreadId")) return status.allowedSendThreadId === state.selectedId;
    return !!status.canSend;
  }

  function renderDeviceIdentity(online = deviceScope.context?.device?.online === true) {
    if (!ui.drawerDeviceRow) return;
    ui.drawerDeviceRow.hidden = !deviceScope.id;
    if (!deviceScope.id) return;
    i18n.text(ui.drawerDeviceName, () => deviceScope.context.device.name);
    i18n.text(ui.drawerDeviceState, () => online ? t("在线") : t("离线"));
    ui.drawerDeviceRow.dataset.state = online ? "online" : "offline";
  }

  function setConnection(connected, status = null, error = null) {
    if (status) state.statusSnapshot = status;
    state.connectionError = connected ? null : error || status?.error || state.connectionError;
    const offline = deviceScope.id && deviceScope.context.device.online !== true;
    const snapshot = state.statusSnapshot;
    connected = connected && !offline && snapshot?.connected !== false;
    const fault = offline ? { code: "DEVICE_OFFLINE", message: t("设备连接中断") }
      : snapshot?.connected === false ? snapshot.error || { code: "DESKTOP_UNAVAILABLE", message: t("等待桌面 Codex 连接") }
        : state.connectionError;
    state.connectionFault = fault;
    if (status) { populateModelControls("create"); if (modelUI.dialog.open) populateModelControls("send"); }
    state.connected = connected;
    renderDeviceIdentity();
    if (connected && status?.canCreate === true && state.projectsCanCreate === false) {
      state.projectsCanCreate = null;
      state.projectsLoaded = false;
      void loadProjects();
    }
    ui.connection.dataset.state = connected ? "connected" : "disconnected";
    i18n.text(ui.connectionText, () => connected ? (deviceScope.id ? t("电脑已连接") : t("已连接")) : connectionLabel({ error: fault }));
    const limitations = Array.isArray(snapshot?.limitations) ? snapshot.limitations.filter((item) => typeof item === "string") : [];
    const issue = connectionIssue(fault);
    i18n.attr(ui.connection, "title", () => snapshot ? [t`连接模式：${text(snapshot.mode, t("未知"))}`, issue?.message, ...limitations].filter(Boolean).join("\n") : t("暂时无法读取本机 Codex"));
    updateControls();
  }

  function connectionIssue(error) {
    if (!error) return null;
    const code = text(error.code, "").toUpperCase();
    if (code === "DEVICE_OFFLINE") {
      return { label: t("设备离线"), notice: t("设备连接中断。页面会保留最近内容和草稿，并继续重试。"), message: text(error.message) };
    }
    if (/_BUSY$/.test(code)) {
      return { label: t("请求繁忙"), notice: t("连接请求暂时繁忙。页面会保留最近内容和草稿，并稍后重试。"), message: text(error.message) };
    }
    if (code === "RELAY_TIMEOUT" || code === "DEVICE_RECONNECTING") {
      return { label: code === "RELAY_TIMEOUT" ? t("响应超时") : t("设备重连中"), notice: t("暂时无法取得电脑响应。页面会保留最近内容和草稿，并继续重试。"), message: text(error.message) };
    }
    if (/INCOMPAT|PROTOCOL|UNSUPPORTED|TOOL.*CALL/.test(code)) {
      return { label: t("版本不兼容"), notice: t("桥接与当前 Codex 接口不兼容，需要更新桥接适配。已有内容和草稿仍保留。"), message: text(error.message) };
    }
    if (/DESKTOP|CODEX|UPSTREAM/.test(code)) {
      return { label: t("等待 Codex"), notice: t("桌面 Codex 暂时不可用。页面会保留最近内容并继续重试。"), message: text(error.message) };
    }
    return { label: t("桥接不可用"), notice: t("本机桥接服务暂时不可用。页面会保留最近内容并继续重试。"), message: text(error.message) };
  }

  function connectionLabel(status) {
    return connectionIssue(status?.error)?.label || t("桥接不可用");
  }

  function updateControls() {
    renderModelSettings();
    contextPanel.setState({ status: state.statusSnapshot, thread: state.thread, connected: state.connected, sending: state.sending, sendMode: state.sendMode });
    const unknownPending = !!state.selectedId && isUnknown(state.selectedId);
    const canWrite = maySendSelected() && state.connected && state.canSend && !!state.selectedId && !unknownPending && !state.selectionController;
    ui.input.disabled = !state.selectedId;
    uploads.setThread(state.selectedId);
    const attachmentStatus = uploads.status(state.selectedId);
    const hasInput = !!ui.input.value.trim() || attachmentStatus.count > 0 || attachmentStatus.blocked;
    ui.send.disabled = !canWrite || state.sending || state.stopping || attachmentStatus.blocked || !hasInput;
    ui.olderButton.disabled = !state.connected || state.loadingOlder;
    const execution = state.execution?.threadId === state.selectedId ? state.execution : null;
    const active = state.sendMode === "follow-up" || normalizeStatus(state.thread?.status).kind === "running" || !!(execution?.canStop && execution.turnId);
    const showStop = active && !hasInput;
    ui.stop.hidden = !showStop;
    ui.send.hidden = showStop;
    ui.stop.disabled = state.stopping || state.sending || !state.connected || unknownPending || !!state.selectionController || !execution?.canStop || !execution.turnId;
    const stopLabel = state.stopping ? t("正在停止当前轮次") : t("停止当前轮次");
    i18n.attr(ui.stop, "aria-label", () => t(stopLabel));
    i18n.attr(ui.stop, "title", () => showStop && !execution?.canStop ? execution?.reason || t("正在确认当前运行轮次") : t(stopLabel));
    const sendLabel = state.sending ? t("正在发送消息") : state.sendMode === "follow-up" ? t("补充到当前轮次") : t("发送消息");
    i18n.attr(ui.send, "aria-label", () => t(sendLabel));
    i18n.attr(ui.send, "title", () => attachmentStatus.blocked ? t("附件尚未就绪") : t(sendLabel));
    ui.send.setAttribute("aria-busy", String(state.sending));
    ui.stop.setAttribute("aria-busy", String(state.stopping));
    if (unknownPending) i18n.text(ui.composerHint, () => t("正在核对送达状态；不会自动重发"));
    else if (state.selectionController) i18n.text(ui.composerHint, () => t("正在读取所选会话，草稿已保留"));
    else if (!state.selectedId) i18n.text(ui.composerHint, () => t("选择任务后查看发送权限"));
    else if (!state.connected) i18n.text(ui.composerHint, () => t("连接中断，草稿会保留"));
    else if (!maySendSelected()) i18n.text(ui.composerHint, () => t("此会话暂不允许发送"));
    else if (!state.canSend) i18n.text(ui.composerHint, () => state.sendDisabledReason || t("此会话当前不允许发送"));
    else if (attachmentStatus.blocked) i18n.text(ui.composerHint, () => t("附件尚未就绪，草稿已保留"));
    else if (showStop && ui.stop.disabled && !state.sending && !state.stopping) i18n.text(ui.composerHint, () => execution?.reason || t("正在确认当前运行轮次"));
    else i18n.text(ui.composerHint, () => "");
    ui.composerHint.classList.toggle("sr-only", !ui.composerHint.textContent);
    updateCreateControls();
  }

  function mayCreateThread() {
    return state.connected && state.statusSnapshot?.canCreate === true && state.statusSnapshot?.sendScope === "all-local" && state.projectsCanCreate !== false;
  }

  function createCapabilityReason() {
    if (!state.connected) return t("新建会话需要连接到本机 Codex。");
    if (state.statusSnapshot?.sendScope !== "all-local") return t("新建会话仅在本机全部会话模式下开放。");
    if (state.statusSnapshot?.canCreate !== true || state.projectsCanCreate === false) return t("当前桥接配置未开放新建会话。");
    return "";
  }

  function updateCreateControls() {
    const canCreate = mayCreateThread();
    const hasRecovery = !!state.createAttempt || !!state.createReceipt || !!state.createRecoveryError;
    ui.newThreadButton.disabled = !canCreate && !hasRecovery;
    const reason = createCapabilityReason();
    ui.createCapabilityState.hidden = canCreate || hasRecovery;
    i18n.text(ui.createCapabilityState, () => t(reason));
    i18n.attr(ui.newThreadButton, "title", () => reason || t("新建本机会话"));
    if (ui.createDialog.open) renderCreateRecoveryState();
    renderCreationResult();
  }

  function readStoredJson(key) {
    try {
      const value = sessionStorage.getItem(key);
      return value ? JSON.parse(value) : null;
    } catch { return null; }
  }

  function restoreCreateState() {
    const draft = readStoredJson(NEW_THREAD_DRAFT_KEY);
    if (draft && typeof draft === "object" && !Array.isArray(draft)) {
      state.createDraft = {
        projectChoice: typeof draft.projectChoice === "string" ? draft.projectChoice : "",
        title: typeof draft.title === "string" ? draft.title : "",
        prompt: typeof draft.prompt === "string" ? draft.prompt : ""
      };
      state.createDraftRevision = Number.isSafeInteger(draft.revision) && draft.revision >= 0 ? draft.revision : 0;
      state.createDraftLoaded = true;
    }
    let pending = null, rawPending = null;
    try {
      rawPending = sessionStorage.getItem(NEW_THREAD_PENDING_KEY);
      pending = rawPending ? JSON.parse(rawPending) : null;
    } catch { rawPending = "invalid"; }
    if (pending && THREAD_UUID.test(pending.requestId || "") && pending.payload && typeof pending.payload.prompt === "string") {
      state.createAttempt = { requestId: pending.requestId, payload: pending.payload, draftRevision: Number.isSafeInteger(pending.draftRevision) ? pending.draftRevision : -1, state: "unknown" };
    } else if (rawPending) {
      state.createRecoveryError = t("创建恢复记录不完整。为避免重复创建，当前已锁定新建操作。");
      state.createAttempt = { requestId: "", payload: null, state: "unknown" };
    }
    const receipt = readStoredJson(NEW_THREAD_RECEIPT_KEY);
    if (receipt && receipt.created === true && THREAD_UUID.test(receipt.threadId || "")) state.createReceipt = receipt;
    state.createDraftLoaded = true;
  }

  function persistCreateDraft(draft = state.createDraft) {
    state.createDraft = { projectChoice: draft.projectChoice, title: draft.title, prompt: draft.prompt };
    try {
      sessionStorage.setItem(NEW_THREAD_DRAFT_KEY, JSON.stringify({ ...state.createDraft, revision: state.createDraftRevision }));
      state.createDraftStorageFailed = false;
      return true;
    } catch {
      state.createDraftStorageFailed = true;
      return false;
    }
  }

  function readCreateDraftFromForm() {
    return {
      projectChoice: ui.createProject.value,
      title: ui.createName.value,
      prompt: ui.createPrompt.value
    };
  }

  function saveCreateDraftFromForm() {
    state.createDraftRevision += 1;
    persistCreateDraft(readCreateDraftFromForm());
    updateCreateControls();
  }

  function projectPathKey(value) {
    return typeof value === "string" ? value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase() : "";
  }

  function matchedCurrentProject(projects) {
    const current = state.thread?.projectPath || state.thread?.cwd;
    const path = projectPathKey(current);
    if (!path) return "";
    const matches = projects.filter(project => projectPathKey(project.path) === path);
    return matches.length === 1 ? matches[0].projectId : "";
  }

  function renderProjectDetail() {
    const selected = ui.createProject.value;
    const project = state.projects.find(item => item.projectId === selected);
    if (project) {
      ui.projectDetail.hidden = false;
      i18n.text(ui.projectDetail, () => `${project.label} · ${project.path}`);
    } else if (selected && selected !== "__none__") {
      ui.projectDetail.hidden = false;
      i18n.text(ui.projectDetail, () => t("所选项目当前不可用，请重新选择或选无项目。"));
    } else ui.projectDetail.hidden = true;
  }

  function populateProjectSelect() {
    const choice = state.createDraft.projectChoice;
    ui.createProject.replaceChildren();
    const placeholder = document.createElement("option"); placeholder.value = ""; i18n.text(placeholder, () => t("请选择项目或无项目"));
    const none = document.createElement("option"); none.value = "__none__"; i18n.text(none, () => t("无项目"));
    ui.createProject.append(placeholder, none);
    for (const project of state.projects) {
      const option = document.createElement("option");
      option.value = project.projectId;
      i18n.text(option, () => `${project.label} · ${project.path}`);
      ui.createProject.append(option);
    }
    if (choice && choice !== "__none__" && !state.projects.some(project => project.projectId === choice)) {
      const unavailable = document.createElement("option"); unavailable.value = choice; i18n.text(unavailable, () => t`已保存项目不可用 · ${choice}`); unavailable.disabled = true;
      ui.createProject.append(unavailable);
    }
    ui.createProject.value = choice || "";
    renderProjectDetail();
  }

  async function loadProjects() {
    if (state.projectsLoading) return;
    state.projectsLoading = true;
    state.projectsError = "";
    ui.projectLoadState.hidden = true;
    ui.retryProjects.disabled = true;
    try {
      const data = await api("/api/projects");
      const projects = Array.isArray(data.projects) ? data.projects.filter(project => typeof project.projectId === "string" && project.projectId && typeof project.label === "string" && typeof project.path === "string") : [];
      state.projects = projects;
      state.projectsLoaded = true;
      state.projectsCanCreate = data.canCreate === false ? false : true;
      if (!state.createDraftLoaded || (!state.createDraft.projectChoice && !state.createDraft.title && !state.createDraft.prompt && !ui.createProject.value)) {
        const match = matchedCurrentProject(projects);
        state.createDraft.projectChoice = match;
        state.createDraftLoaded = true;
        persistCreateDraft(state.createDraft);
      }
      populateProjectSelect();
      if (data.canCreate === false) {
        state.projectsError = t("当前桥接配置未开放新建会话。");
        i18n.text(ui.projectLoadText, () => t(state.projectsError));
        ui.projectLoadState.hidden = false;
      }
    } catch (error) {
      state.projectsError = t`无法读取已保存项目：${t(error.message)}`;
      i18n.text(ui.projectLoadText, () => t(state.projectsError));
      ui.projectLoadState.hidden = false;
      populateProjectSelect();
    } finally {
      state.projectsLoading = false;
      ui.retryProjects.disabled = false;
      updateControls();
    }
  }

  function buildCreatePayload(draft) {
    const projectChoice = draft.projectChoice;
    if (!projectChoice) throw new Error(t("请选择一个已保存项目，或明确选择无项目。"));
    if (projectChoice !== "__none__" && !state.projects.some(project => project.projectId === projectChoice)) throw new Error(t("所选项目不可用。请重新加载项目列表。"));
    const prompt = draft.prompt.trim();
    if (!prompt) throw new Error(t("请填写首条消息。"));
    if (prompt.length > 12000) throw new Error(t("首条消息不能超过 12000 个字符。"));
    const title = draft.title.trim();
    if (title.length > 200) throw new Error(t("标题不能超过 200 个字符。"));
    return { projectId: projectChoice === "__none__" ? null : projectChoice, ...(title ? { title } : {}), prompt };
  }

  function createRequestId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return [...bytes].map((value, index) => `${[4, 6, 8, 10].includes(index) ? "-" : ""}${value.toString(16).padStart(2, "0")}`).join("");
  }

  function renderCreateRecoveryState() {
    const attempt = state.createAttempt;
    const receipt = state.createReceipt;
    ui.createError.hidden = !state.createErrorText;
    i18n.text(ui.createError, () => t(state.createErrorText) || "");
    ui.createRecoveryState.hidden = !attempt && !receipt && !state.createRecoveryError;
    i18n.text(ui.createRecoveryState, () => t(state.createRecoveryError) || "");
    ui.createRetry.hidden = !attempt || attempt.state !== "not_found";
    ui.checkCreateReceipt.hidden = !attempt || attempt.state !== "unknown";
    ui.enterCreatedFromDialog.hidden = !receipt;
    ui.createSubmit.hidden = !!attempt;
    if (attempt) {
      ui.createRecoveryState.hidden = false;
      i18n.text(ui.createRecoveryState, () => t(state.createRecoveryError) || (attempt.state === "not_found"
        ? t("未找到原请求记录。可手动沿用原请求编号和内容重试；请先核对会话列表。")
        : attempt.state === "sending" ? t("正在提交创建请求…") : t("创建结果尚未确认。页面只会核对回执，不会自动重发。")));
    } else if (receipt) {
      ui.createRecoveryState.hidden = false;
      i18n.text(ui.createRecoveryState, () => t("会话已创建。首条消息已随创建请求发送。"));
    }
    const canCreate = mayCreateThread();
    let valid = false;
    try { buildCreatePayload(readCreateDraftFromForm()); valid = true; } catch { /* The form remains editable. */ }
    ui.createSubmit.disabled = !canCreate || state.creatingThread || !valid;
    ui.createRetry.disabled = !canCreate || state.creatingThread;
    ui.checkCreateReceipt.disabled = state.creatingThread || !attempt;
  }

  function renderCreationResult() {
    const receipt = state.createReceipt;
    const show = !!receipt && state.selectedId !== receipt.threadId;
    ui.creationResult.hidden = !show;
    if (show) i18n.text(ui.creationResultText, () => t("新会话已创建。你可以继续当前任务，或进入刚创建的会话。"));
  }

  function openNewThreadDialog() {
    if (!mayCreateThread() && !state.createAttempt && !state.createReceipt && !state.createRecoveryError) return;
    setDrawer(false);
    populateProjectSelect();
    ui.createName.value = state.createDraft.title;
    ui.createPrompt.value = state.createDraft.prompt;
    state.createErrorText = "";
    ui.createDialog.showModal();
    renderCreateRecoveryState();
    void loadProjects();
    ui.createPrompt.focus();
  }

  function closeNewThreadDialog() {
    saveCreateDraftFromForm();
    ui.createDialog.close();
  }

  async function enterCreatedThread() {
    const receipt = state.createReceipt;
    if (!receipt || !THREAD_UUID.test(receipt.threadId || "")) return;
    state.createReceipt = null;
    try { sessionStorage.removeItem(NEW_THREAD_RECEIPT_KEY); } catch { /* The loaded thread remains available. */ }
    renderCreationResult();
    if (ui.createDialog.open) ui.createDialog.close();
    await selectThread(receipt.threadId);
  }

  function validCreateReceipt(receipt, requestId) {
    return receipt?.created === true && receipt.requestId === requestId && THREAD_UUID.test(receipt.threadId || "") && receipt.hostId === "local";
  }

  async function finishThreadCreation(receipt, attempt, selection) {
    if (!validCreateReceipt(receipt, attempt.requestId)) throw Object.assign(new Error(t("创建回执不匹配")), { code: "DELIVERY_UNKNOWN" });
    const currentDraft = ui.createDialog.open ? readCreateDraftFromForm() : state.createDraft;
    if (ui.createDialog.open) persistCreateDraft(currentDraft);
    let unchanged = state.createDraftRevision === attempt.draftRevision;
    try { unchanged = unchanged && JSON.stringify({ ...buildCreatePayload(currentDraft), ...readModelSettings("new") }) === JSON.stringify(attempt.payload); } catch { unchanged = false; }
    state.createReceipt = receipt;
    state.createAttempt = null;
    state.createRecoveryError = "";
    try {
      sessionStorage.setItem(NEW_THREAD_RECEIPT_KEY, JSON.stringify(receipt));
      sessionStorage.removeItem(NEW_THREAD_PENDING_KEY);
    } catch { /* The saved attempt still lets reloads look up this receipt. */ }
    if (unchanged) {
      state.createDraft = { projectChoice: "", title: "", prompt: "" };
      state.createDraftRevision += 1;
      persistCreateDraft(state.createDraft);
      if (ui.createDialog.open) { ui.createProject.value = ""; ui.createName.value = ""; ui.createPrompt.value = ""; renderProjectDetail(); }
    }
    updateCreateControls();
    const mayEnter = unchanged && ui.createDialog.open && selection && selection.switching === state.switching && selection.selectedId === state.selectedId;
    if (mayEnter) {
      ui.createDialog.close();
      await enterCreatedThread();
    } else if (ui.createDialog.open) renderCreateRecoveryState();
    void refreshTasks();
  }

  async function submitThreadCreation(attempt = null) {
    if (state.creatingThread || !mayCreateThread() || (state.createAttempt && attempt !== state.createAttempt)) return;
    let request = attempt;
    if (!request) {
      const draft = readCreateDraftFromForm();
      persistCreateDraft(draft);
      let payload;
      try { payload = { ...buildCreatePayload(draft), ...readModelSettings("new") }; }
      catch (error) { state.createErrorText = error.message; renderCreateRecoveryState(); return; }
      request = { requestId: createRequestId(), payload, draftRevision: state.createDraftRevision, state: "sending" };
      try { sessionStorage.setItem(NEW_THREAD_PENDING_KEY, JSON.stringify(request)); }
      catch {
        state.createErrorText = t("浏览器无法保存创建恢复记录，会话尚未创建。请释放本站会话存储后重试。");
        renderCreateRecoveryState();
        return;
      }
      state.createAttempt = request;
      state.createSelection = { selectedId: state.selectedId, switching: state.switching };
    } else {
      if (request !== state.createAttempt || request.state !== "not_found") return;
      request.state = "sending";
      try { sessionStorage.setItem(NEW_THREAD_PENDING_KEY, JSON.stringify(request)); }
      catch { state.createErrorText = t("无法保存恢复状态，未重试创建请求。"); renderCreateRecoveryState(); return; }
      state.createSelection = { selectedId: state.selectedId, switching: state.switching };
    }
    state.createErrorText = "";
    state.creatingThread = true;
    renderCreateRecoveryState();
    let recoverAfterSubmit = false;
    try {
      const result = await api("/api/threads", { method: "POST", body: JSON.stringify({ requestId: request.requestId, ...request.payload }) });
      await finishThreadCreation(result, request, state.createSelection);
    } catch (error) {
      const safe = new Set(["DEVICE_OFFLINE", "LOGIN_REQUIRED", "INVALID_REQUEST", "CREATE_DISABLED", "PROJECT_UNAVAILABLE", "CREATION_STORE_UNAVAILABLE", "LIMIT_REACHED", "UNAUTHORIZED", "FORBIDDEN"]);
      if (safe.has(error.code)) {
        state.createAttempt = null;
        try { sessionStorage.removeItem(NEW_THREAD_PENDING_KEY); } catch { /* A stale marker is recovered by receipt lookup. */ }
        state.createErrorText = error.message;
      } else {
        if (state.createAttempt) state.createAttempt.state = "unknown";
        try { sessionStorage.setItem(NEW_THREAD_PENDING_KEY, JSON.stringify(state.createAttempt)); } catch { /* The original marker remains in storage. */ }
        state.createRecoveryError = t("创建结果尚未确认。正在查询回执；不会自动重复创建。");
        state.createErrorText = error.message;
        recoverAfterSubmit = true;
      }
      renderCreateRecoveryState();
    } finally {
      state.creatingThread = false;
      renderCreateRecoveryState();
      updateControls();
      if (recoverAfterSubmit) void recoverThreadCreation();
    }
  }

  async function recoverThreadCreation() {
    const attempt = state.createAttempt;
    if (!attempt?.requestId || state.creatingThread) return;
    state.creatingThread = true;
    state.createErrorText = "";
    renderCreateRecoveryState();
    try {
      const result = await api(`/api/thread-creations/${encodeURIComponent(attempt.requestId)}`);
      if (result.state === "created" && validCreateReceipt(result.receipt, attempt.requestId)) {
        await finishThreadCreation(result.receipt, attempt, state.createSelection);
      } else if (result.state === "not_found") {
        attempt.state = "not_found";
        state.createRecoveryError = "";
        try { sessionStorage.setItem(NEW_THREAD_PENDING_KEY, JSON.stringify(attempt)); } catch { /* Preserve the in-memory retry only. */ }
      } else {
        attempt.state = "unknown";
        state.createRecoveryError = t("服务端仍无法确认创建结果。可以继续核对状态。");
      }
    } catch (error) {
      state.createRecoveryError = t`无法核对创建回执：${t(error.message)}。不会自动重发。`;
    } finally {
      state.creatingThread = false;
      renderCreateRecoveryState();
      updateControls();
    }
  }

  function showNotice(message, kind = "info", timeout = 0, source = null) {
    clearTimeout(state.noticeTimer);
    if (!message) { ui.notice.hidden = true; i18n.text(ui.notice, () => ""); return; }
    ui.notice.hidden = false;
    ui.notice.dataset.kind = kind;
    if (source) ui.notice.dataset.source = source;
    else delete ui.notice.dataset.source;
    delete ui.notice.dataset.taskId;
    i18n.text(ui.notice, () => t(message));
    if (timeout) state.noticeTimer = setTimeout(() => showNotice(""), timeout);
  }

  async function refreshExecution(id, token = state.switching) {
    if (!state.statusSnapshot?.executionControl || state.controlReads.has(id)) return;
    state.controlReads.add(id);
    try {
      const execution = await requestApi(`/api/threads/${encodeURIComponent(id)}/control`);
      if (id !== state.selectedId || token !== state.switching || execution.threadId !== id) return;
      if (JSON.stringify(state.execution) !== JSON.stringify(execution)) state.changeRevision += 1;
      state.execution = execution;
      if (execution.available === false) {
        state.controlUnavailable = true;
        state.controlRetry = execution.standby !== true;
        if (execution.standby === true) {
          ui.controlState.dataset.kind = "standby";
          i18n.text(ui.controlSummary, () => t(execution.reason || "会话待命，发送时沿用桌面设置"));
          ui.controlState.hidden = state.pendingCards.size === 0;
        } else {
          delete ui.controlState.dataset.kind;
          i18n.text(ui.controlSummary, () => execution.reason || t("运行控制快照暂不可用，保留当前待处理内容。"));
          ui.controlState.hidden = false;
        }
        for (const [key, entry] of state.pendingCards) updatePendingCard(id, entry.card, entry.card.__pendingControls.request);
        return;
      }
      state.controlUnavailable = false;
      state.controlRetry = false;
      delete ui.controlState.dataset.kind;
      renderPendingRequests(execution);
    } catch (error) {
      if (id === state.selectedId && token === state.switching) {
        state.execution = null;
        state.controlUnavailable = true;
        state.controlRetry = true;
        delete ui.controlState.dataset.kind;
        i18n.text(ui.controlSummary, () => t`暂时无法读取运行控制：${t(error.message)}`);
        ui.controlState.hidden = false;
        for (const [key, entry] of state.pendingCards) updatePendingCard(id, entry.card, entry.card.__pendingControls.request);
      }
    } finally {
      state.controlReads.delete(id);
      updateControls();
      if (state.controlRetry && !state.polling) schedulePoll(3000);
    }
  }

  function tokenFingerprint(token) {
    let hash = 2166136261;
    for (const char of String(token)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16);
  }

  function requestKey(threadId, request) { return `${encodeURIComponent(threadId)}\u001f${encodeURIComponent(String(request.requestId))}\u001f${tokenFingerprint(request.token)}`; }

  function requestFormStorageKey(threadId, request) {
    return `${CONTROL_FORM_PREFIX}${requestKey(threadId, request)}`;
  }

  function requestResponseStorageKey(threadId, request) {
    return `${CONTROL_RESPONSE_PREFIX}${requestKey(threadId, request)}`;
  }

  function readResponseState(threadId, request) {
    const key = requestKey(threadId, request);
    if (state.responseStates.has(key)) return state.responseStates.get(key);
    try {
      const saved = sessionStorage.getItem(requestResponseStorageKey(threadId, request));
      if (saved === "unknown" || saved === "delivered") state.responseStates.set(key, saved);
      return saved === "unknown" || saved === "delivered" ? saved : null;
    } catch { return null; }
  }

  function saveResponseState(threadId, request, value) {
    const key = requestKey(threadId, request);
    try { sessionStorage.setItem(requestResponseStorageKey(threadId, request), value); }
    catch { return false; }
    state.responseStates.set(key, value);
    return true;
  }

  function clearResponseState(threadId, request) {
    const key = requestKey(threadId, request);
    state.responseStates.delete(key);
    try { sessionStorage.removeItem(requestResponseStorageKey(threadId, request)); } catch { /* In-memory state is authoritative for this page. */ }
  }

  function readPendingAnswers(threadId, request, persistent) {
    const key = requestKey(threadId, request);
    if (state.pendingDrafts.has(key)) return state.pendingDrafts.get(key);
    if (!persistent) return {};
    try {
      const saved = JSON.parse(sessionStorage.getItem(requestFormStorageKey(threadId, request)) || "{}");
      return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    } catch { return {}; }
  }

  function savePendingAnswers(threadId, request, answers, persistent) {
    const key = requestKey(threadId, request);
    state.pendingDrafts.set(key, answers);
    if (!persistent) return;
    try { sessionStorage.setItem(requestFormStorageKey(threadId, request), JSON.stringify(answers)); } catch { /* The in-memory answer remains available. */ }
  }

  function requestHasSecret(request) {
    return ["userInput", "asyncUserInput"].includes(request.kind) && request.questions.some(question => question.isSecret === true);
  }

  function requestReadinessReason(request) {
    if (!request || request.requestId == null || typeof request.token !== "string" || !request.token) return t("请求凭据不完整，不能安全提交。");
    if (request.kind === "commandApproval") {
      if (typeof request.command !== "string" || !request.command || typeof request.cwd !== "string" || !request.cwd) return t("缺少完整命令或工作目录，不能审批。");
      return "";
    }
    if (request.kind === "fileApproval") {
      if (typeof request.cwd !== "string" || !request.cwd || !Array.isArray(request.files) || !request.files.length) return t("缺少工作目录或文件变更清单，不能审批。");
      for (const file of request.files) {
        if (typeof file.path !== "string" || !["add", "update", "delete"].includes(file.type) || (file.movePath != null && typeof file.movePath !== "string")) return t("文件变更信息不完整，不能审批。");
        if (file.type !== "delete" && typeof file.diff !== "string") return t("文件差异不完整，不能审批。");
      }
      return "";
    }
    if (["userInput", "asyncUserInput"].includes(request.kind)) {
      if (!Array.isArray(request.questions) || !request.questions.length || request.questions.some(question => typeof question.id !== "string" || (!question.header && !question.question) || !Array.isArray(question.options) || question.options.some(option => typeof option.label !== "string"))) return t("问题或选项信息不完整，不能提交回答。");
      return "";
    }
    return request.disabledReason || t("此交互类型暂不支持在手机上回复。");
  }

  function requestIsActionable(request) {
    return request?.actionable === true && !requestReadinessReason(request);
  }

  function appendFact(parent, labelText, value, className = "") {
    if (value == null || value === "") return;
    const row = document.createElement("div");
    row.className = `pending-fact ${className}`.trim();
    const label = document.createElement("span");
    label.className = "pending-fact-label";
    i18n.text(label, () => t(labelText));
    const content = document.createElement(className.includes("code") ? "pre" : "span");
    content.className = className.includes("code") ? "pending-code" : "pending-fact-value";
    i18n.text(content, () => String(value));
    row.append(label, content);
    parent.append(row);
  }

  function createPendingCard(threadId, request) {
    const card = document.createElement("section");
    card.className = "pending-card";
    card.dataset.pendingKey = requestKey(threadId, request);
    const heading = document.createElement("h2");
    heading.className = "pending-title";
    i18n.text(heading, () => request.title || ({ commandApproval: t("命令审批"), fileApproval: t("文件更改审批"), userInput: t("需要回答"), asyncUserInput: t("需要回答") }[request.kind] || t("待处理交互")));
    const facts = document.createElement("div");
    facts.className = "pending-facts";
    const form = ["userInput", "asyncUserInput"].includes(request.kind) ? document.createElement("form") : null;
    if (request.kind === "commandApproval") {
      appendFact(facts, t("命令"), request.command, "code");
      appendFact(facts, t("工作目录"), request.cwd);
      appendFact(facts, t("原因"), request.reason);
    } else if (request.kind === "fileApproval") {
      appendFact(facts, t("原因"), request.reason);
      appendFact(facts, t("工作目录"), request.cwd);
      for (const file of request.files || []) {
        appendFact(facts, file.movePath ? t("新路径") : ({ add: t("新增文件"), update: t("修改文件"), delete: t("删除文件") })[file.type] || t("文件"), file.path, "code");
        if (file.movePath) appendFact(facts, t("原路径"), file.movePath, "code");
        if (file.diff) appendFact(facts, t("变更"), file.diff, "code");
      }
    } else if (["userInput", "asyncUserInput"].includes(request.kind)) {
      const secret = requestHasSecret(request);
      const answers = readPendingAnswers(threadId, request, !secret);
      form.className = "pending-question-form";
      const questions = document.createElement("div"); questions.className = "pending-question-body";
      for (const [index, question] of request.questions.entries()) {
        const field = document.createElement("fieldset");
        field.className = "pending-question";
        const legend = document.createElement("legend");
        i18n.text(legend, () => [question.header, question.question].filter(Boolean).join(" · ") || t("回答"));
        field.append(legend);
        const saved = answers[question.id];
        let textInput = null;
        let radioInputs = [];
        if (question.options.length) {
          const groupName = `pending-${index}-${Math.random().toString(36).slice(2)}`;
          for (const [optionIndex, option] of question.options.entries()) {
            const label = document.createElement("label");
            label.className = "pending-option";
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = groupName;
            radio.value = option.label;
            radio.checked = saved?.type === "option" && saved.value === option.label;
            const copy = document.createElement("span");
            copy.className = "pending-option-copy";
            const name = document.createElement("strong"); name.textContent = option.label;
            copy.append(name);
            if (option.description) { const description = document.createElement("span"); description.textContent = option.description; copy.append(description); }
            label.append(radio, copy); field.append(label); radioInputs.push(radio);
            radio.addEventListener("change", () => {
              if (radio.checked) { if (textInput) { textInput.disabled = true; textInput.dataset.requestDisabled = "true"; } savePendingAnswers(threadId, request, { ...readPendingAnswers(threadId, request, !secret), [question.id]: { type: "option", value: option.label } }, !secret); updateQuestionSubmit(card, request); }
            });
          }
          if (question.isOther === true) {
            const other = document.createElement("label"); other.className = "pending-option";
            const radio = document.createElement("input"); radio.type = "radio"; radio.name = groupName; radio.value = "__other__"; radio.checked = saved?.type === "other";
            const copy = document.createElement("span"); copy.className = "pending-option-copy"; i18n.text(copy, () => t("其他回答"));
            other.append(radio, copy); field.append(other); radioInputs.push(radio);
            radio.addEventListener("change", () => {
              if (radio.checked) { if (textInput) { textInput.disabled = false; textInput.dataset.requestDisabled = "false"; } savePendingAnswers(threadId, request, { ...readPendingAnswers(threadId, request, !secret), [question.id]: { type: "other", value: textInput?.value || "" } }, !secret); textInput?.focus(); updateQuestionSubmit(card, request); }
            });
          }
        }
        const permitsText = !question.options.length || question.isOther === true;
        if (permitsText) {
          textInput = question.isSecret === true ? document.createElement("input") : document.createElement("textarea");
          if (question.isSecret === true) { textInput.type = "password"; textInput.autocomplete = "new-password"; textInput.spellcheck = false; }
          else { textInput.rows = 2; textInput.autocomplete = "off"; }
          textInput.className = "pending-answer";
          i18n.attr(textInput, "aria-label", () => question.header || question.question || t("回答"));
          i18n.attr(textInput, "placeholder", () => question.isSecret === true ? t("输入敏感回答") : t("输入回答"));
          if (saved?.type === "text" || saved?.type === "other") textInput.value = saved.value;
          if (question.options.length) textInput.disabled = saved?.type !== "other";
          if (question.options.length) textInput.dataset.requestDisabled = saved?.type !== "other" ? "true" : "false";
          textInput.addEventListener("input", () => {
            const mode = question.options.length ? "other" : "text";
            savePendingAnswers(threadId, request, { ...readPendingAnswers(threadId, request, !secret), [question.id]: { type: mode, value: textInput.value } }, !secret);
            updateQuestionSubmit(card, request);
          });
          field.append(textInput);
        }
        questions.append(field);
      }
      form.append(questions);
    } else {
      const unsupported = document.createElement("p");
      unsupported.className = "pending-disabled-reason";
      i18n.text(unsupported, () => request.disabledReason || t("此交互类型暂不支持在手机上回复。"));
      facts.append(unsupported);
    }
    const feedback = document.createElement("p"); feedback.className = "pending-feedback"; feedback.setAttribute("role", "status");
    const disabledReason = document.createElement("p"); disabledReason.className = "pending-disabled-reason";
    const actions = document.createElement("div"); actions.className = "pending-actions";
    const refresh = document.createElement("button"); refresh.type = "button"; refresh.className = "pending-refresh"; i18n.text(refresh, () => t("刷新状态"));
    refresh.addEventListener("click", () => { void refreshExecution(threadId); });
    actions.append(refresh);
    let accept = null, decline = null, submit = null;
    if (request.kind === "commandApproval" || request.kind === "fileApproval") {
      accept = document.createElement("button"); accept.type = "button"; accept.className = "pending-accept"; i18n.text(accept, () => t("允许一次"));
      decline = document.createElement("button"); decline.type = "button"; decline.className = "pending-decline"; i18n.text(decline, () => t("拒绝"));
      actions.append(decline, accept);
      accept.addEventListener("click", () => { void submitPendingResponse(threadId, request, { decision: "accept" }); });
      decline.addEventListener("click", () => { void submitPendingResponse(threadId, request, { decision: "decline" }); });
    } else if (form) {
      submit = document.createElement("button"); submit.type = "submit"; submit.className = "pending-submit"; i18n.text(submit, () => t("提交回答"));
      actions.append(submit);
      form.append(actions);
      form.addEventListener("submit", event => {
        event.preventDefault();
        const answers = {};
        for (const [index, question] of request.questions.entries()) {
          const field = form.querySelectorAll(".pending-question")[index];
          const selected = field.querySelector('input[type="radio"]:checked');
          const answer = question.options.length && selected?.value !== "__other__" ? selected?.value : field.querySelector(".pending-answer")?.value;
          if (typeof answer !== "string" || !answer.trim()) return;
          answers[question.id] = { answers: [answer] };
        }
        void submitPendingResponse(threadId, request, { answers });
      });
    }
    card.append(heading, facts);
    if (form) card.append(form);
    card.append(disabledReason, feedback);
    if (!form) card.append(actions);
    card.__pendingControls = { accept, decline, submit, form, disabledReason, feedback, request };
    if (form) updateQuestionSubmit(card, request);
    return card;
  }

  function updateQuestionSubmit(card, request) {
    const controls = card.__pendingControls;
    if (!controls?.submit) return;
    const form = controls.form;
    let valid = true;
    for (const [index, question] of request.questions.entries()) {
      const field = form.querySelectorAll(".pending-question")[index];
      const selected = field.querySelector('input[type="radio"]:checked');
      const answer = question.options.length && selected?.value !== "__other__" ? selected?.value : field.querySelector(".pending-answer")?.value;
      if (typeof answer !== "string" || !answer.trim()) valid = false;
    }
    controls.submit.disabled = !valid || controls.submit.dataset.locked === "true";
  }

  function updatePendingCard(threadId, card, request) {
    const controls = card.__pendingControls;
    if (!controls) return;
    const key = requestKey(threadId, request);
    if (request.responseState === "unknown" || request.responseState === "delivered") saveResponseState(threadId, request, request.responseState);
    const localState = readResponseState(threadId, request);
    const readinessReason = requestReadinessReason(request);
    const blocked = state.controlUnavailable || !requestIsActionable(request) || state.responding.has(key) || localState === "unknown" || localState === "delivered";
    controls.accept && (controls.accept.disabled = blocked);
    controls.decline && (controls.decline.disabled = blocked);
    for (const button of controls.form?.querySelectorAll("button") || []) if (button !== controls.submit) button.disabled = blocked;
    if (controls.submit) {
      controls.submit.dataset.locked = blocked ? "true" : "false";
      updateQuestionSubmit(card, request);
    }
    for (const input of controls.form?.querySelectorAll("input, textarea") || []) input.disabled = blocked || (input.dataset.requestDisabled === "true");
    controls.disabledReason.hidden = true;
    if (localState === "unknown") {
      controls.disabledReason.hidden = false;
      i18n.text(controls.disabledReason, () => t("提交结果尚未确认。不会再次发送；刷新状态并等待此请求消失。"));
    } else if (localState === "delivered") {
      controls.disabledReason.hidden = false;
      i18n.text(controls.disabledReason, () => t("回复已送达桌面，尚未确认请求已应用；等待此请求从列表消失。"));
    } else if (!requestIsActionable(request)) {
      controls.disabledReason.hidden = false;
      i18n.text(controls.disabledReason, () => request.disabledReason || readinessReason || t("此请求当前不可提交。"));
    } else if (state.controlUnavailable) {
      controls.disabledReason.hidden = false;
      i18n.text(controls.disabledReason, () => t("无法确认请求仍有效。刷新状态前不能提交。"));
    }
    if (state.responding.has(key)) i18n.text(controls.feedback, () => t("正在发送一次…"));
  }

  function renderPendingRequests(execution) {
    const allRequests = Array.isArray(execution.pendingRequests) ? execution.pendingRequests : [];
    const staleQuestion = request => ["userInput", "asyncUserInput"].includes(request.kind) && request.actionable !== true && request.reasonCode === "NOT_LATEST_TURN";
    const requests = allRequests.filter(request => !staleQuestion(request));
    const history = [...(Array.isArray(execution.historicalQuestions) ? execution.historicalQuestions : []), ...allRequests.filter(staleQuestion)];
    ui.historicalQuestionsContent.replaceChildren();
    state.historyFingerprint = history.length ? tokenFingerprint(JSON.stringify(history.map(request => [request.requestId, request.turnId, request.questions]))) : "";
    ui.historicalQuestions.hidden = !history.length || state.historyDismissed === state.historyFingerprint;
    ui.showHistory.hidden = !history.length || !ui.historicalQuestions.hidden;
    const activeKeys = new Set(requests.map(request => requestKey(execution.threadId, request)));
    const threadScope = `${encodeURIComponent(execution.threadId)}\u001f`;
    const activeResponseKeys = new Set(requests.map(request => requestResponseStorageKey(execution.threadId, request)));
    const activeFormKeys = new Set(requests.map(request => requestFormStorageKey(execution.threadId, request)));
    try {
      const staleKeys = [];
      for (let index = 0; index < sessionStorage.length; index += 1) {
        const storageKey = sessionStorage.key(index);
        if (!storageKey) continue;
        if (storageKey.startsWith(CONTROL_RESPONSE_PREFIX + threadScope) && !activeResponseKeys.has(storageKey)) staleKeys.push(storageKey);
        if (storageKey.startsWith(CONTROL_FORM_PREFIX + threadScope) && !activeFormKeys.has(storageKey)) staleKeys.push(storageKey);
      }
      for (const storageKey of staleKeys) sessionStorage.removeItem(storageKey);
    } catch { /* Storage cleanup is best effort; request tokens still scope drafts. */ }
    for (const [key, entry] of state.pendingCards) {
      if (!activeKeys.has(key)) {
        entry.card.remove(); state.pendingCards.delete(key);
        clearResponseState(entry.threadId, entry.card.__pendingControls.request);
        state.pendingDrafts.delete(requestKey(entry.threadId, entry.card.__pendingControls.request));
        try { sessionStorage.removeItem(requestFormStorageKey(entry.threadId, entry.card.__pendingControls.request)); } catch { /* Expired draft remains inaccessible to another request token. */ }
      }
    }
    for (const request of requests) {
      const key = requestKey(execution.threadId, request);
      let entry = state.pendingCards.get(key);
      if (!entry) {
        const card = createPendingCard(execution.threadId, request);
        entry = { card, threadId: execution.threadId };
        state.pendingCards.set(key, entry);
        ui.pendingRequests.append(card);
      }
      updatePendingCard(execution.threadId, entry.card, request);
    }
    const count = requests.length || Math.max(0, (execution.pendingRequestCount || 0) - allRequests.filter(staleQuestion).length);
    if (history.length) {
      for (const request of history) for (const question of request.questions || []) {
        const text = document.createElement('p');
        text.textContent = question.question;
        ui.historicalQuestionsContent.append(text);
      }
    }
    i18n.text(ui.controlSummary, () => count ? (requests.length ? t`${count} 项待处理交互` : t`${count} 项待处理交互暂时没有可显示的详情。`) : (!execution.available && normalizeStatus(state.thread?.status).kind === "running" ? (execution.reason || t("运行控制暂不可用。")) : ""));
    if (requests.length && !state.controlOpen && requests.some(request => !state.controlSeen.has(requestKey(execution.threadId, request)))) ui.controlSummary.textContent += t(" · 新");
    ui.controlState.hidden = !count && !ui.controlSummary.textContent;
    renderControlExpansion();
  }

  function renderControlExpansion() {
    ui.pendingRequests.hidden = !state.controlOpen;
    ui.controlToggle.setAttribute("aria-expanded", String(state.controlOpen));
    i18n.attr(ui.controlToggle, "title", () => state.controlOpen ? t("收起待处理交互") : t("查看待处理交互"));
    ui.closePending.hidden = !state.controlOpen;
    ui.controlState.dataset.expanded = String(state.controlOpen);
    if (state.controlOpen) {
      for (const key of state.pendingCards.keys()) state.controlSeen.add(key);
      try { sessionStorage.setItem(CONTROL_SEEN_PREFIX + state.selectedId, JSON.stringify([...state.controlSeen].slice(-100))); } catch { /* Expansion remains usable in this page. */ }
      i18n.text(ui.controlSummary, () => ui.controlSummary.textContent.replace(/ · 新$/, ""));
    }
  }

  function setControlExpansion(open) {
    state.controlOpen = !!open;
    try { sessionStorage.setItem(CONTROL_OPEN_PREFIX + state.selectedId, String(state.controlOpen)); } catch { /* The current panel remains usable. */ }
    renderControlExpansion();
    if (!open) ui.controlToggle.focus();
  }

  async function submitPendingResponse(threadId, request, payload) {
    const key = requestKey(threadId, request);
    const selection = state.switching;
    if (state.responding.has(key) || readResponseState(threadId, request) || !requestIsActionable(request) || state.controlUnavailable || threadId !== state.selectedId || state.execution?.threadId !== threadId) return;
    if (!saveResponseState(threadId, request, "unknown")) {
      const entry = state.pendingCards.get(key);
      if (entry) i18n.text(entry.card.__pendingControls.feedback, () => t("浏览器无法保存提交状态，回答尚未发送。请检查会话存储后重试。"));
      return;
    }
    state.responding.add(key);
    const entry = state.pendingCards.get(key);
    if (entry) updatePendingCard(threadId, entry.card, request);
    try {
      const result = await api(`/api/threads/${encodeURIComponent(threadId)}/respond`, { method: "POST", body: JSON.stringify({ requestId: request.requestId, token: request.token, ...payload }) });
      if (result.threadId !== threadId || String(result.requestId) !== String(request.requestId) || result.delivered !== true) throw Object.assign(new Error(t("未收到有效送达确认")), { code: "DELIVERY_UNKNOWN" });
      saveResponseState(threadId, request, "delivered");
      if (selection === state.switching && threadId === state.selectedId && entry) i18n.text(entry.card.__pendingControls.feedback, () => t("回复已送达桌面，正在等待请求状态更新。"));
    } catch (error) {
      const definitelyRejected = new Set(["DEVICE_OFFLINE", "LOGIN_REQUIRED", "INVALID_REQUEST", "REQUEST_CHANGED", "REQUEST_READ_ONLY", "CONTROL_DISABLED", "SEND_DISABLED", "SEND_BUSY", "OWNER_UNAVAILABLE", "PROTOCOL_INCOMPATIBLE", "UNSUPPORTED_THREAD", "DELIVERY_STORE_UNAVAILABLE", "LIMIT_REACHED"]);
      if (definitelyRejected.has(error.code)) clearResponseState(threadId, request);
      if (selection === state.switching && threadId === state.selectedId && entry) {
        i18n.text(entry.card.__pendingControls.feedback, () => definitelyRejected.has(error.code)
          ? t`请求没有发送：${t(error.message)}。正在刷新状态。`
          : error.code === "REQUEST_CHANGED" ? t("请求已变化或过期，正在刷新状态。") : t("提交结果尚未确认，正在刷新状态；不会自动重试。"));
      }
    } finally {
      state.responding.delete(key);
      if (selection === state.switching && threadId === state.selectedId) {
        const current = state.pendingCards.get(key);
        if (current) updatePendingCard(threadId, current.card, current.card.__pendingControls.request);
        void refreshExecution(threadId, selection);
      }
    }
  }

  async function stopExecution() {
    const execution = state.execution;
    const id = state.selectedId;
    const attachments = uploads.status(id);
    if (ui.input.value.trim() || attachments.count || attachments.blocked || state.selectionController || isUnknown(id) || state.stopping || state.sending || !state.connected || execution?.threadId !== id || !execution.canStop || !execution.turnId) return;
    state.stopping = true;
    updateControls();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(id)}/stop`, { method: "POST", body: JSON.stringify({ turnId: execution.turnId }) });
      if (result.threadId !== id || result.turnId !== execution.turnId) throw Object.assign(new Error(t("停止结果不匹配")), { code: "DELIVERY_UNKNOWN" });
      if (id === state.selectedId) {
        showNotice(result.stopped ? (result.goalPauseError ? t("当前轮次已中断，但目标暂停失败，请在桌面检查。") : t("当前轮次已停止。")) : t("当前轮次已结束，正在刷新。"), "info", 6000);
        state.execution = null;
        await loadThread({ mode: "latest" });
      }
    } catch (error) {
      if (id === state.selectedId) {
        state.execution = null;
        showNotice(error.code === "TURN_CHANGED" ? t("运行轮次已变化，未停止新的轮次。请查看更新后的状态。") : deliveryIsUnknown(error) ? t("停止结果尚未确认，页面不会自动重试；请核对当前状态。") : t`暂时无法停止：${t(error.message)}`, "error");
        void refreshExecution(id);
      }
    } finally { state.stopping = false; updateControls(); }
  }

  function sessionValue(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  }

  function localValue(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }

  function saveSelectedThread(id) {
    try { localStorage.setItem(SELECTED_KEY, id); } catch { /* Session navigation still works. */ }
    try {
      const url = new URL(location.href);
      url.searchParams.set("thread", id);
      history.replaceState(null, "", url);
    } catch { /* Ignore restricted history contexts. */ }
  }

  function preferredThreadId(status) {
    const queryId = new URLSearchParams(location.search).get("thread");
    if (queryId && THREAD_UUID.test(queryId) && !knownAgent(queryId)) return queryId;
    const savedId = localValue(SELECTED_KEY);
    if (savedId && THREAD_UUID.test(savedId) && !knownAgent(savedId)) return savedId;
    for (const id of [status?.defaultThreadId, status?.callerThreadId]) {
      if (typeof id === "string" && THREAD_UUID.test(id) && !knownAgent(id)) return id;
    }
    return null;
  }

  function saveDraft(id, value) {
    if (!id) return;
    if (readDraft(id) !== value) {
      const revision = `${Date.now()}-${Math.random()}`;
      state.draftRevisions.set(id, revision);
      try { sessionStorage.setItem(`${DRAFT_REVISION_PREFIX}${encodeURIComponent(id)}`, revision); } catch { /* Memory revision still protects this page. */ }
    }
    state.drafts.set(id, value);
    try { sessionStorage.setItem(`${DRAFT_PREFIX}${encodeURIComponent(id)}`, value); } catch { /* Memory draft remains available. */ }
  }

  function readDraft(id) {
    if (state.drafts.has(id)) return state.drafts.get(id);
    const value = sessionValue(`${DRAFT_PREFIX}${encodeURIComponent(id)}`) || "";
    state.drafts.set(id, value);
    return value;
  }

  function markUnknown(id) {
    state.unknownSends.add(id);
    try { sessionStorage.setItem(`${UNKNOWN_PREFIX}${encodeURIComponent(id)}`, "1"); return true; } catch { return false; }
  }

  function draftRevision(id) {
    return state.draftRevisions.get(id) || sessionValue(`${DRAFT_REVISION_PREFIX}${encodeURIComponent(id)}`) || "legacy";
  }

  function clearSentDraft(id, message) {
    uploads.remove(id, message.attachmentIds || []);
    const draftPrompt = message.draftPrompt ?? message.prompt;
    if (draftRevision(id) !== (message.draftRevision || "legacy") || readDraft(id).trim() !== draftPrompt) return;
    saveDraft(id, "");
    if (id === state.selectedId && ui.input.value.trim() === draftPrompt) {
      ui.input.value = "";
      autosizeInput();
    }
  }

  function clearUnknown(id) {
    state.unknownSends.delete(id);
    try { sessionStorage.removeItem(`${UNKNOWN_PREFIX}${encodeURIComponent(id)}`); } catch { /* Memory state is updated. */ }
  }

  function readPendingMessages(id) {
    if (state.pendingByThread.has(id)) return state.pendingByThread.get(id);
    let pending = [];
    try {
      const saved = JSON.parse(sessionValue(`${PENDING_PREFIX}${encodeURIComponent(id)}`) || "[]");
      if (Array.isArray(saved)) pending = saved.filter(message => THREAD_UUID.test(message?.requestId || "")
        && typeof message.prompt === "string" && message.prompt.length <= 12000
        && ["sending", "unknown", "accepted"].includes(message.state)).map(message => ({
          requestId: message.requestId, prompt: message.prompt, state: message.state === "sending" ? "unknown" : message.state,
          draftPrompt: typeof message.draftPrompt === "string" ? message.draftPrompt : message.prompt,
          attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds.filter(value => THREAD_UUID.test(value)) : [],
          draftRevision: typeof message.draftRevision === "string" ? message.draftRevision : "legacy",
          baselineKeys: Array.isArray(message.baselineKeys) ? message.baselineKeys.filter(key => typeof key === "string") : []
        }));
    } catch { /* The existing unknown marker still prevents silent resends. */ }
    if (pending.some(message => message.state === "unknown")) markUnknown(id);
    state.pendingByThread.set(id, pending);
    return pending;
  }

  function storePendingMessages(id, messages) {
    state.pendingByThread.set(id, messages);
    try {
      const key = `${PENDING_PREFIX}${encodeURIComponent(id)}`;
      if (messages.length) sessionStorage.setItem(key, JSON.stringify(messages));
      else sessionStorage.removeItem(key);
      return true;
    } catch { return false; }
  }

  function reconcilePendingMessages(id) {
    const unmatched = new Set(reconcileOptimisticMessages(state.pendingMessages, [...state.turns.values()]).map(message => message.requestId));
    // A matching snapshot is useful for display, but only a receipt proves acceptance
    // of this exact request. Keep uncertain requests available for receipt lookup.
    state.pendingMessages = state.pendingMessages.filter(message => unmatched.has(message.requestId) || message.state !== "accepted")
      .map(message => ({ ...message, observed: !unmatched.has(message.requestId) }));
    storePendingMessages(id, state.pendingMessages);
  }

  async function recoverDeliveryReceipts(id, force = false) {
    if (!id || state.receiptChecks.has(id) || (!force && Date.now() - (state.receiptCheckAt.get(id) || 0) < 15000)) return;
    const uncertain = readPendingMessages(id).filter(message => message.state === "unknown");
    if (!uncertain.length) return;
    state.receiptChecks.set(id, true);
    state.receiptCheckAt.set(id, Date.now());
    let recovered = false;
    try {
      for (const message of uncertain) {
        const delivery = await api(`/api/threads/${encodeURIComponent(id)}/messages/${encodeURIComponent(message.requestId)}`);
        const receipt = delivery.receipt;
        if (!readPendingMessages(id).some(item => item.requestId === message.requestId && item.state === "unknown")) continue;
        if (delivery.state !== "accepted" || receipt?.accepted !== true || receipt.threadId !== id || receipt.requestId !== message.requestId) continue;
        updatePendingMessage(id, message.requestId, item => ({ ...item, state: "accepted" }));
        clearSentDraft(id, message);
        recovered = true;
      }
      if (!readPendingMessages(id).some(message => message.state !== "accepted")) clearUnknown(id);
      if (id === state.selectedId) {
        reconcilePendingMessages(id);
        renderTranscript(false);
        saveThreadSnapshot(id);
        if (isUnknown(id)) showUnknownNotice(id);
        else if (recovered) showNotice(t("已找回桌面接收回执，无需重发。"), "info", 6000);
      }
    } catch { /* A failed read is not evidence that the original send failed. */ }
    finally { state.receiptChecks.delete(id); updateControls(); }
  }

  function isUnknown(id) {
    if (!id) return false;
    if (state.unknownSends.has(id)) return true;
    if (sessionValue(`${UNKNOWN_PREFIX}${encodeURIComponent(id)}`) === "1") {
      state.unknownSends.add(id);
      return true;
    }
    return false;
  }

  function refreshTaskNotice() {
    if (isUnknown(state.selectedId)) showUnknownNotice(state.selectedId);
    else showNotice("");
  }

  function showUnknownNotice(id) {
    if (!ui.notice.hidden && ui.notice.dataset.taskId === id && ui.notice.querySelector(".notice-action")) return;
    clearTimeout(state.noticeTimer);
    ui.notice.hidden = false;
    ui.notice.dataset.kind = "error";
    ui.notice.dataset.taskId = id;
    ui.notice.replaceChildren();
    const message = document.createElement("span");
    i18n.text(message, () => t("上一条消息的送达状态尚未确认。页面会查询接收回执，不会自动重发；仍无法确认时，请在桌面检查。"));
    const recheck = document.createElement("button");
    recheck.type = "button";
    recheck.className = "notice-action";
    i18n.text(recheck, () => t("重新核对回执"));
    recheck.addEventListener("click", async () => {
      recheck.disabled = true;
      i18n.text(recheck, () => t("正在核对…"));
      await recoverDeliveryReceipts(id, true);
      recheck.disabled = false;
      i18n.text(recheck, () => t("重新核对回执"));
    });
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "notice-action";
    i18n.text(confirm, () => t("我已人工检查，解除发送锁"));
    confirm.addEventListener("click", () => {
      clearUnknown(id);
      const remaining = readPendingMessages(id).filter(item => item.state !== "unknown");
      storePendingMessages(id, remaining);
      if (id === state.selectedId) { state.pendingMessages = remaining; renderTranscript(false); }
      showNotice(t("发送锁已解除。请根据桌面中的检查结果自行决定后续操作。"), "info", 7000);
      updateControls();
    }, { once: true });
    ui.notice.append(message, recheck, confirm);
  }

  function setDrawer(open) {
    const isOpen = open && window.matchMedia("(max-width: 759px)").matches;
    ui.drawer.classList.toggle("is-open", isOpen);
    ui.drawer.setAttribute("aria-hidden", String(!isOpen && window.matchMedia("(max-width: 759px)").matches));
    ui.menuButton.setAttribute("aria-expanded", String(isOpen));
    ui.scrim.hidden = !isOpen;
  }

  function statusDotKind(status) {
    const kind = normalizeStatus(status).kind;
    return kind === "running" || kind === "error" ? kind : "";
  }

  function orderIds(kind, key) {
    if (kind === "project") return state.sidebarOrder.order.projects;
    return state.sidebarOrder.order.threads[key] || [];
  }

  function moveVisibleOrder(savedIds, currentVisibleIds, movedVisibleIds) {
    const visible = new Set(currentVisibleIds);
    const full = [...new Set([...(savedIds || []), ...currentVisibleIds])];
    let nextVisible = 0;
    return full.map(id => visible.has(id) ? movedVisibleIds[nextVisible++] : id);
  }

  function moveOrder(kind, key, itemId, targetId, after = false) {
    if (!state.sorting || ui.taskSearch.value.trim()) return;
    const items = kind === "project"
      ? [...new Set(state.threads.filter(thread => !isThreadPinned(thread)).map(sidebarGroupKey))]
      : state.threads.filter(thread => sidebarGroupKey(thread) === key).map(thread => thread.id);
    if (!state.orderConfigured) {
      state.sidebarOrder = mergeSidebarOrder(state.sidebarOrder, state.threads.map(thread => ({ ...thread, pinned: isThreadPinned(thread) })));
      state.orderConfigured = true;
    }
    const ids = kind === "project" ? orderProjectKeys(items, state.sidebarOrder.order) : orderThreadRows(items.map(id => ({ id })), key, state.sidebarOrder.order).map(thread => thread.id);
    const from = ids.indexOf(itemId);
    const target = ids.indexOf(targetId);
    if (from < 0 || target < 0) return;
    let targetIndex = target + (after ? 1 : 0);
    if (from < targetIndex) targetIndex -= 1;
    targetIndex = Math.max(0, Math.min(ids.length - 1, targetIndex));
    const moved = moveOrderItem(ids, from, targetIndex);
    if (moved.every((id, index) => id === ids[index])) return;
    if (kind === "project") state.sidebarOrder.order.projects = moveVisibleOrder(state.sidebarOrder.order.projects, ids, moved);
    else state.sidebarOrder.order.threads[key] = moveVisibleOrder(state.sidebarOrder.order.threads[key] || [], ids, moved);
    state.orderDirty = true;
    state.taskListFingerprint = "";
    renderTasks();
    [...ui.taskList.querySelectorAll(".order-handle")]
      .find(handle => handle.dataset.orderKind === kind && handle.dataset.orderId === itemId)?.focus();
    void persistSidebarOrder();
  }

  function bindOrderHandle(handle, { kind, key, id, label }) {
    handle.className = "order-handle";
    handle.type = "button";
    i18n.text(handle, () => "⠿");
    handle.dataset.orderKind = kind;
    handle.dataset.orderKey = key || "";
    handle.dataset.orderId = id;
    i18n.attr(handle, "title", () => t("拖动，或使用方向键调整顺序"));
    i18n.attr(handle, "aria-label", () => t`调整顺序：${label}`);
    handle.addEventListener("pointerdown", event => {
      if (!state.sorting || ui.taskSearch.value.trim()) return;
      event.preventDefault();
      state.dragging = { pointerId: event.pointerId, kind, key, id, startY: event.clientY, targetId: id, after: false };
      handle.setPointerCapture?.(event.pointerId);
      handle.closest("[data-order-kind]")?.classList.add("is-dragging");
    });
    handle.addEventListener("keydown", event => {
      if (!state.sorting || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      moveOneOrderItem(kind, key, id, event.key === "ArrowDown" ? 1 : -1);
    });
  }

  function orderControls({ kind, key, id, label }) {
    const controls = document.createElement("span");
    controls.className = "order-controls";
    const handle = document.createElement("button");
    bindOrderHandle(handle, { kind, key, id, label });
    const up = document.createElement("button");
    up.type = "button";
    up.className = "order-step";
    i18n.text(up, () => "↑");
    i18n.attr(up, "title", () => t`上移：${label}`);
    i18n.attr(up, "aria-label", () => t`上移：${label}`);
    up.addEventListener("click", () => moveOneOrderItem(kind, key, id, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "order-step";
    i18n.text(down, () => "↓");
    i18n.attr(down, "title", () => t`下移：${label}`);
    i18n.attr(down, "aria-label", () => t`下移：${label}`);
    down.addEventListener("click", () => moveOneOrderItem(kind, key, id, 1));
    controls.append(handle, up, down);
    return controls;
  }

  function moveOneOrderItem(kind, key, id, direction) {
    const current = kind === "project"
      ? orderProjectKeys([...new Set(state.threads.filter(thread => !isThreadPinned(thread)).map(sidebarGroupKey))], state.sidebarOrder.order)
      : orderThreadRows(state.threads.filter(thread => sidebarGroupKey(thread) === key), key, state.sidebarOrder.order).map(thread => thread.id);
    const from = current.indexOf(id);
    const to = Math.max(0, Math.min(current.length - 1, from + direction));
    if (from < 0 || to === from) return;
    moveOrder(kind, key, id, current[to], direction > 0);
  }

  function createTaskRow(thread, groupKey = threadGroupKey(thread)) {
    const row = document.createElement("div");
    row.className = "task-row";
    row.dataset.orderKind = "thread";
    row.dataset.orderKey = groupKey;
    row.dataset.orderId = thread.id;
    if (state.sorting) {
      row.append(orderControls({ kind: "thread", key: groupKey, id: thread.id, label: text(thread.title, t("未命名会话")) }));
    }
    const select = document.createElement("button");
    select.type = "button";
    select.className = "task-item";
    select.setAttribute("aria-current", String(thread.id === state.selectedId));
    const title = document.createElement("span");
    title.className = "task-title";
    i18n.text(title, () => text(thread.title, t("未命名会话")));
    const dotKind = statusDotKind(thread.status);
    if (dotKind) {
      const dot = document.createElement("span");
      dot.className = `status-dot ${dotKind}`;
      i18n.attr(dot, "aria-label", () => dotKind === "running" ? t("进行中") : t("错误"));
      select.append(dot);
    }
    select.append(title);
    select.addEventListener("click", () => selectThread(thread.id));

    const menu = document.createElement("details");
    menu.className = "task-menu";
    const menuButton = document.createElement("summary");
    i18n.text(menuButton, () => "···");
    i18n.attr(menuButton, "title", () => t("会话菜单"));
    i18n.attr(menuButton, "aria-label", () => t`会话菜单：${text(thread.title, t("未命名会话"))}`);
    const pinned = isThreadPinned(thread);
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "task-pin-action";
    i18n.text(pin, () => pinned ? t("取消置顶") : t("置顶会话"));
    i18n.attr(pin, "title", () => t("同步到 Codex 桌面的置顶状态"));
    pin.disabled = !mayManageThread(thread, "pin");
    pin.addEventListener("click", event => {
      event.stopPropagation();
      openThreadAction(thread, "pin", !pinned);
    });
    const rename = document.createElement("button");
    rename.type = "button";
    i18n.text(rename, () => t("重命名"));
    rename.disabled = !mayManageThread(thread, "rename");
    rename.addEventListener("click", () => openThreadAction(thread, "rename"));
    const archive = document.createElement("button");
    archive.type = "button";
    i18n.text(archive, () => t(i18n.language === "en" ? "归档当前会话" : "归档会话"));
    archive.disabled = !mayManageThread(thread, "archive");
    i18n.attr(archive, "title", () => archive.disabled ? t("仅可归档未运行的会话，启动桥接的会话不可归档") : t("归档后可在桌面恢复"));
    const actions = document.createElement("div");
    actions.className = "task-menu-actions";
    pin.className = "";
    actions.append(pin, rename, archive);
    archive.addEventListener("click", () => openThreadAction(thread, "archive", true));
    menu.append(menuButton, actions);
    row.append(select, menu);
    return row;
  }

  function appendPinnedList(threads) {
    if (!threads.length) return;
    const group = document.createElement("section");
    group.className = "pinned-list";
    const heading = document.createElement("h3");
    heading.className = "list-section-heading";
    i18n.text(heading, () => t("已置顶"));
    group.append(heading);
    for (const thread of threads) group.append(createTaskRow(thread, "@pinned"));
    ui.taskList.append(group);
  }

  function appendProjectFolder(key, label, threads, searchOpen) {
    const orderRow = document.createElement("div");
    orderRow.className = "project-order-row";
    orderRow.dataset.orderKind = "project";
    orderRow.dataset.orderKey = key;
    if (state.sorting) {
      orderRow.append(orderControls({ kind: "project", key: null, id: key, label }));
    }
    const folder = document.createElement("details");
    folder.className = "project-folder";
    folder.dataset.projectKey = key;
    const defaultOpen = searchOpen || threads.some(thread => thread.id === state.selectedId);
    folder.open = searchOpen || (state.expandedProjects.has(key) ? state.expandedProjects.get(key) : defaultOpen);
    const heading = document.createElement("summary");
    heading.className = "project-folder-heading";
    const name = document.createElement("span");
    name.className = "project-name";
    i18n.text(name, () => key === "unassigned" ? t("其他会话") : label);
    const count = document.createElement("span");
    count.className = "project-count";
    i18n.text(count, () => String(threads.length));
    heading.append(name, count);
    folder.append(heading);
    for (const thread of threads) folder.append(createTaskRow(thread, key));
    folder.addEventListener("toggle", () => {
      if (searchOpen || state.expandedProjects.get(key) === folder.open) return;
      state.expandedProjects.set(key, folder.open);
      state.taskListFingerprint = "";
      try { localStorage.setItem(PROJECT_OPEN_KEY, JSON.stringify(Object.fromEntries(state.expandedProjects))); } catch { /* Folder state remains for this page. */ }
    });
    orderRow.append(folder);
    ui.taskList.append(orderRow);
  }

  function mayManageThread(thread, action) {
    const status = state.statusSnapshot;
    if (!state.connected || state.managing || !status?.threadManagement?.[action] || thread.archived) return false;
    if (status.sendScope !== "all-local" && status.allowedSendThreadId !== thread.id) return false;
    if (!['idle', 'notloaded', 'active', 'running', 'in_progress', 'inprogress'].includes(String(thread.status).toLowerCase())) return false;
    if (thread.id === state.selectedId && state.thread?.canManage === false) return false;
    if (action === "archive" && (thread.id === status.callerThreadId || normalizeStatus(thread.status).kind === "running")) return false;
    return true;
  }

  function openThreadAction(thread, action, value) {
    if (!mayManageThread(thread, action)) return;
    state.threadAction = { id: thread.id, action, value };
    i18n.text(ui.actionTitle, () => action === "rename" ? t("重命名会话") : action === "archive" ? t(i18n.language === "en" ? "归档当前会话" : "归档会话") : value ? t("置顶会话") : t("取消置顶"));
    i18n.text(ui.actionHint, () => action === "archive" ? t`归档“${thread.title}”？它会从网页与桌面列表移除，可在桌面恢复。` : t`此操作会同步到桌面：“${thread.title}”。`);
    ui.nameInput.hidden = ui.nameLabel.hidden = action !== "rename";
    ui.nameInput.value = text(thread.title);
    ui.nameInput.required = action === "rename";
    ui.actionError.hidden = true;
    ui.actionConfirm.disabled = false;
    i18n.text(ui.actionConfirm, () => action === "archive" ? t("归档") : t("保存"));
    i18n.text(ui.actionCancel, () => t("取消"));
    ui.actionDialog.showModal();
    if (action === "rename") { ui.nameInput.focus(); ui.nameInput.select(); }
  }

  async function submitThreadAction(event) {
    event.preventDefault();
    const action = state.threadAction;
    if (!action || state.managing) return;
    const value = action.action === "rename" ? ui.nameInput.value.trim() : action.value;
    if (action.action === "rename" && !value) { ui.nameInput.focus(); return; }
    state.managing = true;
    ui.actionConfirm.disabled = true;
    ui.actionCancel.disabled = true;
    ui.actionError.hidden = true;
    i18n.text(ui.actionConfirm, () => t("处理中…"));
    try {
      const result = await api(`/api/threads/${encodeURIComponent(action.id)}/settings`, { method: "POST", body: JSON.stringify({ action: action.action, value }) });
      if (!result.accepted || result.threadId !== action.id || result.action !== action.action) throw Object.assign(new Error(t("未收到有效确认")), { code: "DELIVERY_UNKNOWN" });
      if (action.action === "pin") {
        state.pinnedOverrides.delete(action.id);
        try { localStorage.setItem(PINNED_KEY, JSON.stringify(Object.fromEntries(state.pinnedOverrides))); } catch { /* Native state is authoritative. */ }
      }
      if (action.action === "archive") {
        state.threads = state.threads.filter(thread => thread.id !== action.id);
        state.threadCache.delete(action.id);
        if (state.selectedId === action.id) {
          saveDraft(action.id, ui.input.value);
          state.readController?.abort();
          state.switching += 1;
          state.selectedId = null;
          contextPanel.setThread(null);
          state.thread = null;
          state.turns.clear();
          state.pendingMessages = [];
          ui.input.value = "";
          // Prefer the bridge's still-open source task after archiving selection.
          saveSelectedThread(state.callerThreadId);
          renderTranscript(false);
          renderThreadHeader();
        }
      }
      ui.actionDialog.close();
      showNotice(t("会话设置已同步到桌面。"), "info", 5000);
      await refreshTasks();
    } catch (error) {
      ui.actionError.hidden = false;
      const unknown = deliveryIsUnknown(error);
      i18n.text(ui.actionError, () => unknown ? t("操作结果尚未确认，请关闭后刷新列表或在桌面核对。页面不会自动重复提交。") : t(error.message));
      ui.actionConfirm.disabled = unknown;
      i18n.text(ui.actionConfirm, () => unknown ? t("结果待核对") : t("重试"));
      i18n.text(ui.actionCancel, () => t("关闭"));
      if (unknown) state.threadAction = null;
    } finally {
      state.managing = false;
      ui.actionCancel.disabled = false;
      state.taskListFingerprint = "";
      renderTasks();
    }
  }

  function renderTasks() {
    if (state.dragging) return;
    const query = ui.taskSearch.value.trim().toLocaleLowerCase();
    if (query && state.sorting) state.sorting = false;
    ui.drawer.dataset.sorting = String(state.sorting);
    ui.sortToggle.disabled = !!query || !state.orderLoaded;
    ui.sortToggle.setAttribute("aria-pressed", String(state.sorting));
    ui.resetOrder.disabled = !state.orderLoaded || state.orderSaving || (!state.orderConfigured && !state.orderDirty);
    ui.orderState.hidden = false;
    if (query) i18n.text(ui.orderState, () => t("清除搜索后可调整顺序"));
    else if (state.orderSaving) i18n.text(ui.orderState, () => t("正在保存顺序…"));
    else if (state.orderDirty) i18n.text(ui.orderState, () => t("顺序未保存；再调整一次以重试"));
    else if (state.orderConfigured) i18n.text(ui.orderState, () => t("网页排序 · 已保存"));
    else ui.orderState.hidden = true;
    const filtered = state.threads.filter(thread => {
      if (knownAgent(thread.id) || delegatedThread(thread)) return false;
      if (!query) return true;
      return [thread.title, thread.projectName, thread.projectPath, thread.cwd, thread.projectId, thread.id]
        .some(value => text(value).toLocaleLowerCase().includes(query));
    });
    const fingerprint = JSON.stringify({
      query, selected: state.selectedId, sorting: state.sorting, order: state.sidebarOrder.order,
      management: state.statusSnapshot?.threadManagement, connected: state.connected, managing: state.managing,
      expanded: [...state.expandedProjects].sort(([a], [b]) => a.localeCompare(b)),
      threads: filtered.map(thread => [thread.id, thread.title, thread.status, thread.projectKey, thread.projectPath, thread.projectName, thread.projectId, thread.cwd, thread.projectOrder, thread.projectThreadOrder, thread.pinnedIndex, isThreadPinned(thread)])
    });
    i18n.text(ui.taskCount, () => query ? `${filtered.length} / ${state.threads.length}` : t`${state.threads.length} 个会话`);
    if (fingerprint === state.taskListFingerprint) return;
    state.taskListFingerprint = fingerprint;
    ui.taskList.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("p");
      empty.className = "muted empty-list";
      i18n.text(empty, () => state.threads.length ? t("没有匹配的会话") : state.connected ? t("暂时没有可显示的会话") : t("连接后会显示会话"));
      ui.taskList.append(empty);
      return;
    }
    const pinned = orderThreadRows(filtered.filter(isThreadPinned).sort((a, b) => (a.pinnedIndex ?? 0) - (b.pinnedIndex ?? 0)), "@pinned", state.sidebarOrder.order);
    appendPinnedList(pinned);
    const projects = new Map();
    for (const thread of filtered.filter(item => !isThreadPinned(item))) {
      const key = sidebarGroupKey(thread);
      const { label } = projectGroup(thread);
      if (!projects.has(key)) projects.set(key, { label, order: thread.projectOrder ?? 9999, threads: [] });
      projects.get(key).threads.push(thread);
    }
    const orderedProjectKeys = orderProjectKeys([...projects.keys()].sort((a, b) => {
      const left = projects.get(a), right = projects.get(b);
      return (a === "unassigned" ? 1 : 0) - (b === "unassigned" ? 1 : 0) || left.order - right.order;
    }), state.sidebarOrder.order);
    for (const key of orderedProjectKeys) {
      const { label } = projects.get(key);
      let { threads } = projects.get(key);
      threads.sort((a, b) => (a.projectThreadOrder ?? 9999) - (b.projectThreadOrder ?? 9999));
      threads = orderThreadRows(threads, key, state.sidebarOrder.order);
      appendProjectFolder(key, label, threads, !!query);
    }
  }

  async function refreshTasks({ preserveOnError = true, selectIfEmpty = true } = {}) {
    if (state.listLoading) return;
    state.listLoading = true;
    try {
      const data = await api("/api/threads");
      const listedThreads = Array.isArray(data.threads) ? [...data.threads] : [];
      rememberAgents(listedThreads.filter(delegatedThread));
      const threads = listedThreads.filter(thread => !knownAgent(thread.id) && !delegatedThread(thread));
      if (state.thread?.id && !knownAgent(state.thread.id) && !delegatedThread(state.thread)) {
        const selectedIndex = threads.findIndex(item => item.id === state.thread.id);
        if (selectedIndex >= 0) {
          state.thread = mergeReadThread(threads[selectedIndex], [state.thread]);
          threads[selectedIndex] = state.thread;
        } else {
          threads.unshift(state.thread);
        }
      }
      state.threads = threads;
      if (state.orderConfigured || state.orderDirty) state.sidebarOrder = mergeSidebarOrder(state.sidebarOrder, threads.map(thread => ({ ...thread, pinned: isThreadPinned(thread) })));
      renderTasks();
      if (!state.orderSaving && !state.orderDirty && !state.dragging) {
        try {
          const requestedOrder = state.sidebarOrder;
          const serverOrder = await api("/api/sidebar-order");
          if (!state.orderSaving && !state.orderDirty && !state.dragging && requestedOrder === state.sidebarOrder) {
            state.orderConfigured = hasCustomOrder(serverOrder);
            state.sidebarOrder = state.orderConfigured
              ? mergeSidebarOrder(serverOrder, threads.map(thread => ({ ...thread, pinned: isThreadPinned(thread) })))
              : { revision: serverOrder.revision ?? 0, order: serverOrder.order || { projects: [], threads: {} } };
            state.orderLoaded = true;
          }
        } catch (error) {
          if (!state.orderLoaded) showNotice(t`无法读取会话排序：${t(error.message)}`, "error");
        }
      }
      renderTasks();
      if (selectIfEmpty && !state.selectedId) {
        const targetId = preferredThreadId(state.statusSnapshot) || state.threads[0]?.id;
        if (targetId) await selectThread(targetId);
      }
      else if (state.selectedId) {
        const updated = state.threads.find((item) => item.id === state.selectedId);
        if (updated && state.thread) { renderThreadHeader(); updateControls(); }
      }
    } catch (error) {
      setConnection(false, null, error);
      if (!preserveOnError || !state.threads.length) renderTasks();
      if (isUnknown(state.selectedId)) showUnknownNotice(state.selectedId);
      else showNotice(t`暂时无法读取任务列表：${t(error.message)}`, "error", 0, "connection");
    } finally {
      state.lastListAt = Date.now();
      state.listLoading = false;
    }
  }

  async function persistSidebarOrder() {
    if (state.orderSaving || !state.orderDirty) return;
    state.orderSaving = true;
    renderTasks();
    while (state.orderDirty) {
      state.orderDirty = false;
      const order = JSON.parse(JSON.stringify(state.sidebarOrder.order));
      try {
        const result = await api("/api/sidebar-order", {
          method: "PUT",
          body: JSON.stringify({ revision: state.sidebarOrder.revision, order })
        });
        const revision = Number.isSafeInteger(result.revision) ? result.revision : state.sidebarOrder.revision + 1;
        state.orderConfigured = hasCustomOrder({ order: result.order || order });
        state.sidebarOrder = state.orderDirty
          ? { ...state.sidebarOrder, revision }
          : state.orderConfigured
            ? mergeSidebarOrder({ revision, order: result.order || order }, state.threads.map(thread => ({ ...thread, pinned: isThreadPinned(thread) })))
            : { revision, order: result.order || order };
      } catch (error) {
        if (error.status === 409 || error.code === "ORDER_CONFLICT") {
          try {
            const latest = await api("/api/sidebar-order");
            state.orderConfigured = hasCustomOrder(latest);
            state.sidebarOrder = state.orderConfigured
              ? mergeSidebarOrder(latest, state.threads.map(thread => ({ ...thread, pinned: isThreadPinned(thread) })))
              : { revision: latest.revision ?? 0, order: latest.order || { projects: [], threads: {} } };
            state.orderDirty = false;
          } catch { /* The current local order remains visible until the next refresh. */ }
          showNotice(t("排序已被另一页面更新，已同步服务器顺序。请重新调整。"), "error");
          break;
        }
        state.orderDirty = true;
        showNotice(t("无法保存排序；本页面暂时保留当前顺序。"), "error");
        break;
      }
    }
    state.orderSaving = false;
    state.taskListFingerprint = "";
    renderTasks();
  }

  async function resetSidebarOrder() {
    if (!state.orderLoaded || state.orderSaving) return;
    state.sidebarOrder.order = { projects: [], threads: {} };
    state.orderConfigured = false;
    state.orderDirty = true;
    state.taskListFingerprint = "";
    renderTasks();
    await persistSidebarOrder();
  }

  function handlePointerMove(event) {
    const drag = state.dragging;
    if (!drag || drag.pointerId !== event.pointerId || Math.abs(event.clientY - drag.startY) < 5) return;
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(drag.kind === "project" ? ".project-order-row" : ".task-row");
    document.querySelectorAll(".order-drop-target").forEach(element => element.classList.remove("order-drop-target"));
    if (!target || target.dataset.orderKind !== drag.kind) return;
    if (drag.kind === "thread" && target.dataset.orderKey !== drag.key) return;
    drag.targetId = drag.kind === "project" ? target.dataset.orderKey : target.dataset.orderId;
    drag.after = event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
    target.classList.add("order-drop-target");
  }

  function finishPointerDrag(event) {
    const drag = state.dragging;
    if (!drag || drag.pointerId !== event.pointerId) return;
    state.dragging = null;
    document.querySelectorAll(".is-dragging, .order-drop-target").forEach(element => element.classList.remove("is-dragging", "order-drop-target"));
    if (event.type !== "pointercancel" && drag.targetId && drag.targetId !== drag.id) moveOrder(drag.kind, drag.key, drag.id, drag.targetId, drag.after);
    renderTasks();
  }

  function renderThreadHeader() {
    const thread = state.thread;
    if (!thread) {
      filesPanel.setThread(null);
      i18n.text(ui.title, () => t("选择一个会话"));
      i18n.text(ui.subtitle, () => t("本机 Codex"));
      ui.status.hidden = true;
      ui.details.hidden = true;
      return;
    }
    const listed = state.threads.find(item => item.id === state.selectedId) || {};
    const combined = {
      ...listed,
      ...thread,
      cwd: thread.cwd || listed.cwd,
      projectId: thread.projectId || listed.projectId,
      projectName: thread.projectName || listed.projectName,
    };
    const { label: projectName } = projectGroup(combined);
    i18n.text(ui.title, () => text(thread.title, t("未命名会话")));
    i18n.text(ui.subtitle, () => projectGroup(combined).key === "unassigned" ? t("其他会话") : projectName);
    const status = normalizeStatus(thread.status);
    ui.status.hidden = false;
    i18n.text(ui.status, () => t(status.label));
    ui.status.dataset.kind = status.kind;
    ui.details.hidden = false;
    ui.details.dataset.threadId = state.selectedId;
    ui.details.open = state.taskDetailsOpen.get(state.selectedId) === true;
    i18n.text(ui.id, () => text(thread.id, "—"));
    i18n.text(ui.project, () => text(combined.projectId || projectName, "—"));
    i18n.text(ui.cwd, () => text(combined.cwd, t("未提供")));
    filesPanel.setThread({ id: state.selectedId, cwd: text(combined.cwd, "") });
  }

  function appendSafeMarkdown(parent, source) {
    renderMarkdown(parent, text(source, ""), document, { allowFollowups: true });
  }

  function displayDetail(value) {
    if (typeof value === "string") return value;
    if (value == null) return "";
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  }

  function elementFromItem(item, options = {}) {
    const type = text(item.type, "unknown");
    const wrapper = document.createElement("article");
    wrapper.className = "message";
    wrapper.dataset.itemId = text(item.id);
    if (type === "agentMessage" && options.commentary) {
      wrapper.classList.add("work-commentary");
      const label = document.createElement("span");
      label.className = "sr-only";
      i18n.text(label, () => t("Codex 工作过程说明"));
      const body = document.createElement("div");
      body.className = "message-body";
      appendSafeMarkdown(body, text(item.text, ""));
      wrapper.append(label, body);
      return wrapper;
    }
    if (type === "userMessage" || type === "agentMessage") {
      const isUser = type === "userMessage";
      wrapper.classList.add(isUser ? "user" : "agent");
      const label = document.createElement("span");
      label.className = "sr-only";
      i18n.text(label, () => isUser ? t("你发送的消息") : t("Codex 回复"));
      const body = document.createElement("div");
      body.className = "message-body";
      appendSafeMarkdown(body, text(item.text, ""));
      wrapper.append(label, body);
      return wrapper;
    }
    wrapper.className = "activity-item";
    const phase = text(item.phase);
    const summaryText = text(item.text, phase || (type === "activity" ? t("活动") : t`其他内容 · ${type}`));
    const summary = document.createElement("div");
    summary.className = "activity-summary";
    i18n.text(summary, () => summaryText);
    wrapper.append(summary);
    const detailText = displayDetail(item.detail);
    if (detailText) {
      const details = document.createElement("details");
      details.className = "activity-details";
      restoreDetailsState(details, `item:${state.selectedId}:${item.id}`);
      const detailSummary = document.createElement("summary");
      i18n.text(detailSummary, () => t("查看详情"));
      const body = document.createElement("pre");
      body.className = "activity-detail";
      body.textContent = detailText;
      details.append(detailSummary, body);
      wrapper.append(details);
    }
    return wrapper;
  }

  function restoreDetailsState(details, key) {
    details.dataset.openKey = key;
    details.open = state.openDetails.get(key) === true;
    details.addEventListener("toggle", () => state.openDetails.set(key, details.open));
  }

  function renderTurn(turn) {
    const section = document.createElement("section");
    section.className = "turn";
    section.dataset.turnId = text(turn.id);
    let workIndex = 0;
    for (const block of buildTurnBlocks(turn)) {
      if (block.type === "user") section.append(elementFromItem(block.item));
      else if (block.type === "final") section.append(elementFromItem(block.item));
      else if (block.type === "work") {
        const key = `work:${state.selectedId}:${turn.id}:${workIndex++}`;
        const details = document.createElement("details");
        details.className = "work-process";
        details.dataset.turnId = text(turn.id);
        details.dataset.summaryEligible = String(block.summaryEligible === true);
        restoreDetailsState(details, key);
        const summary = document.createElement("summary");
        i18n.text(summary, () => formatWorkSummary(turn, block, t));
        const content = document.createElement("div");
        content.className = "work-process-content";
        for (const item of block.items) {
          content.append(elementFromItem(item, { commentary: item.type === "agentMessage" }));
        }
        details.append(summary, content);
        section.append(details);
      }
    }
    return section;
  }

  function renderOptimisticMessage(message) {
    const wrapper = document.createElement("article");
    wrapper.className = "message user message-pending";
    wrapper.dataset.requestId = message.requestId;
    wrapper.dataset.state = message.state;
    const body = document.createElement("div");
    body.className = "message-body";
    appendSafeMarkdown(body, message.prompt);
    const receipt = document.createElement("span");
    receipt.className = "message-receipt";
    i18n.text(receipt, () => message.state === "sending" ? t("发送中…")
      : message.state === "unknown" ? t("送达状态未知 · 页面不会重发")
        : t("桌面已接收 · 等待同步"));
    wrapper.append(body, receipt);
    return wrapper;
  }

  function renderTranscript(shouldScroll = false, showNewMessages = false) {
    const anchor = shouldScroll ? null : transcriptAnchor(ui.transcript);
    for (const details of ui.transcript.querySelectorAll("details[data-open-key]")) {
      state.openDetails.set(details.dataset.openKey, details.open);
    }
    const turns = [...state.turns.values()].sort((a, b) => {
      const left = timestampMs(a.startedAt);
      const right = timestampMs(b.startedAt);
      return left - right;
    });
    const fragment = document.createDocumentFragment();
    fragment.append(ui.olderRow);
    for (const turn of turns) fragment.append(renderTurn(turn));
    for (const message of state.pendingMessages) if (!message.observed) fragment.append(renderOptimisticMessage(message));
    ui.transcript.replaceChildren(fragment);
    if (!turns.length && !state.pendingMessages.length && !state.selectedId) ui.transcript.append(ui.welcome);
    if (shouldScroll) {
      ui.transcript.scrollTop = ui.transcript.scrollHeight;
      ui.newMessages.hidden = true;
    } else {
      restoreTranscriptAnchor(ui.transcript, anchor);
      if (showNewMessages) ui.newMessages.hidden = false;
    }
  }

  function updateWorkSummaries() {
    for (const details of ui.transcript.querySelectorAll("details.work-process[data-turn-id]")) {
      const turn = state.turns.get(details.dataset.turnId);
      const summary = details.querySelector(":scope > summary");
      if (turn && summary) i18n.text(summary, () => formatWorkSummary(turn, { type: "work", summaryEligible: details.dataset.summaryEligible === "true" }, t));
    }
  }

  function timestampMs(value) {
    if (typeof value === "number" && Number.isFinite(value)) return Math.abs(value) < 1e12 ? value * 1000 : value;
    const stringValue = text(value);
    if (/^-?\d+(?:\.\d+)?$/.test(stringValue)) {
      const numeric = Number(stringValue);
      return Math.abs(numeric) < 1e12 ? numeric * 1000 : numeric;
    }
    return Date.parse(stringValue) || 0;
  }

  function mergeTurns(turns, latest = true) {
    if (!Array.isArray(turns)) return false;
    const merged = mergeTranscriptTurns([...state.turns.values()], turns, { latest });
    const changed = JSON.stringify([...state.turns.values()]) !== JSON.stringify(merged);
    state.turns = new Map(merged.map(turn => [text(turn.id), turn]));
    return changed;
  }

  function setThreadLoading(message = "", retry = false) {
    ui.threadLoadState.hidden = !message;
    i18n.text(ui.threadLoadText, () => t(message));
    ui.retryThread.hidden = !retry;
  }

  function saveThreadSnapshot(id = state.selectedId) {
    if (!id || id !== state.selectedId) return;
    state.threadCache.save(id, {
      thread: state.thread,
      turns: [...state.turns.values()],
      cursor: state.cursor,
      hasMore: state.hasMore,
      scrollTop: ui.transcript.scrollTop,
      readAt: Date.now(),
      canSend: state.canSend,
      sendMode: state.sendMode,
      sendDisabledReason: state.sendDisabledReason,
      pendingMessages: state.pendingMessages
    });
    storePendingMessages(id, state.pendingMessages);
  }

  function restoreThreadSnapshot(id) {
    const cached = state.threadCache.restore(id);
    if (!cached) {
      state.turns.clear();
      state.pendingMessages = readPendingMessages(id);
      return null;
    }
    state.thread = cached.thread || state.thread;
    state.turns = new Map(cached.turns.map(turn => [text(turn.id), turn]));
    state.cursor = cached.cursor ?? null;
    state.hasMore = !!cached.hasMore;
    state.pagingInitialized = true;
    state.canSend = !!cached.canSend;
    state.sendMode = cached.sendMode || "message";
    state.sendDisabledReason = cached.sendDisabledReason || "";
    state.pendingMessages = readPendingMessages(id);
    ui.transcript.scrollTop = cached.scrollTop || 0;
    return cached;
  }

  function baselineMessageKeys() {
    return [...state.turns.values()].flatMap(turn => (turn.items || [])
      .filter(item => item.type === "userMessage")
      .map(item => `${turn.id}\u001f${item.id ?? ""}`));
  }

  function updatePaging(page) {
    state.hasMore = !!page?.hasMore;
    if (page && Object.prototype.hasOwnProperty.call(page, "nextCursor")) state.cursor = page.nextCursor;
    updateHistoryControl();
  }

  function updateHistoryControl() {
    ui.olderButton.hidden = !state.hasMore || !state.selectedId;
    ui.olderRow.hidden = !state.selectedId || (!state.hasMore && !state.turns.size);
    ui.olderButton.disabled = state.loadingOlder || !state.hasMore;
    i18n.text(ui.olderButton, () => state.loadingOlder ? t("读取中…") : state.historyError ? t("重试较早消息") : t("↑　较早的消息"));
    i18n.text(ui.historyState, () => state.loadingOlder ? "" : state.historyError ? t("读取失败") : state.hasMore ? "" : (state.turns.size ? t("已到最早消息") : ""));
  }

  async function loadThread({ id = state.selectedId, cursor = null, mode = "latest", token = state.switching, scroll = false, prefetchedData = null } = {}) {
    if (!id) return;
    state.readController?.abort();
    const controller = new AbortController();
    state.readController = controller;
    const query = cursor == null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const knownTurnIds = new Set(state.turns.keys());
    const wasPaged = state.pagingInitialized;
    const priorCursor = state.cursor;
    const priorHasMore = state.hasMore;
    if (mode === "latest" && !state.pagingInitialized) setThreadLoading(state.turns.size ? t("正在同步最新消息…") : t("正在读取会话…"));
    try {
      let data = prefetchedData || await api(`/api/threads/${encodeURIComponent(id)}${query}`, { signal: controller.signal });
      if (controller.signal.aborted || token !== state.switching || id !== state.selectedId) return;
      if (delegatedThread(data.thread)) {
        rememberAgents([data.thread]);
        state.selectedId = null;
        state.thread = null;
        const primaryId = preferredThreadId(state.statusSnapshot) || state.threads[0]?.id;
        if (primaryId) await selectThread(primaryId);
        void agentViewer.open({ threadId: id, name: data.thread.title, status: data.thread.status });
        return;
      }
      state.ordinaryIds.add(id.toLowerCase());
      if (mode === "latest") {
        const fingerprint = JSON.stringify(data);
        if (state.threadFingerprint !== fingerprint) state.changeRevision += 1;
        state.threadFingerprint = fingerprint;
      }
      if (data.thread) {
        state.thread = mergeReadThread(data.thread, state.threads);
        state.thread.canManage = data.canManage;
        state.thread.canArchive = data.canArchive;
        const listedIndex = state.threads.findIndex(item => item.id === id);
        if (listedIndex >= 0) state.threads[listedIndex] = mergeReadThread(state.thread, [state.threads[listedIndex]]);
        else state.threads.unshift(state.thread);
      }
      state.canSend = typeof data.canSend === "boolean" ? data.canSend : !!data.thread?.canSend;
      state.sendMode = data.sendMode || data.thread?.sendMode || "message";
      state.sendDisabledReason = text(data.sendDisabledReason ?? data.thread?.sendDisabledReason);
      let contentChanged = mergeTurns(data.turns, mode === "latest");
      if (contentChanged) state.changeRevision += 1;
      const priorPendingCount = state.pendingMessages.length;
      reconcilePendingMessages(id);
      if (mode === "latest") {
        updatePaging(data.page || {});
        state.pagingInitialized = true;
        let overlap = (data.turns || []).some(turn => knownTurnIds.has(text(turn.id)));
        let gapPages = 0;
        while (wasPaged && knownTurnIds.size && !overlap && state.hasMore && state.cursor != null && gapPages < 3) {
          const older = await api(`/api/threads/${encodeURIComponent(id)}?cursor=${encodeURIComponent(state.cursor)}`, { signal: controller.signal });
          if (controller.signal.aborted || token !== state.switching || id !== state.selectedId) return;
          contentChanged = mergeTurns(older.turns, false) || contentChanged;
          reconcilePendingMessages(id);
          overlap = (older.turns || []).some(turn => knownTurnIds.has(text(turn.id)));
          updatePaging(older.page || {});
          gapPages += 1;
        }
        // Only resume the old history boundary after bridging the entire gap.
        // Otherwise keep the catch-up cursor so manual loading can fill it.
        if (wasPaged && overlap) updatePaging({ nextCursor: priorCursor, hasMore: priorHasMore });
        if (wasPaged && knownTurnIds.size && !overlap && state.hasMore) i18n.text(ui.historyState, () => t("更早的记录尚未完全载入"));
      } else if (mode === "older") {
        state.historyError = false;
        updatePaging(data.page || {});
      }
      setConnection(true);
      renderThreadHeader();
      if (contentChanged || state.pendingMessages.length || priorPendingCount !== state.pendingMessages.length) renderTranscript(scroll, mode === "latest" && !scroll && contentChanged);
      else updateWorkSummaries();
      setThreadLoading("");
      saveThreadSnapshot(id);
      if (isUnknown(id)) showUnknownNotice(id);
      else if (!ui.notice.hidden && ui.notice.dataset.kind === "error") showNotice("");
      renderTasks();
      updateControls();
      if (mode === "latest" && document.visibilityState === "visible") {
        void recoverDeliveryReceipts(id);
        void contextPanel.refresh();
        void refreshExecution(id, token);
      }
      return true;
    } catch (error) {
      if (token !== state.switching || id !== state.selectedId) return;
      if (controller.signal.aborted || error.name === "AbortError") return;
      if (mode === "older") {
        state.historyError = true;
        updateHistoryControl();
        return false;
      }
      setConnection(false, null, error);
      updateControls();
      setThreadLoading(t("无法更新会话。最近读取的内容已保留。"), true);
      if (isUnknown(id)) showUnknownNotice(id);
      else showNotice(t`暂时无法更新对话快照：${t(error.message)}。已有内容和草稿仍保留。`, "error", 0, "connection");
    }
  }

  async function selectThread(id) {
    const selectionRequest = ++state.selecting;
    const pendingSelection = state.selectionController;
    if (id !== state.selectedId || pendingSelection) clearFollowupDraft();
    pendingSelection?.abort();
    state.selectionController = null;
    if (pendingSelection) updateControls();
    if (!id || id === state.selectedId) {
      setDrawer(false);
      if (pendingSelection && id === state.selectedId) await loadThread({ mode: "latest" });
      return;
    }
    const listed = state.threads.find(thread => thread.id === id);
    if (knownAgent(id) || delegatedThread(listed)) {
      rememberAgents([{ id }]);
      void agentViewer.open({ threadId: id, name: listed?.title, status: listed?.status });
      setDrawer(false);
      return;
    }
    // Sidebar metadata can omit child identity; confirm unread candidates before replacing the main chat.
    let prefetchedData = null;
    if (!state.ordinaryIds.has(id.toLowerCase())) {
      const controller = new AbortController();
      state.selectionController = controller;
      try { prefetchedData = await api(`/api/threads/${encodeURIComponent(id)}`, { signal: controller.signal }); }
      catch (error) {
        if (selectionRequest !== state.selecting || controller.signal.aborted || error.name === "AbortError") return;
        setConnection(false, null, error);
        showNotice(t`暂时无法读取会话：${t(error.message)}。已有内容和草稿仍保留。`, "error", 0, "connection");
        return;
      } finally { if (state.selectionController === controller) { state.selectionController = null; updateControls(); } }
      if (selectionRequest !== state.selecting || controller.signal.aborted) return;
      if (prefetchedData.thread?.id !== id) {
        showNotice(t("返回的会话与请求不匹配，已有内容和草稿仍保留。"), "error");
        return;
      }
      if (delegatedThread(prefetchedData.thread)) {
        rememberAgents([prefetchedData.thread]);
        if (!state.selectedId) {
          const primaryId = preferredThreadId(state.statusSnapshot) || state.threads[0]?.id;
          if (primaryId && primaryId !== id) await selectThread(primaryId);
        }
        void agentViewer.open({ threadId: id, name: prefetchedData.thread.title, status: prefetchedData.thread.status });
        return;
      }
    }
    if (state.selectedId) {
      state.taskDetailsOpen.set(state.selectedId, ui.details.open);
      saveDraft(state.selectedId, ui.input.value);
      saveThreadSnapshot(state.selectedId);
    }
    state.readController?.abort();
    state.switching += 1;
    state.selectedId = id;
    contextPanel.setThread(id);
    state.controlOpen = false;
    state.controlSeen = new Set();
    state.historyDismissed = "";
    state.historyFingerprint = "";
    try {
      state.controlOpen = sessionStorage.getItem(CONTROL_OPEN_PREFIX + id) === "true";
      const seen = JSON.parse(sessionStorage.getItem(CONTROL_SEEN_PREFIX + id) || "[]");
      if (Array.isArray(seen)) state.controlSeen = new Set(seen.filter(value => typeof value === "string"));
      state.historyDismissed = sessionStorage.getItem(HISTORY_DISMISSED_PREFIX + id) || "";
    } catch { /* New conversations start collapsed. */ }
    renderControlExpansion();
    state.idlePolls = 0;
    state.historyError = false;
    state.threadFingerprint = "";
    state.execution = null;
    state.controlUnavailable = false;
    state.controlRetry = false;
    for (const entry of state.pendingCards.values()) entry.card.remove();
    state.pendingCards.clear();
    ui.pendingRequests.replaceChildren();
    ui.historicalQuestions.hidden = true;
    ui.showHistory.hidden = true;
    ui.historicalQuestionsContent.replaceChildren();
    i18n.text(ui.controlSummary, () => "");
    ui.controlState.hidden = true;
    saveSelectedThread(id);
    state.taskListFingerprint = "";
    state.thread = state.threads.find((thread) => thread.id === id) || { id, title: t("读取中…"), status: "unknown" };
    const cached = restoreThreadSnapshot(id);
    if (!cached) {
      state.cursor = null;
      state.hasMore = false;
      state.pagingInitialized = false;
      state.canSend = false;
      state.sendDisabledReason = "";
      state.sendMode = "message";
    }
    ui.input.value = readDraft(id);
    autosizeInput();
    i18n.text(ui.historyState, () => "");
    ui.olderButton.hidden = true;
    ui.olderRow.hidden = true;
    ui.newMessages.hidden = true;
    setThreadLoading(cached ? t("正在同步最新消息…") : t("正在读取会话…"));
    refreshTaskNotice();
    renderTasks();
    renderThreadHeader();
    renderTranscript(false);
    updateHistoryControl();
    if (cached) ui.transcript.scrollTop = cached.scrollTop || 0;
    updateControls();
    setDrawer(false);
    await loadThread({ id, mode: "latest", token: state.switching, scroll: !cached, prefetchedData });
  }

  async function loadOlder() {
    if (!state.selectedId || !state.hasMore || state.loadingOlder || state.cursor == null) return;
    state.loadingOlder = true;
    updateHistoryControl();
    const id = state.selectedId;
    const cursor = state.cursor;
    const token = state.switching;
    try {
      await loadThread({ id, cursor, mode: "older", token });
    } finally {
      state.loadingOlder = false;
      updateHistoryControl();
    }
  }

  async function poll(force = false) {
    if (document.visibilityState !== "visible" || state.inFlight > 0 || state.loadingOlder || state.polling) return;
    state.polling = true;
    state.forcePoll = false;
    const revision = state.changeRevision;
    try {
      const now = Date.now();
      const statusInterval = state.statusSnapshot?.connected === false ? 6000 : STATUS_POLL_MS;
      if (force || !state.statusSnapshot || now - state.lastStatusAt >= statusInterval) {
        const status = await api("/api/status");
        state.lastStatusAt = Date.now();
        state.callerThreadId = status.callerThreadId || null;
        setConnection(!!status.connected, status);
        if (!state.connected) {
          const issue = connectionIssue(state.connectionFault);
          if (!isUnknown(state.selectedId)) showNotice(issue?.notice || t("桌面 Codex 暂时不可用。页面会保留最近内容并继续重试。"), "error", 0, "connection");
          return;
        }
        if (ui.notice.dataset.source === "connection") showNotice("");
      }
      if (!state.statusSnapshot?.connected || document.visibilityState !== "visible") return;
      if (!state.selectedId) {
        const preferred = preferredThreadId(state.statusSnapshot);
        if (preferred) await selectThread(preferred);
      }
      if (state.selectedId) {
        const nearBottom = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 100;
        await loadThread({ mode: "latest", scroll: nearBottom });
      }
      if (document.visibilityState === "visible" && (force || Date.now() - state.lastListAt >= LIST_POLL_MS)) await refreshTasks();
    } catch (error) {
      setConnection(false, null, error);
      updateControls();
      if (state.selectedId && isUnknown(state.selectedId)) showUnknownNotice(state.selectedId);
      else showNotice(t("本机桥接服务暂时不可用。页面会保留最近内容并继续重试。"), "error", 0, "connection");
    } finally {
      state.idlePolls = revision === state.changeRevision ? state.idlePolls + 1 : 0;
      state.polling = false;
      schedulePoll();
    }
  }

  function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    if (document.visibilityState !== "visible") return;
    const active = normalizeStatus(state.thread?.status).kind === "running" || /requires|waiting|approval|attention/i.test(text(state.thread?.status))
      || [...state.turns.values()].some(turn => normalizeStatus(turn.status).kind === "running");
    const pending = !!state.execution?.pendingRequestCount || state.pendingCards.size > 0 || state.sending || state.responding.size > 0 || state.pendingMessages.length > 0;
    const interval = delay ?? (state.forcePoll || state.controlRetry ? 3000 : syncPollDelay({ active, pending, unavailable: !state.connected, idlePolls: state.idlePolls }));
    state.pollTimer = setTimeout(async () => {
      await poll(state.forcePoll);
      if (!state.polling) schedulePoll();
    }, interval);
  }

  function wakeSync() {
    state.idlePolls = 0;
    state.forcePoll = true;
    schedulePoll(0);
  }

  function autosizeInput() {
    const computed = window.getComputedStyle(ui.input);
    const lineHeight = Number.parseFloat(computed.lineHeight) || Number.parseFloat(computed.fontSize) * 1.45 || 24;
    const padding = Math.max(0, (44 - lineHeight) / 2);
    ui.input.style.setProperty("--composer-padding", `${padding}px`);
    ui.input.style.height = "auto";
    const singleLineHeight = Math.max(44, lineHeight);
    const contentHeight = ui.input.value ? Math.max(singleLineHeight, ui.input.scrollHeight) : singleLineHeight;
    ui.input.closest(".composer-input-row").dataset.multiline = String(contentHeight > singleLineHeight + 2);
    ui.input.style.height = `${Math.min(contentHeight, 180)}px`;
    if (state.selectedId) saveDraft(state.selectedId, ui.input.value);
    updateControls();
  }

  function clearFollowupDraft() {
    state.followupDraft = null;
    i18n.text(followupUI.preview, () => "");
    if (followupUI.dialog.open) followupUI.dialog.close();
  }

  function fillFollowupDraft(prompt, append = false) {
    if (state.sessionExpired || state.selectionController || !state.selectedId || ui.input.disabled || typeof prompt !== "string" || !prompt.trim()) return;
    const current = ui.input.value;
    const next = append && current.trim() ? `${current}\n\n${prompt}` : prompt;
    if (next.length > ui.input.maxLength) { showNotice(t("建议加入后超过消息长度上限，原草稿已保留。"), "error"); return; }
    ui.input.value = next;
    autosizeInput();
    ui.input.focus();
    ui.input.setSelectionRange(next.length, next.length);
  }

  function openFollowupDraft(button) {
    const prompt = button?.dataset.codexFollowup;
    if (state.sessionExpired || state.selectionController || !state.selectedId || ui.input.disabled || typeof prompt !== "string" || !prompt.trim()) return;
    if (!ui.input.value.trim()) { fillFollowupDraft(prompt); return; }
    if (ui.input.value.trim() === prompt.trim()) { ui.input.focus(); return; }
    state.followupDraft = { threadId: state.selectedId, prompt };
    followupUI.preview.textContent = prompt;
    followupUI.dialog.showModal();
  }

  function updatePendingMessage(threadId, requestId, change) {
    const pending = [...(state.pendingByThread.get(threadId) || (threadId === state.selectedId ? state.pendingMessages : []))];
    const index = pending.findIndex(message => message.requestId === requestId);
    if (index >= 0) {
      const next = change(pending[index]);
      if (next) pending[index] = next;
      else pending.splice(index, 1);
    }
    storePendingMessages(threadId, pending);
    if (threadId === state.selectedId) {
      state.pendingMessages = pending;
      renderTranscript(false);
      saveThreadSnapshot(threadId);
    }
  }

  async function sendMessage(event) {
    event.preventDefault();
    const id = state.selectedId;
    const draftPrompt = ui.input.value.trim();
    const attachments = uploads.status(id);
    if (attachments.blocked || (!draftPrompt && !attachments.count) || state.stopping) return;
    if (state.selectionController || !maySendSelected() || !id || !state.connected || !state.canSend || isUnknown(id) || state.sending) return;
    const revision = draftRevision(id);
    const selection = state.sendMode === "follow-up" ? {} : { ...readModelSettings(id) };
    try { Object.assign(selection, contextPanel.sendOverride()); }
    catch (error) { showNotice(error.message, "error"); return; }
    state.sending = true;
    updateControls();
    const attachmentSnapshot = uploads.status(id).count ? await uploads.prepare(id, draftPrompt) : uploads.snapshot(id, draftPrompt);
    const prompt = attachmentSnapshot?.prompt;
    if (!attachmentSnapshot || !prompt || prompt.length > 12000 || state.selectionController || state.selectedId !== id || !maySendSelected() || !state.connected || !state.canSend || isUnknown(id)) {
      state.sending = false; updateControls();
      showNotice(t("附件尚未就绪、会话已变化或消息过长，请核对后发送。"), "error"); return;
    }
    const requestId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const pending = [...(state.pendingByThread.get(id) || [])];
    const message = { requestId, prompt, draftPrompt, selection, attachmentIds: attachmentSnapshot.attachmentIds, draftRevision: revision, baselineKeys: baselineMessageKeys(), state: "sending" };
    pending.push(message);
    const saved = storePendingMessages(id, pending);
    // Persist the uncertainty marker before dispatch, including a page reload
    // while the POST is still in flight. The click is already guarded above.
    const marked = markUnknown(id);
    if (!saved || !marked) {
      storePendingMessages(id, pending.filter(item => item.requestId !== requestId));
      clearUnknown(id);
      state.sending = false;
      showNotice(t("浏览器无法保存发送恢复记录，消息尚未发送。请释放本站存储空间或允许会话存储后重试；草稿仍在输入框中。"), "error");
      updateControls();
      return;
    }
    if (id === state.selectedId) {
      state.pendingMessages = pending;
      renderTranscript(ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 100);
    }
    try {
      const result = await api(`/api/threads/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        body: JSON.stringify({ prompt, requestId, ...selection })
      });
      if (result.accepted !== true) {
        const error = new Error(t("桥接没有确认接收这条消息"));
        error.code = "DELIVERY_UNKNOWN";
        throw error;
      }
      updatePendingMessage(id, requestId, message => ({ ...message, state: "accepted" }));
      clearUnknown(id);
      clearSentDraft(id, message);
      if (id === state.selectedId) await loadThread({ mode: "latest", scroll: true });
      if (id === state.selectedId) showNotice(t("桌面已接收消息"), "info", 5000);
    } catch (error) {
      if (deliveryIsUnknown(error)) {
        markUnknown(id);
        updatePendingMessage(id, requestId, message => ({ ...message, state: "unknown" }));
        if (id === state.selectedId) showUnknownNotice(id);
        void recoverDeliveryReceipts(id, true);
      }
      else {
        updatePendingMessage(id, requestId, () => null);
        clearUnknown(id);
        if (id === state.selectedId) showNotice(t`消息未能发送：${t(error.message)}。输入内容已保留。`, "error");
      }
    } finally {
      state.sending = false;
      updateControls();
    }
  }

  function setFontSize(next) {
    const minimum = Number(ui.fontRange.min);
    const maximum = Number(ui.fontRange.max);
    const size = Number.isFinite(Number(next)) ? Math.max(minimum, Math.min(maximum, Math.round(Number(next)))) : 20;
    const scroller = ui.transcript;
    const top = scroller.getBoundingClientRect().top;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    const anchor = [...scroller.children].find(el => el.getBoundingClientRect().bottom > top);
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    document.documentElement.style.setProperty("--font-size", `${size}px`);
    i18n.text(ui.fontSizeValue, () => String(size));
    ui.fontRange.value = String(size);
    ui.fontReadout.value = `${size} px`;
    ui.fontDecrease.disabled = size === minimum;
    ui.fontIncrease.disabled = size === maximum;
    i18n.attr(ui.fontControl, "aria-label", () => t`调整字体大小，当前 ${size} 像素`);
    autosizeInput();
    // Keep the same visible message when changing size, or follow the end if already there.
    scroller.scrollTo({ top: atBottom ? scroller.scrollHeight : scroller.scrollTop + (anchor ? anchor.getBoundingClientRect().top - top - offset : 0), behavior: "instant" });
    try { localStorage.setItem("codex-mobile-font-size", String(size)); } catch { /* Font size still works for this page. */ }
  }

  function init() {
    ui.transcript.addEventListener("click", event => {
      const button = event.target.closest?.("button.markdown-followup[data-codex-followup]");
      if (button && ui.transcript.contains(button) && !button.disabled) openFollowupDraft(button);
    });
    followupUI.cancel.addEventListener("click", () => followupUI.dialog.close());
    followupUI.append.addEventListener("click", () => {
      const suggestion = state.followupDraft;
      followupUI.dialog.close();
      if (suggestion?.threadId === state.selectedId) fillFollowupDraft(suggestion.prompt, true);
    });
    followupUI.dialog.addEventListener("close", () => { if (!followupUI.dialog.open) clearFollowupDraft(); });
    ui.controlToggle.addEventListener("click", () => setControlExpansion(!state.controlOpen));
    ui.closePending.addEventListener("click", () => setControlExpansion(false));
    ui.closeHistory.addEventListener("click", () => {
      state.historyDismissed = state.historyFingerprint;
      try { sessionStorage.setItem(HISTORY_DISMISSED_PREFIX + state.selectedId, state.historyDismissed); } catch { /* Hide still applies to this page. */ }
      ui.historicalQuestions.hidden = true; ui.showHistory.hidden = false; ui.showHistory.focus();
    });
    ui.showHistory.addEventListener("click", () => {
      state.historyDismissed = "";
      try { sessionStorage.removeItem(HISTORY_DISMISSED_PREFIX + state.selectedId); } catch { /* The current disclosure remains usable. */ }
      ui.historicalQuestions.hidden = false; ui.showHistory.hidden = true; ui.closeHistory.focus();
    });
    modelUI.button.addEventListener("click", () => { populateModelControls("send"); renderModelSettings(); modelUI.dialog.showModal(); });
    $("modelSettingsDone").addEventListener("click", () => modelUI.dialog.close());
    modelUI.model.addEventListener("change", () => saveModelControls("send", true));
    modelUI.thinking.addEventListener("change", () => saveModelControls("send"));
    modelUI.permission.addEventListener("change", renderModelSettings);
    modelUI.createModel.addEventListener("change", () => saveModelControls("create", true));
    modelUI.createThinking.addEventListener("change", () => saveModelControls("create"));
    populateModelControls("create");
    ui.details.addEventListener("toggle", () => {
      if (ui.details.dataset.threadId === state.selectedId) state.taskDetailsOpen.set(state.selectedId, ui.details.open);
    });
    restoreCreateState();
    const stored = Number(localValue("codex-mobile-font-size"));
    setFontSize(Number.isFinite(stored) && stored >= Number(ui.fontRange.min) && stored <= Number(ui.fontRange.max) ? stored : 20);
    ui.menuButton.addEventListener("click", () => setDrawer(true));
    ui.closeDrawer.addEventListener("click", () => setDrawer(false));
    ui.scrim.addEventListener("click", () => setDrawer(false));
    ui.drawerMoreButton.addEventListener("click", () => { if (!ui.drawerMore.open) ui.drawerMore.showModal(); });
    ui.drawerMoreClose.addEventListener("click", () => ui.drawerMore.close());
    ui.drawerMore.addEventListener("click", event => { if (event.target === ui.drawerMore) ui.drawerMore.close(); });
    ui.refreshButton.addEventListener("click", wakeSync);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") wakeSync(); else clearTimeout(state.pollTimer); });
    window.addEventListener("online", wakeSync);
    window.addEventListener("bridge-device-state-changed", event => {
      if (deviceScope.id && typeof event.detail?.online === "boolean") deviceScope.context.device.online = event.detail.online;
      if (event.detail?.online === false) setConnection(false);
      if (typeof event.detail?.online === "boolean") renderDeviceIdentity(event.detail.online);
      wakeSync();
    });
    window.addEventListener("focus", wakeSync);
    ui.refreshControl.addEventListener("click", () => { if (state.selectedId) void refreshExecution(state.selectedId); });
    ui.refreshTasks.addEventListener("click", () => { void refreshTasks({ preserveOnError: false }); });
    ui.sortToggle.addEventListener("click", () => {
      if (ui.taskSearch.value.trim()) return;
      state.sorting = !state.sorting;
      state.taskListFingerprint = "";
      renderTasks();
    });
    ui.resetOrder.addEventListener("click", () => { void resetSidebarOrder(); });
    ui.taskSearch.addEventListener("input", () => { state.taskListFingerprint = ""; renderTasks(); });
    ui.olderButton.addEventListener("click", () => { void loadOlder(); });
    ui.retryThread.addEventListener("click", () => { if (state.selectedId) void loadThread({ mode: "latest" }); });
    ui.newMessages.addEventListener("click", () => {
      ui.transcript.scrollTop = ui.transcript.scrollHeight;
      ui.newMessages.hidden = true;
    });
    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", finishPointerDrag);
    document.addEventListener("pointercancel", finishPointerDrag);
    ui.composer.addEventListener("submit", sendMessage);
    ui.stop.addEventListener("click", () => { void stopExecution(); });
    ui.actionForm.addEventListener("submit", submitThreadAction);
    ui.actionCancel.addEventListener("click", () => ui.actionDialog.close());
    ui.actionDialog.addEventListener("cancel", event => { if (state.managing) event.preventDefault(); });
    ui.newThreadButton.addEventListener("click", openNewThreadDialog);
    ui.createCancel.addEventListener("click", closeNewThreadDialog);
    ui.createClose.addEventListener("click", closeNewThreadDialog);
    ui.createDialog.addEventListener("cancel", () => saveCreateDraftFromForm());
    ui.createProject.addEventListener("change", () => { renderProjectDetail(); saveCreateDraftFromForm(); });
    ui.createName.addEventListener("input", saveCreateDraftFromForm);
    ui.createPrompt.addEventListener("input", saveCreateDraftFromForm);
    ui.retryProjects.addEventListener("click", () => { void loadProjects(); });
    ui.createForm.addEventListener("submit", event => { event.preventDefault(); void submitThreadCreation(); });
    ui.createRetry.addEventListener("click", () => { void submitThreadCreation(state.createAttempt); });
    ui.checkCreateReceipt.addEventListener("click", () => { void recoverThreadCreation(); });
    ui.enterCreatedFromDialog.addEventListener("click", () => { void enterCreatedThread(); });
    ui.enterCreatedThread.addEventListener("click", () => { void enterCreatedThread(); });
    ui.input.addEventListener("input", autosizeInput);
    ui.fontControl.addEventListener("click", () => ui.fontDialog.showModal());
    ui.fontDecrease.addEventListener("click", () => setFontSize(Number(ui.fontRange.value) - 1));
    ui.fontIncrease.addEventListener("click", () => setFontSize(Number(ui.fontRange.value) + 1));
    ui.fontRange.addEventListener("input", () => setFontSize(Number(ui.fontRange.value)));
    $("fontReset").addEventListener("click", () => setFontSize(20));
    $("fontClose").addEventListener("click", () => ui.fontDialog.close());
    $("fontDone").addEventListener("click", () => ui.fontDialog.close());
    setDrawer(false);
    populateProjectSelect();
    ui.createName.value = state.createDraft.title;
    ui.createPrompt.value = state.createDraft.prompt;
    renderCreateRecoveryState();
    updateCreateControls();
    window.addEventListener("resize", () => { if (window.matchMedia("(min-width: 760px)").matches) setDrawer(false); });
    void (async () => {
      try {
        const status = await api("/api/status");
        state.lastStatusAt = Date.now();
        state.callerThreadId = status.callerThreadId || null;
        setConnection(!!status.connected, status);
        if (!state.connected) {
          const issue = connectionIssue(state.connectionFault);
          showNotice(issue?.notice || t("正在等待桌面 Codex 连接。"), "error", 0, "connection");
          return;
        }
        if (state.createAttempt?.requestId) void recoverThreadCreation();
        const preferred = preferredThreadId(status);
        void refreshTasks({ selectIfEmpty: !preferred });
        if (preferred) void selectThread(preferred);
      } catch (error) {
        setConnection(false, null, error);
        renderTasks();
        showNotice(t("本机桥接服务暂时不可用。页面会保留最近内容并继续重试。"), "error", 0, "connection");
      } finally {
        schedulePoll();
      }
    })();
  }

  init();
})();
