const PERMISSIONS = { "full-access": "完全访问", "request-approval": "请求批准" };
const SOURCES = { file: "文件", web: "网页", tool: "工具", "web-search": "网页搜索", app: "应用", resource: "资源" };
const STATUSES = { running: "进行中", active: "进行中", inProgress: "进行中", pendingInit: "正在启动", idle: "空闲", completed: "已完成", errored: "错误", failed: "错误", interrupted: "已中断", closed: "已结束", shutdown: "已结束", notFound: "暂不可用", notLoaded: "尚未载入", unknown: "状态未知" };
const string = value => typeof value === "string" ? value : "";

export function createThreadContextPanel({ document, window, api, storage, onSelectThread, onNotice = () => {} }) {
  const node = id => document.getElementById(id);
  const ui = { toggle: node("contextToggle"), panel: node("threadContext"), scrim: node("contextScrim"), close: node("closeContext"), refresh: node("refreshContext"), state: node("contextState"), content: node("contextContent"), permission: node("messagePermission"), permissionState: node("permissionState") };
  let threadId = null, cwd = "", opened = false, connected = false, sending = false, sendMode = "message", status = null, context = null, loading = false, controller = null, generation = 0, failure = "", permissionFingerprint = "";
  const selections = new Map();
  const selectedPermission = () => {
    if (!threadId) return "";
    if (!selections.has(threadId)) {
      let value = "";
      try { value = storage.getItem(`codex-mobile-permission:${threadId}`) || ""; } catch { /* The default remains usable without storage. */ }
      selections.set(threadId, Object.hasOwn(PERMISSIONS, value) ? value : "");
    }
    return selections.get(threadId);
  };
  const choices = () => (Array.isArray(status?.permissionOptions?.send) ? status.permissionOptions.send : []).filter(item => Object.hasOwn(PERMISSIONS, item?.id));
  const supports = value => choices().some(item => item.id === value) && context?.permissions?.supported !== false;
  function renderPermissions() {
    const selected = selectedPermission(), options = choices();
    const fingerprint = JSON.stringify([threadId, selected, options.map(item => item.id), supports(selected), sendMode]);
    if (fingerprint !== permissionFingerprint) {
      ui.permission.replaceChildren(new window.Option(sendMode === "follow-up" ? "下轮权限 · 沿用桌面" : "权限 · 沿用桌面", ""), ...options.map(item => new window.Option(`${sendMode === "follow-up" ? "下轮 · " : ""}${PERMISSIONS[item.id]}`, item.id)));
      if (selected && !supports(selected) && !options.some(item => item.id === selected)) ui.permission.append(new window.Option(`${PERMISSIONS[selected]}（不可用）`, selected));
      ui.permission.value = selected;
      permissionFingerprint = fingerprint;
    }
    ui.permission.disabled = !threadId || sending;
    ui.permission.dataset.unavailable = String(!!selected && !supports(selected));
    const current = context?.permissions?.current;
    const currentLabel = PERMISSIONS[current] || (current === "custom" ? "自定义权限" : "未知");
    ui.permission.title = `下一轮权限：${PERMISSIONS[selected] || "沿用桌面"}${connected && context ? `；当前权限：${currentLabel}` : ""}${sendMode === "follow-up" ? "；本轮补充沿用当前轮次权限" : !options.length ? "；当前桌面未提供权限切换" : ""}`;
    ui.permissionState.textContent = selected && !supports(selected) && sendMode !== "follow-up" ? "所选权限不可用，请恢复沿用桌面。" : sendMode === "follow-up" && selected ? "本轮补充沿用当前权限" : "";
    ui.permissionState.hidden = !ui.permissionState.textContent || sendMode === "follow-up";
  }
  function element(tag, className, text) { const value = document.createElement(tag); if (className) value.className = className; if (text != null) value.textContent = text; return value; }
  function section(title) { const value = element("section", "context-section"); value.append(element("h3", "", title)); ui.content.append(value); return value; }
  function empty(parent, reason, fallback) { parent.append(element("p", "", string(reason) || fallback)); }
  function detail(parent, pairs) {
    const list = element("dl");
    for (const [name, value, title] of pairs) { if (!value) continue; const content = element("dd", "", value); if (title) content.title = title; list.append(element("dt", "", name), content); }
    parent.append(list);
  }
  function render() {
    const focusedKey = ui.content.contains(document.activeElement) ? document.activeElement.dataset.contextKey : "";
    ui.toggle.disabled = !threadId;
    ui.toggle.setAttribute("aria-expanded", String(opened));
    ui.toggle.setAttribute("aria-label", opened ? "关闭会话上下文" : "打开会话上下文");
    ui.panel.hidden = !opened;
    const mobile = !window.matchMedia("(min-width: 760px)").matches;
    ui.scrim.hidden = !opened || !mobile;
    ui.panel.setAttribute("role", mobile ? "dialog" : "complementary");
    if (mobile && opened) ui.panel.setAttribute("aria-modal", "true"); else ui.panel.removeAttribute("aria-modal");
    for (const selector of [".conversation", ".task-drawer", ".topbar"]) document.querySelector(selector).inert = opened && mobile;
    ui.refresh.disabled = !connected || loading;
    ui.state.textContent = !connected ? "连接中断；上下文暂不可用。" : loading ? "正在读取上下文…" : failure || (!context?.available && context ? string(context.reason) || "当前桌面无法提供上下文。" : "");
    ui.content.dataset.stale = String(!connected || !!failure);
    ui.content.replaceChildren();
    if (!context || !opened) { renderPermissions(); return; }
    const permissions = section("当前权限");
    const mode = context.permissions?.current;
    empty(permissions, connected ? PERMISSIONS[mode] || (mode === "custom" ? "自定义权限" : "当前权限未知") : "暂不可用", "当前权限未知");
    const git = section("Git / 工作目录"), data = context.git;
    if (data?.available) detail(git, [["分支", string(data.branch) || (data.detached ? "分离 HEAD" : "未知")], ["提交", string(data.commit).slice(0, 12), string(data.commit)], ["工作区", data.dirty === true ? "有未提交更改" : data.dirty === false ? "干净" : "未知"]]);
    else empty(git, data?.reason, "未提供 Git 信息");
    if (string(context.cwd) || cwd) detail(git, [["目录", string(context.cwd) || cwd]]);
    const agents = section("子智能体"), agentData = context.agents;
    if (agentData?.available && Array.isArray(agentData.items) && agentData.items.length) {
      const list = element("ul", "context-items");
      const byId = new Map(agentData.items.map(item => [item.threadId, item]));
      const agentDepth = (item, seen = new Set()) => {
        if (seen.size >= 4 || seen.has(item.threadId)) return 0;
        seen.add(item.threadId);
        const parent = byId.get(item.parentThreadId);
        return parent ? 1 + agentDepth(parent, seen) : Math.min(4, Math.max(0, string(item.path).split("/").filter(Boolean).length - 2));
      };
      for (const item of agentData.items) {
        const row = element("li", "context-item context-agent");
        const depth = agentDepth(item);
        row.style.setProperty("--agent-depth", String(depth));
        const canRead = connected && item.canRead === true && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(string(item.threadId));
        const title = element(canRead ? "button" : "span", "context-item-title", string(item.name) || string(item.threadId) || "未命名代理");
        title.dataset.contextKey = `agent:${string(item.threadId)}`;
        if (canRead) { title.type = "button"; title.title = "查看代理会话"; title.addEventListener("click", () => { setOpen(false); onSelectThread(item.threadId); }); }
        row.append(title, element("span", "context-item-meta", STATUSES[item.status] || string(item.status) || "状态未知"));
        const path = Array.isArray(item.path) ? item.path.filter(value => typeof value === "string").join(" / ") : string(item.path);
        if (path) row.append(element("code", "context-item-meta", path));
        list.append(row);
      }
      agents.append(list);
      if (agentData.partial) empty(agents, agentData.reason, "部分代理信息暂不可用");
    } else empty(agents, agentData?.reason, agentData?.available ? "暂无代理" : "代理信息暂不可用");
    const sources = section("来源"), sourceData = context.sources;
    if (sourceData?.available && Array.isArray(sourceData.items) && sourceData.items.length) {
      const list = element("ul", "context-items");
      for (const item of sourceData.items) {
        const row = element("li", "context-item");
        let href = ""; try { const url = new URL(string(item.url)); if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) href = url.href; } catch { /* Untrusted URLs remain plain text. */ }
        const file = connected && item.type === "file" && string(item.path);
        const label = element(file ? "button" : href ? "a" : "span", "context-item-title", string(item.label) || string(item.path) || "未命名来源");
        label.dataset.contextKey = `source:${string(item.type)}:${string(item.path) || string(item.url) || string(item.label)}`;
        if (href) { label.href = href; label.target = "_blank"; label.rel = "noopener noreferrer"; }
        if (file) { label.type = "button"; label.dataset.localFile = file; label.title = "查看来源文件"; label.addEventListener("click", () => setOpen(false)); }
        row.append(label, element("span", "context-item-meta", `${SOURCES[item.type] || "来源"}${Number.isSafeInteger(item.count) && item.count > 1 ? ` · ${item.count}` : ""}`));
        if (item.path) row.append(element("code", "context-item-meta", string(item.path)));
        list.append(row);
      }
      sources.append(list);
      if (sourceData.partial) empty(sources, sourceData.reason, "部分来源暂不可用");
    } else empty(sources, sourceData?.reason, sourceData?.available ? "暂无来源" : "来源信息暂不可用");
    renderPermissions();
    if (focusedKey) ([...ui.content.querySelectorAll("button[data-context-key], a[data-context-key]")].find(item => item.dataset.contextKey === focusedKey) || ui.close).focus();
  }
  async function refresh() {
    if (!threadId || !opened || !connected || loading) return;
    const id = threadId, token = generation;
    controller = new AbortController(); loading = true; failure = ""; render();
    try {
      const result = await api(`/api/threads/${encodeURIComponent(id)}/context`, { signal: controller.signal });
      if (token !== generation || id !== threadId) return;
      if (result.threadId !== id) throw new Error("上下文与当前会话不匹配");
      context = result;
    } catch (error) {
      if (token !== generation || id !== threadId || error.name === "AbortError") return;
      failure = error.status === 404 ? "当前桥接版本未提供会话上下文。" : `无法读取上下文：${error.message}`;
      context = null;
    } finally { if (token === generation && id === threadId) { loading = false; render(); } }
  }
  function setOpen(value) {
    opened = !!value && !!threadId; render();
    if (opened) { ui.close.focus(); void refresh(); } else ui.toggle.focus();
  }
  ui.toggle.addEventListener("click", () => setOpen(!opened));
  ui.close.addEventListener("click", () => setOpen(false));
  ui.scrim.addEventListener("click", () => setOpen(false));
  ui.refresh.addEventListener("click", () => { void refresh(); });
  ui.panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    if (event.key === "Tab" && !window.matchMedia("(min-width: 760px)").matches) {
      const targets = [...ui.panel.querySelectorAll("button:not(:disabled), a[href]")];
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  ui.permission.addEventListener("change", () => {
    const value = Object.hasOwn(PERMISSIONS, ui.permission.value) ? ui.permission.value : "";
    if (!threadId) return;
    selections.set(threadId, value);
    try { storage.setItem(`codex-mobile-permission:${threadId}`, value); }
    catch { onNotice("权限选择已更新，但浏览器无法保存。刷新后需重新选择。", "error"); }
    renderPermissions();
  });
  const media = window.matchMedia("(min-width: 760px)");
  media.addEventListener?.("change", render);
  render();
  return {
    setThread(id) { if (id === threadId) return; controller?.abort(); generation += 1; threadId = id; if (!id) opened = false; cwd = ""; context = null; loading = false; failure = ""; render(); if (opened) void refresh(); },
    setState(value) { status = value.status; connected = !!value.connected; sending = !!value.sending; sendMode = value.sendMode || "message"; const newCwd = value.thread?.id === threadId ? string(value.thread.cwd) : ""; const changedCwd = newCwd !== cwd; cwd = newCwd; renderPermissions(); if (opened && (!connected || changedCwd)) render(); },
    refresh,
    sendOverride() {
      const value = selectedPermission();
      if (sendMode === "follow-up" || !value) return {};
      if (!supports(value)) { const error = new Error("所选权限在当前桌面不可用，请恢复沿用桌面或重新选择"); error.code = "PERMISSION_UNAVAILABLE"; throw error; }
      return { permissionMode: value };
    }
  };
}
