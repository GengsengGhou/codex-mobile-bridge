import { createI18n } from "./i18n.js";
const TEXT_LIMIT = 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
const PDF_LIMIT = 30 * 1024 * 1024;
const DOWNLOAD_LIMIT = 100 * 1024 * 1024;

export function splitLocalReference(reference) {
  if (typeof reference !== "string" || reference.length > 4096) return null;
  let value = reference.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  if (!value || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  if (!(/^[a-z]:[\\/]/i.test(value) || value.startsWith("/") || value.startsWith("./") || value.startsWith("../") || !value.startsWith("#"))) return null;
  let line = "";
  value = value.replace(/#L(\d+)(?:-L?\d+)?$/i, (_match, number) => { line = `:${number}`; return ""; });
  value = value.replace(/:(\d+)(?::\d+)?$/, (_match, number) => { line = `:${number}`; return ""; });
  if (!value || value.includes("\0")) return null;
  return { path: value.replaceAll("\\", "/"), line };
}

export function createFilesPanel({ document: doc = globalThis.document, window: win = globalThis.window, fetchImpl = fetch, getThread = () => ({ id: "", cwd: "" }) } = {}) {
  const i18n = createI18n({ window: win, document: doc }), t = i18n.t;
  const document = doc;
  const URLApi = win.URL;
  const panel = document.getElementById("filesPanel");
  const openButton = document.getElementById("filesButton");
  const closeButton = document.getElementById("filesClose");
  const refreshButton = document.getElementById("filesRefresh");
  const backButton = document.getElementById("filesBack");
  const title = document.getElementById("filesTitle");
  const pathLabel = document.getElementById("filesPath");
  const stateLabel = document.getElementById("filesState");
  const entries = document.getElementById("filesEntries");
  const preview = document.getElementById("filesPreview");
  const downloadButton = document.getElementById("filesDownload");
  const content = document.getElementById("filesContent");
  const state = { threadId: "", cwd: "", path: "", controller: null, token: 0, objectUrl: "", metadata: null, downloadUrls: new Set() };

  function revokeObjectUrl() {
    if (state.objectUrl) URLApi.revokeObjectURL(state.objectUrl);
    state.objectUrl = "";
    preview.replaceChildren();
  }

  function invalidate() {
    state.token += 1;
    state.controller?.abort();
    state.controller = null;
    revokeObjectUrl();
  }

  function setThread(thread) {
    const id = typeof thread?.id === "string" ? thread.id : "";
    const cwd = typeof thread?.cwd === "string" ? thread.cwd : "";
    if (id === state.threadId) {
      if (cwd !== state.cwd) {
        invalidate();
        state.path = "";
        state.metadata = null;
        entries.replaceChildren();
        downloadButton.hidden = true;
        if (panel.open) panel.close();
      }
      state.cwd = cwd;
      return;
    }
    invalidate();
    state.threadId = id;
    state.cwd = cwd;
    state.path = "";
    state.metadata = null;
    i18n.text(stateLabel, () => "");
    entries.replaceChildren();
    downloadButton.hidden = true;
    if (panel.open) panel.close();
    openButton.disabled = !id;
  }

  function endpoint(kind, path, mode = "") {
    const base = `/api/threads/${encodeURIComponent(state.threadId)}/${kind}`;
    const query = new URLSearchParams();
    if (path) query.set("path", path);
    if (mode) query.set("mode", mode);
    return `${base}?${query}`;
  }

  async function request(path, { signal, bytes = false } = {}) {
    const options = { method: "GET", credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1" }, signal };
    let response = await fetchImpl(path, options);
    if (response.status === 401) {
      let body = {};
      try { body = await response.clone().json(); } catch { /* Non-JSON local authorization failures can refresh. */ }
      if (body.code === "LOGIN_REQUIRED") {
        win.dispatchEvent(new win.Event("bridge-login-required"));
        const error = new Error(t("请重新登录后继续")); error.code = "LOGIN_REQUIRED"; error.status = 401; throw error;
      }
      const refresh = await fetchImpl("/", options);
      if (refresh.ok) response = await fetchImpl(path, options);
    }
    if (!response.ok) {
      let message = t`请求失败（${response.status}）`;
      try { const body = await response.json(); if (typeof body.error === "string") message = body.error; } catch { /* Keep the status message. */ }
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return bytes ? response.blob() : response.json();
  }

  function showError(error) {
    if (error?.name === "AbortError") return;
    i18n.text(stateLabel, () => error?.status === 403 ? t("此文件不允许访问。") : error?.status === 404 ? t("文件或目录不存在。") : t(error?.message) || t("无法读取文件。"));
    stateLabel.dataset.kind = "error";
  }

  function beginRequest({ preservePreview = false } = {}) {
    state.token += 1;
    state.controller?.abort();
    state.controller = null;
    if (!preservePreview) revokeObjectUrl();
    const controller = new AbortController();
    state.controller = controller;
    return { controller, token: state.token };
  }

  function active(token, threadId) { return token === state.token && threadId === state.threadId && panel.open; }

  async function loadDirectory(path = state.path) {
    if (!state.threadId) return;
    const { controller, token } = beginRequest();
    const threadId = state.threadId;
    state.path = path;
    state.metadata = null;
    downloadButton.hidden = true;
    revokeObjectUrl();
    entries.replaceChildren();
    content.hidden = false;
    i18n.text(pathLabel, () => path || state.cwd || t("工作目录"));
    i18n.text(title, () => t("文件"));
    stateLabel.dataset.kind = "loading";
    i18n.text(stateLabel, () => t("正在读取…"));
    try {
      const result = await request(endpoint("files", path), { signal: controller.signal });
      if (!active(token, threadId)) return;
      state.path = result.path || "";
      i18n.text(pathLabel, () => state.path || state.cwd || t("工作目录"));
      backButton.disabled = result.parentPath == null;
      i18n.text(stateLabel, () => result.truncated ? t("目录较大，仅显示部分文件。") : result.entries.length ? "" : t("此目录为空。"));
      stateLabel.dataset.kind = "";
      for (const entry of result.entries) {
        const row = document.createElement("li");
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-entry";
        button.dataset.path = entry.path;
        button.dataset.type = entry.type;
        const name = document.createElement("span");
        name.className = "file-entry-name";
        name.textContent = entry.name;
        const detail = document.createElement("span");
        detail.className = "file-entry-detail";
        i18n.text(detail, () => entry.type === "directory" ? t("文件夹") : formatSize(entry.size));
        button.append(name, detail);
        row.append(button);
        entries.append(row);
      }
      state.truncated = result.truncated;
    } catch (error) {
      if (active(token, threadId)) showError(error);
    }
  }

  function formatSize(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes < 0) return t("文件");
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function parentDirectory() {
    if (!state.path) return "";
    const normalized = state.path.replaceAll("\\", "/").replace(/\/$/, "");
    const slash = normalized.lastIndexOf("/");
    return slash < 0 ? "" : normalized.slice(0, slash);
  }

  function showBlob(blob, metadata, token) {
    if (blob.size > limitFor(metadata.previewKind)) throw new Error(t("文件超过预览大小限制，请下载后查看。"));
    state.objectUrl = URLApi.createObjectURL(blob);
    if (metadata.previewKind === "image") {
      const image = document.createElement("img");
      image.className = "file-image-preview";
      image.alt = metadata.name;
      image.src = state.objectUrl;
      image.addEventListener("error", () => {
        if (token === state.token) i18n.text(stateLabel, () => t("图片无法预览，请下载文件后查看。"));
      }, { once: true });
      preview.append(image);
    } else if (metadata.previewKind === "pdf") {
      const frame = document.createElement("iframe");
      frame.className = "file-pdf-preview";
      i18n.attr(frame, "title", () => t`${metadata.name} 预览`);
      frame.setAttribute("sandbox", "");
      frame.src = state.objectUrl;
      preview.append(frame);
    }
    i18n.text(stateLabel, () => metadata.previewKind === "pdf" ? t("若 PDF 未显示，请使用“下载文件”。") : "");
    stateLabel.dataset.kind = "";
    if (token !== state.token) revokeObjectUrl();
  }

  function limitFor(kind) { return kind === "text" ? TEXT_LIMIT : kind === "image" ? IMAGE_LIMIT : kind === "pdf" ? PDF_LIMIT : DOWNLOAD_LIMIT; }

  async function openFile(path) {
    if (!state.threadId) return;
    const { controller, token } = beginRequest();
    const threadId = state.threadId;
    state.path = path;
    entries.replaceChildren();
    i18n.text(title, () => t("文件预览"));
    i18n.text(pathLabel, () => path);
    backButton.disabled = false;
    content.hidden = false;
    stateLabel.dataset.kind = "loading";
    i18n.text(stateLabel, () => t("正在读取文件信息…"));
    downloadButton.hidden = true;
    state.metadata = null;
    try {
      const metadata = await request(endpoint("file", path, "info"), { signal: controller.signal });
      if (!active(token, threadId)) return;
      state.metadata = metadata;
      state.path = metadata.path || path;
      backButton.disabled = false;
      i18n.text(title, () => metadata.name || t("文件预览"));
      i18n.text(pathLabel, () => metadata.path || path);
      downloadButton.hidden = false;
      if (!metadata.previewKind) {
        i18n.text(stateLabel, () => t("此格式无法预览。可下载文件后打开。"));
        stateLabel.dataset.kind = "";
        return;
      }
      const limit = limitFor(metadata.previewKind);
      if (Number(metadata.size) > limit) {
        i18n.text(stateLabel, () => t("文件超过预览大小限制。可下载后查看。"));
        stateLabel.dataset.kind = "";
        return;
      }
      i18n.text(stateLabel, () => t("正在载入预览…"));
      const blob = await request(endpoint("file", path, "preview"), { signal: controller.signal, bytes: true });
      if (!active(token, threadId)) return;
      if (metadata.previewKind === "text") {
        if (blob.size > TEXT_LIMIT) throw new Error(t("文本文件超过 1 MiB 预览限制，请下载后查看。"));
        const pre = document.createElement("pre");
        pre.className = "file-text-preview";
        pre.textContent = await blob.text();
        if (!active(token, threadId)) return;
        preview.replaceChildren(pre);
        i18n.text(stateLabel, () => "");
        stateLabel.dataset.kind = "";
      } else showBlob(blob, metadata, token);
    } catch (error) {
      if (active(token, threadId)) showError(error);
    }
  }

  async function download(path = state.metadata?.path || state.path) {
    if (!state.threadId || !path) return;
    const { controller, token } = beginRequest({ preservePreview: true });
    const threadId = state.threadId;
    stateLabel.dataset.kind = "loading";
    i18n.text(stateLabel, () => t("正在准备下载…"));
    try {
      const metadata = state.metadata?.path === path ? state.metadata : await request(endpoint("file", path, "info"), { signal: controller.signal });
      if (!active(token, threadId)) return;
      if (Number(metadata.size) > DOWNLOAD_LIMIT) throw new Error(t("文件超过 100 MiB 下载限制。"));
      const blob = await request(endpoint("file", path, "download"), { signal: controller.signal, bytes: true });
      if (!active(token, threadId)) return;
      if (blob.size > DOWNLOAD_LIMIT) throw new Error(t("文件超过 100 MiB 下载限制。"));
      const url = URLApi.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = metadata.name || "download";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      state.downloadUrls.add(url);
      win.setTimeout(() => { URLApi.revokeObjectURL(url); state.downloadUrls.delete(url); }, 60_000);
      i18n.text(stateLabel, () => t("下载已开始。"));
      stateLabel.dataset.kind = "";
    } catch (error) {
      if (active(token, threadId)) showError(error);
    }
  }

  openButton.addEventListener("click", () => {
    const thread = getThread();
    setThread(thread);
    if (!state.threadId) return;
    panel.show();
    void loadDirectory("");
  });
  closeButton.addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => {
    invalidate();
    i18n.text(stateLabel, () => "");
    stateLabel.dataset.kind = "";
  });
  panel.addEventListener("cancel", () => invalidate());
  refreshButton.addEventListener("click", () => state.metadata ? void openFile(state.path) : void loadDirectory(state.path));
  backButton.addEventListener("click", () => void loadDirectory(parentDirectory()));
  entries.addEventListener("click", event => {
    const button = event.target.closest("button[data-path]");
    if (!button) return;
    if (button.dataset.type === "directory") void loadDirectory(button.dataset.path);
    else void openFile(button.dataset.path);
  });
  downloadButton.addEventListener("click", () => void download());
  document.addEventListener("click", event => {
    const button = event.target.closest("button[data-local-file]");
    if (!button) return;
    event.preventDefault();
    const thread = getThread();
    setThread(thread);
    if (!state.threadId) { showError(new Error(t("请先选择一个会话。"))); panel.show(); return; }
    panel.show();
    void openFile(button.dataset.localFile);
  });
  win.addEventListener("beforeunload", () => {
    invalidate();
    for (const url of state.downloadUrls) URLApi.revokeObjectURL(url);
    state.downloadUrls.clear();
  }, { once: true });

  return Object.freeze({ setThread, close: () => panel.close(), openFile, loadDirectory, download, dispose: () => {
    invalidate();
    for (const url of state.downloadUrls) URLApi.revokeObjectURL(url);
    state.downloadUrls.clear();
  } });
}

if (typeof window !== "undefined") window.CodexFiles = Object.freeze({ createFilesPanel, splitLocalReference });
