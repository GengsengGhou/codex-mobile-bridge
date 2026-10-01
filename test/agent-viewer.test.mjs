import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createAgentViewer } from "../public/agent-viewer.js";

const A = "00000000-0000-0000-0000-000000000001";
const B = "00000000-0000-0000-0000-000000000002";
const tick = () => new Promise(resolve => setImmediate(resolve));

async function mount(t, api) {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1" });
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  t.after(() => dom.window.close());
  const { window } = dom;
  let returnFocus = null;
  const dialog = window.document.getElementById("agentViewer");
  dialog.showModal = () => { returnFocus = window.document.activeElement; dialog.setAttribute("open", ""); };
  dialog.close = () => {
    dialog.removeAttribute("open");
    dialog.dispatchEvent(new window.Event("close"));
    returnFocus?.focus();
  };
  const viewer = createAgentViewer({ document: window.document, window, api });
  return { window, doc: window.document, dialog, viewer };
}

function response(id, turns = [], page = {}) {
  return { thread: { id, title: "Child task", status: "running" }, turns, page: { hasMore: false, nextCursor: null, ...page } };
}

test("reads only the selected child history and renders normalized content safely", async t => {
  const calls = [];
  const ui = await mount(t, async (path, options) => {
    calls.push({ path, options });
    return response(A, [{ id: "turn-1", status: "completed", items: [
      { type: "userMessage", id: "u", text: "Question" },
      { type: "activity", id: "a", text: "Read files", detail: "<script>bad()</script>" },
      { type: "agentMessage", id: "c", phase: "commentary", text: "Working" },
      { type: "agentMessage", id: "f", phase: "final_answer", text: "[unsafe](javascript:alert(1)) [site](https://example.com) [file](<C:\\secret\\a.md:4>) <img src=x onerror=alert(1)>" },
    ] }]);
  });
  ui.doc.getElementById("taskSearch").value = "main thread search";
  const localBefore = [ui.window.localStorage.length, ui.window.sessionStorage.length];
  ui.viewer.open({ threadId: A, name: "A child with a deliberately long proposed title ".repeat(3), status: "completed" });
  await tick();
  assert.equal(ui.viewer.isOpen, true);
  assert.equal(ui.doc.getElementById("agentViewerTitle").textContent, "Child task");
  assert.equal(ui.doc.getElementById("agentViewerStatus").textContent, "状态 · 运行中");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, `/api/threads/${A}`);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.deepEqual([...ui.doc.querySelectorAll("#agentViewer .message-body")].map(node => node.textContent.includes("Question") ? "user" : node.textContent.includes("unsafe") ? "answer" : "work"), ["user", "work", "answer"]);
  assert.equal(ui.doc.querySelectorAll("#agentViewer script, #agentViewer img").length, 0);
  assert.equal(ui.doc.querySelectorAll("#agentViewer a[href^='javascript:']").length, 0);
  assert.equal(ui.doc.querySelectorAll("#agentViewer a[href^='https://']").length, 1);
  assert.equal(ui.doc.querySelectorAll("#agentViewer button[data-local-file]").length, 0);
  assert.equal(ui.doc.querySelector("#agentViewer .agent-viewer-file-reference").textContent, "file :4");
  assert.deepEqual([ui.window.localStorage.length, ui.window.sessionStorage.length], localBefore);
  assert.equal(ui.doc.getElementById("taskSearch").value, "main thread search");
});

test("older history uses the returned cursor, keeps newer overlapping turns, and appends unique turns", async t => {
  const calls = [];
  const ui = await mount(t, async path => {
    calls.push(path);
    if (calls.length === 1) return response(A, [{ id: "newer", startedAt: "2025-02-01T00:00:00Z", items: [{ type: "userMessage", text: "new page" }] }], { hasMore: true, nextCursor: "cursor +/?" });
    return response(A, [
      { id: "newer", startedAt: "2025-02-01T00:00:00Z", items: [{ type: "agentMessage", text: "stale older copy" }] },
      { id: "older", startedAt: "2025-01-01T00:00:00Z", items: [{ type: "agentMessage", text: "old page" }] },
    ]);
  });
  ui.viewer.open({ threadId: A });
  await tick();
  assert.equal(ui.doc.getElementById("agentViewerOlder").hidden, false);
  ui.doc.getElementById("agentViewerOlder").click();
  await tick();
  assert.equal(calls[1], `/api/threads/${A}?cursor=cursor%20%2B%2F%3F`);
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /old page/);
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /new page/);
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /stale older copy/);
  assert.equal(ui.doc.getElementById("agentViewerOlder").hidden, true);
});

test("refresh retains exhausted older history and its pagination boundary", async t => {
  let calls = 0;
  const ui = await mount(t, async () => {
    calls += 1;
    if (calls === 1) return response(A, [{ id: "newer", items: [{ type: "agentMessage", text: "newest v1" }] }], { hasMore: true, nextCursor: "older" });
    if (calls === 2) return response(A, [{ id: "older", items: [{ type: "agentMessage", text: "oldest history" }] }]);
    return response(A, [{ id: "newer", items: [{ type: "agentMessage", text: "newest v2" }] }], { hasMore: true, nextCursor: "refresh-boundary" });
  });
  ui.viewer.open({ threadId: A });
  await tick();
  ui.doc.getElementById("agentViewerOlder").click();
  await tick();
  assert.equal(ui.doc.getElementById("agentViewerOlder").hidden, true);
  ui.doc.getElementById("agentViewerRefresh").dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await tick();
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /oldest history/);
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /newest v2/);
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /newest v1/);
  assert.equal(ui.doc.getElementById("agentViewerOlder").hidden, true);
  assert.match(ui.doc.getElementById("agentViewerHistoryState").textContent, /已到最早消息/);
});

test("rerender keeps disclosure state, focused summary, and the visible turn anchor", async t => {
  let calls = 0;
  const ui = await mount(t, async path => {
    calls += 1;
    if (path.includes("cursor=")) return response(A, [{ id: "older", startedAt: "2025-01-01T00:00:00Z", items: [{ type: "agentMessage", text: "older turn" }] }]);
    return response(A, [{ id: "middle", startedAt: "2025-01-15T00:00:00Z", status: "completed", items: [
      { type: "activity", id: "activity", text: calls === 1 ? "work v1" : "work v2", detail: "tool details" },
      { type: "agentMessage", id: "comment", phase: "commentary", text: "working" },
      { type: "agentMessage", id: "final", phase: "final_answer", text: "done" },
    ] }], { hasMore: true, nextCursor: "older" });
  });
  const transcript = ui.doc.getElementById("agentViewerTranscript");
  transcript.getBoundingClientRect = () => ({ top: 0, bottom: 180 });
  ui.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === transcript) return { top: 0, bottom: 180 };
    if (this.classList?.contains("agent-viewer-turn")) {
      const index = [...transcript.querySelectorAll(".agent-viewer-turn")].indexOf(this);
      const top = index * 100 - transcript.scrollTop;
      return { top, bottom: top + 80 };
    }
    return { top: 0, bottom: 0 };
  };
  ui.viewer.open({ threadId: A });
  await tick();
  const work = ui.doc.querySelector(".work-process");
  work.open = true;
  work.dispatchEvent(new ui.window.Event("toggle"));
  const oldSummary = work.querySelector(":scope > summary");
  oldSummary.focus();
  ui.doc.getElementById("agentViewerOlder").click();
  await tick();
  assert.equal(transcript.scrollTop, 100);
  const afterPageSummary = ui.doc.querySelector(".work-process > summary");
  assert.equal(ui.doc.activeElement, afterPageSummary);
  assert.equal(ui.doc.querySelector(".work-process").open, true);
  ui.doc.getElementById("agentViewerRefresh").dispatchEvent(new ui.window.MouseEvent("click", { bubbles: true }));
  await tick();
  assert.equal(ui.doc.querySelector(".work-process").open, true);
  assert.equal(ui.doc.activeElement, ui.doc.querySelector(".work-process > summary"));
  assert.equal(transcript.scrollTop, 100);
});

test("a child switch fences a late response and closing aborts the active read", async t => {
  const pending = new Map();
  const ui = await mount(t, (path, options) => new Promise(resolve => pending.set(path, { resolve, signal: options.signal })));
  ui.doc.getElementById("taskSearch").focus();
  ui.viewer.open({ threadId: A, name: "First" });
  const first = pending.get(`/api/threads/${A}`);
  ui.viewer.open({ threadId: B, name: "Second" });
  const second = pending.get(`/api/threads/${B}`);
  assert.equal(first.signal.aborted, true);
  first.resolve(response(A, [{ id: "wrong", items: [{ type: "agentMessage", text: "stale content" }] }]));
  second.resolve(response(B, [{ id: "current", items: [{ type: "agentMessage", text: "current content" }] }]));
  await tick();
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /current content/);
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /stale content/);
  ui.viewer.close();
  assert.equal(ui.viewer.isOpen, false);
  assert.equal(ui.doc.activeElement.id, "taskSearch");
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /current content/);
});

test("older read errors retry the same cursor and mismatched IDs leave history recoverable", async t => {
  const calls = [];
  const ui = await mount(t, async path => {
    calls.push(path);
    if (calls.length === 1) return response(A, [{ id: "newer", items: [{ type: "agentMessage", text: "kept history" }] }], { hasMore: true, nextCursor: "older-cursor" });
    if (calls.length === 2) throw new Error("temporary failure");
    if (calls.length === 3) return response(B, []);
    return response(A, [{ id: "older", items: [{ type: "agentMessage", text: "recovered older page" }] }]);
  });
  ui.viewer.open({ threadId: A, name: "Named child" });
  await tick();
  ui.doc.getElementById("agentViewerOlder").click();
  await tick();
  assert.match(ui.doc.getElementById("agentViewerErrorText").textContent, /temporary failure/);
  ui.doc.getElementById("agentViewerRetry").click();
  await tick();
  assert.equal(ui.doc.getElementById("agentViewerError").hidden, false);
  assert.match(ui.doc.getElementById("agentViewerErrorText").textContent, /不匹配/);
  assert.equal(ui.doc.getElementById("agentViewerTitle").textContent, "Child task");
  assert.match(calls[1], /cursor=older-cursor/);
  ui.doc.getElementById("agentViewerRetry").click();
  await tick();
  assert.equal(calls[3], calls[1]);
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /kept history/);
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /recovered older page/);
});

test("logout closes the viewer, clears private DOM, aborts reads, and fences reopening", async t => {
  let calls = 0;
  let resolveRead;
  let refreshSignal;
  const ui = await mount(t, (path, options) => {
    calls += 1;
    if (calls === 1) return Promise.resolve(response(A, [{ id: "turn", items: [{ type: "agentMessage", text: "private child history" }] }]));
    refreshSignal = options.signal;
    return new Promise(resolve => { resolveRead = resolve; assert.equal(options.signal.aborted, false); });
  });
  ui.viewer.open({ threadId: A });
  await tick();
  assert.match(ui.doc.getElementById("agentViewerTranscript").textContent, /private child history/);
  ui.doc.getElementById("agentViewerRefresh").click();
  assert.ok(refreshSignal);
  ui.window.dispatchEvent(new ui.window.Event("bridge-login-required"));
  assert.equal(refreshSignal.aborted, true);
  assert.equal(ui.viewer.isOpen, false);
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /private child history/);
  assert.equal(ui.doc.getElementById("agentViewerTitle").textContent, "子智能体");
  resolveRead(response(A, [{ id: "late", items: [{ type: "agentMessage", text: "late private history" }] }]));
  await tick();
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /late private history/);
  assert.equal(ui.viewer.open({ threadId: B }), false);
  assert.equal(calls, 2);
});

test("Escape cancels and fences a late read", async t => {
  let resolveRead;
  let signal;
  const ui = await mount(t, (path, options) => {
    signal = options.signal;
    return new Promise(resolve => { resolveRead = resolve; });
  });
  ui.viewer.open({ threadId: A });
  ui.dialog.dispatchEvent(new ui.window.Event("cancel", { cancelable: true }));
  ui.dialog.close();
  assert.equal(signal.aborted, true);
  assert.equal(ui.viewer.isOpen, false);
  resolveRead(response(A, [{ id: "late", items: [{ type: "agentMessage", text: "late after Escape" }] }]));
  await tick();
  assert.doesNotMatch(ui.doc.getElementById("agentViewerTranscript").textContent, /late after Escape/);
});

test("agent lifecycle statuses and unknown values always use Chinese labels", async t => {
  const ui = await mount(t, () => new Promise(() => {}));
  const statuses = [
    ["errored", "失败"], ["pendingInit", "等待初始化"], ["notLoaded", "尚未载入"],
    ["shutdown", "已关闭"], ["notFound", "未找到"], ["unknown-runtime-state", "状态未知"],
  ];
  for (const [value, expected] of statuses) {
    ui.viewer.open({ threadId: A, status: value });
    assert.equal(ui.doc.getElementById("agentViewerStatus").textContent, `状态 · ${expected}`);
    ui.viewer.close();
  }
});

test("UUID validation happens before opening or issuing a request", async t => {
  let calls = 0;
  const ui = await mount(t, async () => { calls += 1; return response(A); });
  assert.throws(() => ui.viewer.open({ threadId: "../main" }), /UUID/);
  assert.equal(ui.viewer.isOpen, false);
  assert.equal(calls, 0);
});

test("loading indicator remains connected when opening before history resolves", async t => {
  const ui = await mount(t, () => new Promise(() => {}));
  ui.viewer.open({ threadId: A });
  const empty = ui.doc.getElementById("agentViewerEmpty");
  assert.equal(empty.isConnected, true);
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent, /正在读取历史/);
});

test("closing restores focus to the refreshed context opener with the same key", async t => {
  const ui = await mount(t, () => new Promise(() => {}));
  const context = ui.doc.getElementById("threadContext");
  context.hidden = false;
  const content = ui.doc.getElementById("contextContent");
  const oldOpener = ui.doc.createElement("button");
  oldOpener.dataset.contextKey = `agent:${B}`;
  content.append(oldOpener);
  oldOpener.focus();
  ui.viewer.open({ threadId: B });
  const replacement = ui.doc.createElement("button");
  replacement.dataset.contextKey = `agent:${B}`;
  oldOpener.replaceWith(replacement);
  ui.viewer.close();
  assert.equal(ui.doc.activeElement, replacement);
});

test("focus falls back when the matching refreshed child is inside a closed disclosure", async t => {
  const ui = await mount(t, () => new Promise(() => {}));
  const context = ui.doc.getElementById("threadContext");
  context.hidden = false;
  const disclosure = ui.doc.createElement("details");
  disclosure.open = true;
  const summary = ui.doc.createElement("summary");
  summary.textContent = "已完成";
  const oldOpener = ui.doc.createElement("button");
  oldOpener.dataset.contextKey = `agent:${B}`;
  disclosure.append(summary, oldOpener);
  ui.doc.getElementById("contextContent").append(disclosure);
  oldOpener.focus();
  ui.viewer.open({ threadId: B });
  const replacement = ui.doc.createElement("button");
  replacement.dataset.contextKey = `agent:${B}`;
  oldOpener.replaceWith(replacement);
  disclosure.open = false;
  ui.viewer.close();
  assert.notEqual(ui.doc.activeElement, replacement);
  assert.equal(ui.doc.activeElement.id, "closeContext");
});

test("long titles remain fully available through the heading tooltip", async t => {
  const ui = await mount(t, () => new Promise(() => {}));
  const fullTitle = "Very long child task title with technical path " + "E:\\workspace\\nested-module\\".repeat(12);
  ui.viewer.open({ threadId: A, name: fullTitle });
  const heading = ui.doc.getElementById("agentViewerTitle");
  assert.equal(heading.textContent, fullTitle);
  assert.equal(heading.title, fullTitle);
});
