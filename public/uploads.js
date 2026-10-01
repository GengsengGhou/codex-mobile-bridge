import { createI18n } from "./i18n.js";
import { createApi } from "./connection.js";

const PREFIX = "codex-mobile-uploads:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
export function createUploads({ document, window, storage = window.sessionStorage, fetchImpl, getThread, canUpload = () => true, onChange = () => {} }) {
  const i18n = createI18n({ window, document }), t = i18n.t;
  const api = createApi({ fetchImpl, headers: { "X-Bridge-Client": "mobile-v1" } });
  const queues = new Map(), binaries = new Map(), operations = new Map(), preparing = new Map(), corrupt = new Set();
  const list = document.getElementById("attachmentList"), picker = document.getElementById("attachmentPicker"), button = document.getElementById("attachButton"), errorBox = document.getElementById("attachmentError");
  let selected = "", retryTarget = null;
  const key = id => PREFIX + id;
  const endpoint = item => `/api/threads/${item.threadId}/uploads/${item.uploadId}`;
  function error(message) { i18n.text(errorBox, () => t(message)); errorBox.hidden = !message; }
  function save(id) {
    try { storage.setItem(key(id), JSON.stringify(queues.get(id) || [])); return true; }
    catch { error(t("浏览器无法保存附件恢复记录；请允许会话存储后重试。")); return false; }
  }
  function validReceipt(item, receipt) {
    const normalized = value => value.replace(/\\/g, "/").replace(/\/$/, "");
    const currentCwd = getThread(item.threadId)?.cwd || "";
    if (currentCwd && item.cwd && normalized(currentCwd) !== normalized(item.cwd)) return false;
    const expected = (currentCwd || item.cwd) && `${normalized(currentCwd || item.cwd)}/${receipt?.path || ""}`;
    return receipt && receipt.uploaded === true && receipt.uploadId === item.uploadId && receipt.threadId === item.threadId
      && receipt.name === item.name && receipt.size === item.size && receipt.sha256 === item.sha256
      && receipt.path === `mobile-uploads/${item.uploadId}/${item.name}` && item.name !== ".." && !/[\\\r\n<>]/.test(receipt.path)
      && typeof receipt.absolutePath === "string" && /^(?:[a-z]:[\\/]|\/)/i.test(receipt.absolutePath) && !/[\r\n<>]/.test(receipt.absolutePath)
      && (!expected || normalized(receipt.absolutePath) === expected);
  }
  function commitReceipt(item, receipt) {
    if (!validReceipt(item, receipt)) throw new Error(t("附件回执与所选文件不匹配"));
    item.receipt = receipt; item.state = "ready"; item.error = "";
    if (!save(item.threadId)) { item.state = "unknown"; throw new Error(t("附件回执无法保存，请核对上传状态")); }
    binaries.delete(item.uploadId);
  }
  async function check(item) {
    if (operations.has(item.uploadId)) return operations.get(item.uploadId);
    const operation = runCheck(item);
    operations.set(item.uploadId, operation);
    try { await operation; } finally { operations.delete(item.uploadId); render(); onChange(); }
  }
  async function runCheck(item) {
    item.state = "unknown";
    try {
      const result = await api(endpoint(item));
      if (result.state === "uploaded") commitReceipt(item, result.receipt);
      else { item.state = "unknown"; item.error = result.state === "not_found" ? t("未找到上传记录；请选择同一文件后重试") : t("上传尚未确认，请稍后核对"); save(item.threadId); }
    } catch (cause) { item.state = "unknown"; item.error = cause.message; save(item.threadId); }
    render(); onChange();
  }
  async function upload(item) {
    if (operations.has(item.uploadId)) return operations.get(item.uploadId);
    const bytes = binaries.get(item.uploadId);
    if (!bytes) { retryTarget = item; picker.click(); return; }
    item.state = "uploading"; item.error = "";
    if (!save(item.threadId)) { item.state = "failed"; render(); onChange(); return; }
    render(); onChange();
    const operation = (async () => { try {
      const query = new URLSearchParams({ name: item.name, size: String(item.size), sha256: item.sha256 });
      commitReceipt(item, await api(`${endpoint(item)}?${query}`, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: bytes }));
    } catch (cause) { item.state = ["LOGIN_REQUIRED", "DEVICE_OFFLINE", "INVALID_UPLOAD", "UPLOAD_TOO_LARGE", "UPLOAD_FORBIDDEN", "UPLOAD_LIMIT_REACHED"].includes(cause.code) ? "failed" : "unknown"; item.error = cause.message; save(item.threadId); }
    })();
    operations.set(item.uploadId, operation);
    try { await operation; } finally { operations.delete(item.uploadId); }
    render(); onChange();
  }
  async function add(files) {
    const threadId = selected, queue = queues.get(threadId), cwd = getThread(threadId)?.cwd || "";
    if (!threadId || !queue || !canUpload(threadId) || corrupt.has(threadId) || preparing.get(threadId)) return;
    const retry = retryTarget; retryTarget = null;
    if (!retry && queue.length + files.length > 5) { error(t("每个会话最多暂存 5 个附件。")); return; }
    preparing.set(threadId, true); render(); onChange();
    try { for (const file of files) {
      try {
        if (file.size > 20 * 1024 * 1024) throw new Error(t("每个附件不能超过 20 MiB。"));
        if (!file.name || /[\\/\r\n<>]/.test(file.name)) throw new Error(t("附件名称无效，请重命名后选择。"));
        if (!window.crypto?.subtle || typeof file.arrayBuffer !== "function") throw new Error(t("当前浏览器不支持安全读取附件；请使用支持此功能的浏览器。"));
        const bytes = await file.arrayBuffer();
        const sha256 = Array.from(new Uint8Array(await window.crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
        if (retry && (file.name !== retry.name || file.size !== retry.size || sha256 !== retry.sha256)) throw new Error(t("请选择名称、大小和内容都相同的原文件。"));
        if (!retry && queue.length >= 5) throw new Error(t("每个会话最多暂存 5 个附件。"));
        const item = retry || { uploadId: window.crypto.randomUUID(), threadId, cwd, name: file.name, size: file.size, sha256, state: "failed" };
        if (!retry) queue.push(item);
        binaries.set(item.uploadId, bytes);
        if (!save(threadId)) { item.state = "failed"; render(); onChange(); return; }
        void upload(item);
        if (retry) break;
      } catch (cause) { error(cause.message); }
    } } finally { preparing.delete(threadId); render(); onChange(); }
    render(); onChange();
  }
  function render() {
    list.replaceChildren();
    if (corrupt.has(selected)) {
      error(t("附件恢复记录损坏或无法读取，请重试读取或明确清除记录后继续；清除不会删除已上传的文件。"));
      const row = document.createElement("li");
      for (const [label, clear] of [[t("重试读取附件记录"), false], [t("清除附件恢复记录"), true]]) {
        const control = document.createElement("button"); control.type = "button"; i18n.text(control, () => t(label));
        control.addEventListener("click", () => { const id = selected; if (clear) { try { storage.removeItem(key(id)); } catch { error(t("无法清除附件恢复记录，请允许会话存储后重试。")); return; } } error(""); corrupt.delete(id); queues.delete(id); loadThread(id); render(); onChange(); }); row.append(control);
      }
      list.append(row);
    }
    if (preparing.get(selected)) { const row = document.createElement("li"); i18n.text(row, () => t("正在读取和核对附件…")); list.append(row); }
    for (const item of queues.get(selected) || []) {
      const row = document.createElement("li"), label = document.createElement("span");
      i18n.text(label, () => `${item.name} · ${(item.size / 1024).toFixed(1)} KiB · ${{ uploading: t("上传中"), ready: t("已就绪"), failed: t("上传失败"), unknown: t("待核对") }[item.state]}${item.error ? ` · ${item.error}` : ""}`);
      row.append(label);
      for (const [title, action] of [[t("核对"), () => check(item)], [t("重试"), () => upload(item)], [t("移除"), () => remove(selected, [item.uploadId])]]) {
        if ((title === t("核对") && !["unknown", "ready"].includes(item.state)) || (title === t("重试") && !["failed", "unknown"].includes(item.state))) continue;
        const control = document.createElement("button"); control.type = "button"; i18n.text(control, () => t(title)); control.disabled = operations.has(item.uploadId) || item.state === "uploading"; control.addEventListener("click", action); row.append(control);
      }
      list.append(row);
    }
    button.disabled = !selected || !canUpload(selected) || corrupt.has(selected) || !!preparing.get(selected);
  }
  function remove(id, ids) {
    if (!ids.length || corrupt.has(id)) return;
    const previous = queues.get(id) || [];
    queues.set(id, previous.filter(item => !ids.includes(item.uploadId)));
    if (!save(id)) queues.set(id, previous);
    else ids.forEach(value => binaries.delete(value));
    render(); onChange();
  }
  button.addEventListener("click", () => { retryTarget = null; picker.click(); });
  picker.addEventListener("change", () => { const files = [...picker.files]; picker.value = ""; void add(files); });
  function loadThread(id) {
    if (!id || queues.has(id)) return;
    try {
      const saved = JSON.parse(storage.getItem(key(id)) || "[]");
      if (!Array.isArray(saved) || saved.length > 5 || new Set(saved.map(item => item?.uploadId)).size !== saved.length || saved.some(item => !UUID.test(item?.uploadId) || item.threadId !== id || typeof item.name !== "string" || !item.name || /[\\/\r\n<>]/.test(item.name) || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 20 * 1024 * 1024 || !HASH.test(item.sha256) || !["ready", "unknown", "failed", "uploading"].includes(item.state) || (item.cwd !== undefined && typeof item.cwd !== "string"))) throw new Error("invalid records");
      queues.set(id, saved);
      for (const item of saved) { item.state = "unknown"; void check(item); }
    } catch { corrupt.add(id); queues.set(id, []); }
  }
  return {
    setThread(id) {
      selected = id || "";
      loadThread(selected);
      render();
    },
    snapshot(id, draft) {
      const items = queues.get(id) || [];
      if (corrupt.has(id) || preparing.get(id) || items.some(item => operations.has(item.uploadId) || item.state !== "ready" || !validReceipt(item, item.receipt))) return null;
      if (items.length && !save(id)) return null;
      const links = items.map(item => `[${item.name.replace(/[\\[\]]/g, "\\$&")}](<${item.receipt.absolutePath}>)`).join("\n");
      return { prompt: items.length ? t`${draft || t("请查看这些附件。")}\n\n附件：\n${links}` : draft, attachmentIds: items.map(item => item.uploadId) };
    },
    async prepare(id, draft) {
      if (corrupt.has(id) || preparing.get(id) || (queues.get(id) || []).some(item => item.state !== "ready" || operations.has(item.uploadId))) return null;
      const ids = (queues.get(id) || []).map(item => item.uploadId).join(",");
      await Promise.all((queues.get(id) || []).map(item => check(item)));
      if ((queues.get(id) || []).map(item => item.uploadId).join(",") !== ids) return null;
      return this.snapshot(id, draft);
    },
    status(id) { const items = queues.get(id) || []; return { count: items.length, blocked: corrupt.has(id) || !!preparing.get(id) || items.some(item => item.state !== "ready" || operations.has(item.uploadId)) }; },
    remove, add, check, getItems: id => queues.get(id) || []
  };
}
