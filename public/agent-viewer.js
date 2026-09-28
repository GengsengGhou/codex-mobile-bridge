import { appendMarkdown } from "./markdown.js";
import { buildTurnBlocks, formatWorkSummary } from "./presentation.js";
import { mergeTranscriptTurns, transcriptAnchor, restoreTranscriptAnchor } from "./conversation-state.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS = new Map([
  ["running", "运行中"], ["active", "运行中"], ["inprogress", "运行中"], ["in_progress", "运行中"],
  ["completed", "已完成"], ["complete", "已完成"], ["done", "已完成"], ["finished", "已完成"],
  ["succeeded", "已完成"], ["success", "已完成"], ["failed", "失败"], ["error", "失败"], ["errored", "失败"],
  ["interrupted", "已中断"], ["cancelled", "已中断"], ["canceled", "已中断"], ["idle", "空闲"],
  ["pendinginit", "等待初始化"], ["pending_init", "等待初始化"], ["notloaded", "尚未载入"], ["not_loaded", "尚未载入"],
  ["shutdown", "已关闭"], ["notfound", "未找到"], ["not_found", "未找到"],
]);

function statusLabel(value) {
  const raw = typeof value === "string" ? value : typeof value?.type === "string" ? value.type : "unknown";
  const key = raw.toLowerCase().replace(/[ -]/g, "_");
  return STATUS.get(key) || "状态未知";
}

function detailText(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function renderItem(item, document, turnId, openDisclosures) {
  const article = document.createElement("article");
  article.className = "message";
  if (item.type === "userMessage" || item.type === "agentMessage") {
    const user = item.type === "userMessage";
    article.classList.add(user ? "user" : "agent");
    const body = document.createElement("div");
    body.className = "message-body";
    appendMarkdown(body, typeof item.text === "string" ? item.text : "", document);
    // Local file controls belong to the main conversation's file panel. Keep their labels readable here.
    for (const button of body.querySelectorAll("button[data-local-file]")) {
      const label = document.createElement("span");
      label.className = "agent-viewer-file-reference";
      label.append(...button.childNodes);
      button.replaceWith(label);
    }
    article.append(body);
    return article;
  }

  article.className = "activity-item";
  const summary = document.createElement("div");
  summary.className = "activity-summary";
  summary.textContent = typeof item.text === "string" ? item.text : "活动";
  article.append(summary);
  const detail = detailText(item.detail);
  if (detail) {
    const details = document.createElement("details");
    details.className = "activity-details";
    const disclosureKey = `activity:${turnId}:${item.id ?? ""}`;
    details.dataset.viewerDisclosureKey = disclosureKey;
    details.open = openDisclosures.get(disclosureKey) === true;
    details.addEventListener("toggle", () => openDisclosures.set(disclosureKey, details.open));
    const heading = document.createElement("summary");
    heading.textContent = "查看详情";
    heading.dataset.viewerDisclosureKey = disclosureKey;
    const pre = document.createElement("pre");
    pre.className = "activity-detail";
    pre.textContent = detail;
    details.append(heading, pre);
    article.append(details);
  }
  return article;
}

function renderTurn(turn, document, openDisclosures) {
  const section = document.createElement("section");
  section.className = "turn agent-viewer-turn";
  section.dataset.turnId = String(turn.id ?? "");
  let workIndex = 0;
  for (const block of buildTurnBlocks(turn)) {
    if (block.type === "user" || block.type === "final") section.append(renderItem(block.item, document, turn.id, openDisclosures));
    else if (block.type === "work") {
      const details = document.createElement("details");
      details.className = "work-process";
      const disclosureKey = `work:${turn.id}:${workIndex++}`;
      details.dataset.viewerDisclosureKey = disclosureKey;
      details.open = openDisclosures.get(disclosureKey) === true;
      details.addEventListener("toggle", () => openDisclosures.set(disclosureKey, details.open));
      const summary = document.createElement("summary");
      summary.textContent = formatWorkSummary(turn);
      summary.dataset.viewerDisclosureKey = disclosureKey;
      const content = document.createElement("div");
      content.className = "work-process-content";
      for (const item of block.items) content.append(renderItem(item, document, turn.id, openDisclosures));
      details.append(summary, content);
      section.append(details);
    }
  }
  return section;
}

export function createAgentViewer({ document, window, api }) {
  if (!document?.getElementById || !window || typeof api !== "function") throw new TypeError("document, window and api are required");
  const dialog = document.getElementById("agentViewer");
  const title = document.getElementById("agentViewerTitle");
  const status = document.getElementById("agentViewerStatus");
  const transcript = document.getElementById("agentViewerTranscript");
  const empty = document.getElementById("agentViewerEmpty");
  const older = document.getElementById("agentViewerOlder");
  const historyState = document.getElementById("agentViewerHistoryState");
  const error = document.getElementById("agentViewerError");
  const errorText = document.getElementById("agentViewerErrorText");
  const refresh = document.getElementById("agentViewerRefresh");
  const retry = document.getElementById("agentViewerRetry");
  const closeButton = document.getElementById("agentViewerClose");
  if (![dialog, title, status, transcript, empty, older, historyState, error, errorText, refresh, retry, closeButton].every(Boolean)) {
    throw new Error("Agent viewer dialog markup is incomplete");
  }

  let activeId = null;
  let currentName = "";
  let currentStatus = "unknown";
  let cursor = null;
  let hasMore = false;
  let loading = false;
  let failedOlderRead = false;
  let loginRequired = false;
  let generation = 0;
  let controller = null;
  let turns = new Map();
  const openDisclosures = new Map();
  let openerElement = null;
  let openerContextKey = "";

  const isOpen = () => dialog.open;
  const current = token => token === generation && isOpen();

  function updateHeader() {
    title.textContent = currentName || "子智能体";
    title.title = currentName || "子智能体";
    status.textContent = `状态 · ${statusLabel(currentStatus)}`;
  }

  function updatePaging() {
    older.hidden = !hasMore || !activeId;
    older.disabled = loading || !hasMore;
    older.textContent = loading ? "读取中…" : "↑　较早的消息";
    historyState.textContent = loading ? "" : hasMore ? "" : turns.size ? "已到最早消息" : "";
  }

  function render({ scrollToEnd = false } = {}) {
    for (const disclosure of transcript.querySelectorAll("details[data-viewer-disclosure-key]")) {
      openDisclosures.set(disclosure.dataset.viewerDisclosureKey, disclosure.open);
    }
    const activeDisclosureKey = document.activeElement?.dataset?.viewerDisclosureKey || "";
    const anchor = transcriptAnchor(transcript);
    const fragment = document.createDocumentFragment();
    const olderRow = transcript.querySelector(".agent-viewer-older-row");
    fragment.append(olderRow, empty);
    const ordered = [...turns.values()].sort((a, b) => {
      const left = Date.parse(a.startedAt) || Number(a.startedAt) || 0;
      const right = Date.parse(b.startedAt) || Number(b.startedAt) || 0;
      return left - right;
    });
    for (const turn of ordered) fragment.append(renderTurn(turn, document, openDisclosures));
    transcript.replaceChildren(fragment);
    empty.hidden = ordered.length > 0;
    if (!ordered.length && !loading && !error.hidden) empty.hidden = true;
    if (scrollToEnd) transcript.scrollTop = transcript.scrollHeight;
    else restoreTranscriptAnchor(transcript, anchor);
    if (activeDisclosureKey) {
      const nextSummary = [...transcript.querySelectorAll("summary[data-viewer-disclosure-key]")]
        .find(summary => summary.dataset.viewerDisclosureKey === activeDisclosureKey);
      nextSummary?.focus();
    }
  }

  function setError(message = "") {
    error.hidden = !message;
    errorText.textContent = message;
    if (message) empty.hidden = true;
  }

  function clearPrivateHistory() {
    turns = new Map();
    openDisclosures.clear();
    currentName = "";
    currentStatus = "unknown";
    cursor = null;
    hasMore = false;
    failedOlderRead = false;
    historyState.textContent = "";
    setError("");
    title.textContent = "子智能体";
    title.title = "子智能体";
    status.textContent = "状态 · 状态未知";
    empty.textContent = "";
    empty.hidden = true;
    const olderRow = transcript.querySelector(".agent-viewer-older-row");
    transcript.replaceChildren(olderRow, empty);
    older.hidden = true;
    older.disabled = false;
  }

  function restoreOpenerFocus() {
    const isVisible = element => {
      if (!element?.isConnected) return false;
      for (let parent = element; parent && parent !== document.documentElement; parent = parent.parentElement) {
        if (parent.hidden) return false;
        if (parent.tagName === "DETAILS" && !parent.open && !parent.querySelector(":scope > summary")?.contains(element)) return false;
      }
      return true;
    };
    const focus = element => {
      if (!isVisible(element)) return false;
      element.focus();
      return document.activeElement === element;
    };
    if (openerContextKey) {
      const replacement = [...document.querySelectorAll("[data-context-key]")]
        .find(element => element.dataset.contextKey === openerContextKey && element.isConnected);
      if (focus(replacement)) { openerElement = null; openerContextKey = ""; return; }
    }
    if (openerElement && openerElement !== document.body && openerElement.isConnected) {
      if (focus(openerElement)) { openerElement = null; openerContextKey = ""; return; }
    }
    const contextClose = document.getElementById("closeContext");
    const contextToggle = document.getElementById("contextToggle");
    if (!focus(contextClose)) focus(contextToggle);
    openerElement = null;
    openerContextKey = "";
  }

  function abortRead() {
    generation += 1;
    controller?.abort();
    controller = null;
    loading = false;
    activeId = null;
  }

  function requireLogin() {
    loginRequired = true;
    abortRead();
    if (dialog.open) dialog.close();
    clearPrivateHistory();
  }

  async function read({ olderPage = false } = {}) {
    if (!activeId || loading || olderPage && (!hasMore || cursor == null)) return;
    const id = activeId;
    const token = generation;
    const requestController = new AbortController();
    controller = requestController;
    loading = true;
    setError("");
    updatePaging();
    const query = olderPage ? `?cursor=${encodeURIComponent(cursor)}` : "";
    try {
      const data = await api(`/api/threads/${encodeURIComponent(id)}${query}`, { signal: requestController.signal });
      if (!current(token) || activeId !== id || requestController.signal.aborted) return;
      if (data?.thread?.id !== id || !Array.isArray(data.turns)) throw new Error("返回的会话历史与请求不匹配");
      const previousTurns = [...turns.values()];
      const previousCursor = cursor;
      const previousHasMore = hasMore;
      const overlap = data.turns.some(turn => turn?.id != null && turns.has(String(turn.id)));
      const merged = mergeTranscriptTurns(previousTurns, data.turns, { latest: !olderPage });
      turns = new Map(merged.map(turn => [String(turn.id), turn]));
      cursor = data.page?.nextCursor ?? null;
      hasMore = data.page?.hasMore === true;
      if (!olderPage && previousTurns.length && overlap) {
        cursor = previousCursor;
        hasMore = previousHasMore;
      }
      failedOlderRead = false;
      currentName = typeof data.thread.title === "string" && data.thread.title ? data.thread.title : currentName;
      currentStatus = data.thread.status ?? currentStatus;
      updateHeader();
      render({ scrollToEnd: !olderPage && previousTurns.length === 0 });
      if (!turns.size) empty.textContent = "暂无历史消息";
      setError("");
    } catch (cause) {
      if (!current(token) || requestController.signal.aborted || cause?.name === "AbortError") return;
      failedOlderRead = olderPage;
      setError(cause?.message || "读取子智能体历史失败");
    } finally {
      if (current(token) && controller === requestController) {
        loading = false;
        controller = null;
        updatePaging();
        empty.hidden = turns.size > 0 || !!errorText.textContent;
      }
    }
  }

  function open({ threadId, name = "", status: threadStatus = "unknown" } = {}) {
    if (loginRequired) return false;
    if (typeof threadId !== "string" || !UUID.test(threadId)) throw new TypeError("A valid thread UUID is required");
    if (!dialog.open) {
      openerElement = document.activeElement;
      openerContextKey = openerElement?.dataset?.contextKey || "";
    }
    generation += 1;
    controller?.abort();
    controller = null;
    loading = false;
    activeId = threadId;
    currentName = typeof name === "string" ? name : "";
    currentStatus = threadStatus;
    turns = new Map();
    openDisclosures.clear();
    failedOlderRead = false;
    cursor = null;
    hasMore = false;
    transcript.scrollTop = 0;
    empty.textContent = "正在读取历史…";
    historyState.textContent = "";
    setError("");
    updateHeader();
    render();
    older.hidden = true;
    if (!dialog.open) dialog.showModal();
    void read();
    return true;
  }

  function close() {
    abortRead();
    if (dialog.open) dialog.close();
    clearPrivateHistory();
  }

  refresh.addEventListener("click", () => void read());
  retry.addEventListener("click", () => void read({ olderPage: failedOlderRead }));
  older.addEventListener("click", () => void read({ olderPage: true }));
  closeButton.addEventListener("click", close);
  dialog.addEventListener("cancel", () => {
    abortRead();
  });
  dialog.addEventListener("close", () => {
    abortRead();
    clearPrivateHistory();
    restoreOpenerFocus();
  });
  window.addEventListener("bridge-login-required", requireLogin);

  return { open, close, get isOpen() { return isOpen(); } };
}
