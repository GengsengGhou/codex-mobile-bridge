export function createAccessPanel({ document, window, api, fetchImpl = fetch, deviceContext = null, onLoginRequired = () => {} }) {
  const css = document.createElement("link"); css.rel = "stylesheet"; css.href = "./access.css"; document.head.append(css);
  const notice = document.createElement("div"); notice.className = "access-notice"; notice.hidden = true; notice.setAttribute("role", "alert");
  const message = document.createElement("span"); message.textContent = "登录已过期，草稿已保留。";
  const signIn = document.createElement("a"); signIn.href = deviceContext ? "/" : "/login"; signIn.textContent = "重新登录"; notice.append(message, signIn); document.body.prepend(notice);
  let expired = false;
  const requireLogin = () => { expired = true; notice.hidden = false; const tag = document.querySelector(".environment-tag"); if (tag) tag.textContent = "手机访问"; onLoginRequired(); };
  window.addEventListener("bridge-login-required", requireLogin);
  // Block new submissions while preserving editable inputs and existing draft storage.
  document.addEventListener("submit", event => { if (expired && event.target.id !== "loginForm") { event.preventDefault(); event.stopImmediatePropagation(); } }, true);
  const panel = document.createElement("div"); panel.className = "access-panel"; panel.hidden = true;
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const logout = document.createElement("button"); logout.type = "button"; logout.textContent = "退出登录";
  const revoke = document.createElement("button"); revoke.type = "button"; revoke.textContent = "撤销全部登录";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消"; cancel.hidden = true;
  panel.append(status, logout, revoke, cancel); (document.querySelector(".drawer-foot") || document.getElementById("taskDrawer") || document.body).append(panel);
  if (deviceContext) {
    const name = document.createElement("strong"); name.textContent = deviceContext.device.name;
    const back = document.createElement("a"); back.href = "/"; back.textContent = "返回设备列表";
    panel.replaceChildren(name, back, status); panel.hidden = false;
    const top = document.querySelector(".brand-block"); if (top) { const identity = document.createElement("div"); identity.className = "device-identity"; identity.textContent = identity.title = deviceContext.device.name; top.append(identity); }
    status.textContent = deviceContext.device.online ? "设备已连接" : "设备离线，暂时无法操作";
  }
  let busy = false, confirming = false;
  const reset = () => { confirming = false; revoke.textContent = "撤销全部登录"; cancel.hidden = true; };
  cancel.addEventListener("click", reset);
  async function mutate(path) {
    if (busy || expired) return;
    busy = true; logout.disabled = revoke.disabled = cancel.disabled = true;
    try {
      const response = await fetchImpl(path, { method: "POST", credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1" } });
      if (response.ok || response.status === 401) { requireLogin(); status.textContent = "已退出登录"; }
      else status.textContent = "操作失败，请稍后重试。";
    } catch {
      status.textContent = "正在核对登录状态…";
      try {
        const response = await fetchImpl("/auth/status", { credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1" } });
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (body.authenticated === false) { requireLogin(); status.textContent = "当前登录已结束"; }
        else status.textContent = "操作结果未确认；当前仍已登录，请核对后再操作。";
      } catch { status.textContent = "操作结果未确认，请检查网络后重新登录。"; }
    } finally { busy = false; logout.disabled = revoke.disabled = cancel.disabled = false; reset(); }
  }
  logout.addEventListener("click", () => mutate("/auth/logout"));
  revoke.addEventListener("click", () => { if (confirming) mutate("/auth/revoke-all"); else { confirming = true; revoke.textContent = "确认撤销所有设备的登录"; cancel.hidden = false; } });
  const ready = api("/api/access").then(info => {
    const tag = document.querySelector(".environment-tag");
    if (tag) tag.textContent = ["remote", "hub"].includes(info.mode) ? "手机访问" : "本机访问";
    if (info.mode === "hub") { status.textContent = info.device?.online ? "设备已连接" : "设备离线，暂时无法操作"; return; }
    if (info.mode !== "remote") { createLocalAccess({ document, panel, api }); return; }
    panel.hidden = false;
    const date = new Date(info.expiresAt);
    status.textContent = Number.isFinite(date.getTime()) ? `登录有效期至 ${date.toLocaleString("zh-CN")}` : "手机访问已登录";
  }).catch(error => { if (error.code === "LOGIN_REQUIRED") requireLogin(); });
  return { ready, requireLogin };
}

function createLocalAccess({ document, panel, api }) {
  panel.replaceChildren(); panel.hidden = false;
  const button = label => { const element = document.createElement("button"); element.type = "button"; element.textContent = label; return element; };
  const open = button("手机访问设置"); open.id = "remoteAccessSettings";
  const controls = document.createElement("div"); controls.hidden = true;
  const status = document.createElement("p"); status.setAttribute("role", "status");
  const start = button("开启手机访问"); start.id = "remoteAccessStart";
  const stop = button("关闭手机访问"); stop.id = "remoteAccessStop"; stop.hidden = true;
  const cancel = button("取消"); cancel.hidden = true;
  const url = document.createElement("a"); url.id = "remoteAccessUrl"; url.target = "_blank"; url.rel = "noopener noreferrer"; url.hidden = true;
  const code = document.createElement("input"); code.id = "remoteAccessCode"; code.type = "password"; code.readOnly = true; code.setAttribute("aria-label", "手机访问密码"); code.hidden = true;
  const show = button("显示密码"); show.hidden = true;
  const copy = button("复制密码"); copy.hidden = true;
  const copyUrl = button("复制地址"); copyUrl.hidden = true;
  const note = document.createElement("p"); note.textContent = "首次开启需等待临时地址生效；隧道重启后地址可能改变。请保留访问密码。";
  controls.append(status, start, stop, cancel, url, copyUrl, code, show, copy, note); panel.append(open, controls);
  let busy = false, confirming = false, poll = null, generation = 0, confirmed = null;
  function updateButtons() {
    start.disabled = busy || confirmed?.supported !== true || confirmed?.installed !== true || !["stopped", "error"].includes(confirmed?.state);
    stop.disabled = busy || !["starting", "waiting", "running"].includes(confirmed?.state);
  }
  updateButtons();
  function clearCode() { code.value = ""; code.hidden = show.hidden = copy.hidden = true; code.type = "password"; show.textContent = "显示密码"; }
  function render(value) {
    confirmed = value;
    const active = ["starting", "running", "waiting"].includes(value.state);
    start.hidden = active; stop.hidden = !active; updateButtons();
    const labels = { stopped: "手机访问已关闭", starting: "正在开启手机访问…", waiting: "正在等待临时地址…", running: "手机访问已开启", error: "开启失败" };
    status.textContent = value.lastError || labels[value.state] || "手机访问状态未知";
    if (active && !code.value) status.textContent += "。此页面的密码未保留；已保存的密码仍可用，遗失时请关闭后重新开启。";
    let safeUrl = null;
    try { const parsed = new URL(value.url); if (parsed.protocol === "https:") safeUrl = parsed.href; } catch {}
    url.hidden = copyUrl.hidden = !safeUrl;
    if (safeUrl) { url.href = safeUrl; url.textContent = safeUrl; } else { url.removeAttribute("href"); url.textContent = ""; }
    if (["stopped", "error"].includes(value.state)) clearCode();
    clearTimeout(poll);
    if (!controls.hidden && !busy && ["starting", "waiting"].includes(value.state)) poll = setTimeout(() => refresh(), 2500);
  }
  async function refresh({ reconcile = false, errorMessage = "", previousState } = {}) {
    if (controls.hidden || (busy && !reconcile)) return;
    const token = ++generation;
    try {
      const value = await api("/api/remote-access");
      if (token !== generation || controls.hidden) return;
      render(value);
      if (errorMessage && value.state === previousState) status.textContent = errorMessage;
    } catch {
      if (token !== generation || controls.hidden) return;
      confirmed = null; updateButtons();
      status.textContent = errorMessage || "无法读取手机访问状态，请稍后再打开设置。";
    }
  }
  open.addEventListener("click", () => { controls.hidden = !controls.hidden; ++generation; clearTimeout(poll); if (!controls.hidden) refresh(); });
  async function act(action) {
    if (busy || (action === "start" ? start.disabled : stop.disabled)) return;
    const previousState = confirmed?.state;
    busy = true; ++generation; updateButtons();
    clearTimeout(poll);
    try {
      const result = await api("/api/remote-access", { method: "POST", body: JSON.stringify({ action }) });
      if (typeof result.accessCode === "string") { code.value = result.accessCode; code.hidden = show.hidden = copy.hidden = false; }
      render(result);
    } catch (error) {
      const definitive = Number.isInteger(error.status) && error.status >= 400;
      if (!definitive && action === "start") clearCode();
      const errorMessage = definitive ? error.message : "操作结果未确认，请核对当前状态后再操作。";
      confirmed = null; updateButtons(); status.textContent = errorMessage;
      await refresh({ reconcile: true, errorMessage, previousState });
    }
    finally {
      busy = false; updateButtons(); confirming = false; cancel.hidden = true; stop.textContent = "关闭手机访问";
      if (!controls.hidden && ["starting", "waiting"].includes(confirmed?.state)) { clearTimeout(poll); poll = setTimeout(() => refresh(), 2500); }
    }
  }
  start.addEventListener("click", () => act("start"));
  stop.addEventListener("click", () => { if (confirming) act("stop"); else { confirming = true; stop.textContent = "确认关闭手机访问"; cancel.hidden = false; } });
  cancel.addEventListener("click", () => { confirming = false; stop.textContent = "关闭手机访问"; cancel.hidden = true; });
  show.addEventListener("click", () => { code.type = code.type === "password" ? "text" : "password"; show.textContent = code.type === "password" ? "显示密码" : "隐藏密码"; });
  async function copyText(value) { try { await document.defaultView.navigator.clipboard.writeText(value); status.textContent = "已复制"; } catch { status.textContent = "无法复制，请选择文本复制。"; } }
  copy.addEventListener("click", () => copyText(code.value)); copyUrl.addEventListener("click", () => copyText(url.href));
}
