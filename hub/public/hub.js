const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const translations = {
  "Codex Mobile Bridge": "Codex Mobile Bridge", "语言": "Language", "退出登录": "Sign out", "登录": "Sign in", "邀请注册": "Register with invite", "已有账户，登录": "I already have an account", "使用邀请注册": "Register with invite",
  "账户名": "Username", "密码": "Password", "邀请码": "Invitation code", "电脑设备配对": "Connect this computer", "我的设备": "My devices", "刷新": "Refresh", "尚未添加设备": "No devices added yet", "设备名称": "Device name", "未命名设备": "Unnamed device", "在线": "Online", "离线": "Offline", "打开会话": "Open session", "重命名": "Rename", "移除设备": "Remove device", "确认移除并断开设备": "Confirm removal and disconnect", "取消移除": "Cancel removal", "保存名称": "Save name", "取消": "Cancel", "添加设备": "Add a device", "绑定这台电脑": "Connect this computer", "生成配对码": "Generate pairing code", "例如：办公室电脑": "e.g. Office PC", "配对码": "Pairing code", "显示配对码": "Show code", "隐藏配对码": "Hide code", "复制配对码": "Copy code", "复制配对信息": "Copy pairing details", "邀请账户": "Invite an account", "生成邀请": "Create invitation", "邀请链接": "Invitation link", "复制邀请链接": "Copy invitation link",
  "尝试次数过多，请稍后再试。": "Too many attempts. Try again later.", "请求失败（{status}）": "Request failed ({status})", "无法连接服务，请稍后刷新。": "Could not connect. Refresh and try again.", "服务返回的配对信息无效。": "The service returned invalid pairing details.", "有效期至 {date}": "Expires {date}", "配对信息已过期，请重新生成。": "Pairing details expired. Generate a new code.", "操作结果未确认，请核对当前状态后再操作。": "The result could not be confirmed. Check the current status before trying again.", "本次配对码或邀请链接无法恢复。": "This pairing code or invitation link cannot be recovered.", "无法登录或注册，请检查账户信息与邀请码。": "Sign-in or registration failed. Check the account details and invitation code.", "无法复制，请选择文本复制。": "Could not copy. Select and copy the text.", "已复制": "Copied", "配对信息已复制": "Pairing details copied", "无法复制，请重新生成配对信息后重试。": "Could not copy. Generate new pairing details and try again.", "配对码已复制": "Pairing code copied", "无法复制，请显示配对码后选择文本复制。": "Could not copy. Show the code, then select and copy it.",
  "用户名或密码不正确。": "Incorrect username or password.", "密码需为 12 至 1024 字节。": "Password must be 12 to 1024 bytes.", "用户名已被使用。": "That username is already in use.", "邀请码已失效或已使用。": "The invitation code is expired or already used.", "用户名需为 3 至 64 个字母、数字或 ._-。": "Username must be 3 to 64 letters, numbers, periods, underscores, or hyphens.", "设备名称需为 1 至 80 个字符。": "Device name must be 1 to 80 characters.", "请先使用已有配对码或等待其过期。": "Use an existing pairing code or wait for it to expire.", "账号最多绑定 10 台设备。": "An account can connect up to 10 devices.", "账号数量已达到入口上限。": "The account limit has been reached.", "未使用的邀请已达到上限。": "The limit for unused invitations has been reached.", "入口设备记录已达到上限，请等待过期记录清理。": "The device record limit has been reached. Wait for expired records to be cleared.", "请求过于频繁，请稍后重试。": "Too many requests. Try again later.", "配对码已失效或已使用。": "The pairing code is expired or already used.", "设备不存在。": "Device not found.", "管理员已初始化，请使用现有管理员邀请注册。": "An administrator is already set up. Ask an existing administrator for an invitation.", "账户名或邀请码不正确。": "Registration failed. Check the username and invitation code.", "操作结果未确认，请核对当前状态后再操作。本次配对码或邀请链接无法恢复。": "The result could not be confirmed. Check the current status before trying again. The pairing code or invitation link cannot be recovered."
};

const ERROR_MESSAGES = {
  INVALID_CREDENTIALS: "用户名或密码不正确。", INVALID_PASSWORD: "密码需为 12 至 1024 字节。", USERNAME_TAKEN: "用户名已被使用。", INVALID_INVITE: "邀请码已失效或已使用。", RATE_LIMITED: "请求过于频繁，请稍后重试。", INVALID_PAIRING: "配对码已失效或已使用。", NOT_FOUND: "设备不存在。", LIMIT_REACHED: "账号数量已达到入口上限。", ALREADY_INITIALIZED: "管理员已初始化，请使用现有管理员邀请注册。"
};

export function initializeHub({ document, window, fetchImpl = fetch, i18n }) {
  if (!i18n) throw new TypeError("Hub requires the shared i18n runtime");
  const $ = id => document.getElementById(id), t = key => i18n.t(key);
  i18n.register(translations);
  i18n.apply(document);
  let user = null, registering = false, busy = false, generation = 0, pairingTicket = null, pairingExpiryTimer = null, pendingPairingName = '', pairingExpiresAt = null, inviteExpiresAt = null, notice = null;
  const setupConnector = new URL(window.location.href).searchParams.get("setup") === "connector";
  let setupFocusPending = setupConnector;
  const notify = (key, params) => { notice = { key, params }; $("feedback").textContent = i18n.t(key, params); };
  function renderExpiries() {
    const locale = i18n.language === "en" ? "en-US" : "zh-CN";
    if (pairingExpiresAt) $("pairExpiry").textContent = i18n.t("有效期至 {date}", { date: pairingExpiresAt.toLocaleString(locale) });
    if (inviteExpiresAt) $("inviteExpiry").textContent = i18n.t("有效期至 {date}", { date: inviteExpiresAt.toLocaleString(locale) });
  }
  function renderLanguageChoice() {
    const english = i18n.language === "en";
    $("languageZh").setAttribute("aria-pressed", String(!english));
    $("languageEn").setAttribute("aria-pressed", String(english));
    document.documentElement.lang = english ? "en" : "zh-CN";
    document.title = t("Codex Mobile Bridge");
    if (notice) $("feedback").textContent = i18n.t(notice.key, notice.params);
    renderExpiries();
  }
  i18n.subscribe(() => { i18n.apply(document); authMode(registering); if (setupConnector) { $("pairingTitle").dataset.i18n = "绑定这台电脑"; $("pairingTitle").textContent = t("绑定这台电脑"); } renderLanguageChoice(); });
  $("languageZh").addEventListener("click", () => i18n.setLanguage("zh-CN"));
  $("languageEn").addEventListener("click", () => i18n.setLanguage("en"));
  function clearPairingTicket() { clearTimeout(pairingExpiryTimer); pairingExpiryTimer = null; pairingTicket = null; pendingPairingName = ''; pairingExpiresAt = null; $("pairCode").value = ""; $("pairResult").hidden = true; $("pairCode").type = "password"; $("showPair").dataset.i18n = "显示配对码"; $("showPair").textContent = t("显示配对码"); }
  function clearSecrets() { clearPairingTicket(); inviteExpiresAt = null; $("password").value = $("inviteLink").value = ""; $("inviteResult").hidden = true; }
  function authMode(value) { registering = value; const title = value ? "邀请注册" : "登录", switchLabel = value ? "已有账户，登录" : "使用邀请注册"; $("authTitle").dataset.i18n = title; $("authSubmit").dataset.i18n = title; $("authMode").dataset.i18n = switchLabel; $("authTitle").textContent = $("authSubmit").textContent = t(title); $("inviteLabel").hidden = !value; $("invite").required = value; $("password").minLength = value ? 12 : 1; $("password").autocomplete = value ? "new-password" : "current-password"; $("authMode").textContent = t(switchLabel); }
  function signedOut() { ++generation; user = null; clearSecrets(); $("deviceList").replaceChildren(); $("auth").hidden = false; $("dashboard").hidden = $("logout").hidden = true; $("accountName").textContent = ""; }
  async function request(path, options = {}) {
    const token = generation;
    const response = await fetchImpl(path, { ...options, credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    let body = {}; try { body = await response.json(); } catch {}
    if (!response.ok) { if (response.status === 401 && token === generation) signedOut(); const error = new Error(body.error || `请求失败（${response.status}）`); error.status = response.status; error.code = body.code; throw error; }
    return body;
  }
  function signedIn(value) { if (user?.id !== value.user?.id) clearSecrets(); $("password").value = ""; user = value.user; $("auth").hidden = true; $("dashboard").hidden = $("logout").hidden = false; $("admin").hidden = user?.role !== "admin"; $("accountName").textContent = user?.username || ""; }
  const make = (tag, key, className) => { const element = document.createElement(tag); if (key) { element.dataset.i18n = key; element.textContent = t(key); } if (className) element.className = className; return element; };
  const makeUserText = (tag, value, className) => { const element = document.createElement(tag); element.textContent = value; if (className) element.className = className; return element; };
  function renderDevices(devices) {
    const list = $("deviceList"); list.replaceChildren();
    for (const device of devices.filter(device => UUID.test(device.id) && !device.revoked)) {
      const row = make("article", null, "device"), top = make("div", null, "device-top");
      top.append(device.name ? makeUserText("h2", device.name) : make("h2", "未命名设备"), make("span", device.online ? "在线" : "离线", `device-state${device.online ? " online" : ""}`));
      const enter = make("a", "打开会话", "device-link"); enter.href = `/devices/${device.id}/`;
      const actions = make("div", null, "device-actions"), rename = make("button", "重命名", "secondary"), revoke = make("button", "移除设备", "secondary"); rename.type = revoke.type = "button";
      const form = make("form"), name = make("input"), save = make("button", "保存名称"), cancel = make("button", "取消", "secondary"); name.value = device.name || ""; name.maxLength = 80; name.required = true; name.dataset.i18nAriaLabel = "设备名称"; name.setAttribute("aria-label", t("设备名称")); cancel.type = "button"; form.hidden = true; form.append(name, save, cancel);
      rename.addEventListener("click", () => { form.hidden = false; name.focus(); }); cancel.addEventListener("click", () => { form.hidden = true; });
      form.addEventListener("submit", event => { event.preventDefault(); mutate(`/api/hub/devices/${device.id}`, { name: name.value }, "PATCH"); });
      let confirming = false;
      revoke.addEventListener("click", () => { if (!confirming) { confirming = true; revoke.textContent = t("确认移除并断开设备"); revoke.dataset.i18n = "确认移除并断开设备"; revokeCancel.hidden = false; } else mutate(`/api/hub/devices/${device.id}`, null, "DELETE"); });
      const revokeCancel = make("button", "取消移除", "secondary"); revokeCancel.type = "button"; revokeCancel.hidden = true; revokeCancel.addEventListener("click", () => { confirming = false; revoke.dataset.i18n = "移除设备"; revoke.textContent = t("移除设备"); revokeCancel.hidden = true; });
      actions.append(rename, revoke, revokeCancel); row.append(top, enter, actions, form); list.append(row);
    }
    if (!list.children.length) list.append(make("p", "尚未添加设备"));
  }
  async function refresh() {
    const token = ++generation;
    try { const result = await request("/api/hub/me"); if (token !== generation) return; signedIn(result); renderDevices(result.devices || []); if (setupFocusPending) { setupFocusPending = false; $("pairing").scrollIntoView?.({ block: "start" }); $("deviceName").focus(); } }
    catch (error) { if (token === generation) { signedOut(); notify(error.status === 401 ? "" : "无法连接服务，请稍后刷新。"); } }
  }
  function setBusy(value) { busy = value; for (const button of document.querySelectorAll("button:not(#languageZh):not(#languageEn)")) button.disabled = value; }
  async function mutate(path, body, method = "POST") {
    if (busy) return;
    setBusy(true); ++generation; notify("");
    try {
      const result = await request(path, { method, body: JSON.stringify(body || {}) });
      if (path === "/api/hub/pairings") {
        const expiresAt = new Date(result.expiresAt);
        if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now() || !/^[A-Za-z0-9_-]{43}$/.test(result.pairingCode || "")) throw Object.assign(new Error(), { code: "INVALID_PAIRING_RESPONSE" });
        pairingTicket = { type: "codex-mobile-pairing", version: 1, server: new URL(window.location.href).origin, code: result.pairingCode, name: pendingPairingName, expiresAt: expiresAt.toISOString() };
        pairingExpiresAt = expiresAt; $("pairCode").value = result.pairingCode; $("pairCode").type = "password"; $("showPair").textContent = t("显示配对码"); $("pairResult").hidden = false; renderExpiries();
        pairingExpiryTimer = window.setTimeout(() => { clearPairingTicket(); notify("配对信息已过期，请重新生成。"); }, Math.max(0, expiresAt.getTime() - Date.now()));
      } else if (path === "/api/hub/invitations") {
        const link = new URL("/", window.location.origin); link.searchParams.set("invite", result.invite); $("inviteLink").value = link.href; $("inviteResult").hidden = false; inviteExpiresAt = new Date(result.expiresAt); renderExpiries();
      } else if (path === "/api/hub/logout") signedOut();
      else { if (result.user) signedIn(result); await refresh(); }
    } catch (error) {
      $("password").value = "";
      if (path === "/api/hub/pairings") clearPairingTicket();
      if (!error.status) { clearSecrets(); await refresh(); notify(["/api/hub/pairings", "/api/hub/invitations"].includes(path) ? "操作结果未确认，请核对当前状态后再操作。本次配对码或邀请链接无法恢复。" : "操作结果未确认，请核对当前状态后再操作。"); }
      else if (path.endsWith("/login") || path.endsWith("/register")) notify(error.status === 429 ? "请求过于频繁，请稍后重试。" : ERROR_MESSAGES[error.code] || "账户名或邀请码不正确。");
      else notify(ERROR_MESSAGES[error.code] || "请求失败（{status}）", { status: error.status });
    } finally { setBusy(false); }
  }
  $("authForm").addEventListener("submit", event => { event.preventDefault(); mutate(`/api/hub/${registering ? "register" : "login"}`, { username: $("username").value, password: $("password").value, ...(registering ? { invite: $("invite").value } : {}) }); });
  $("authMode").addEventListener("click", () => authMode(!registering));
  $("pairForm").addEventListener("submit", event => { event.preventDefault(); clearPairingTicket(); pendingPairingName = $("deviceName").value.trim(); mutate("/api/hub/pairings", pendingPairingName ? { name: pendingPairingName } : {}); });
  $("createInvite").addEventListener("click", () => mutate("/api/hub/invitations", {}));
  $("logout").addEventListener("click", () => mutate("/api/hub/logout", {}));
  $("refreshDevices").addEventListener("click", () => { if (!busy) refresh(); });
  $("showPair").addEventListener("click", () => { const hidden = $("pairCode").type === "password", key = hidden ? "隐藏配对码" : "显示配对码"; $("pairCode").type = hidden ? "text" : "password"; $("showPair").dataset.i18n = key; $("showPair").textContent = t(key); });
  async function copy(id) { try { await window.navigator.clipboard.writeText($(id).value); notify("已复制"); } catch { notify("无法复制，请选择文本复制。"); } }
  async function copyPairingInformation() {
    if (!activePairingTicket()) return;
    try { await window.navigator.clipboard.writeText(JSON.stringify(pairingTicket, null, 2)); notify("配对信息已复制"); }
    catch { notify("无法复制，请重新生成配对信息后重试。"); }
  }
  function activePairingTicket() {
    if (pairingTicket && Date.parse(pairingTicket.expiresAt) > Date.now()) return pairingTicket;
    clearPairingTicket(); notify("配对信息已过期，请重新生成。"); return null;
  }
  async function copyPairingCode() {
    const ticket = activePairingTicket(); if (!ticket) return;
    try { await window.navigator.clipboard.writeText(ticket.code); notify("配对码已复制"); }
    catch { notify("无法复制，请显示配对码后选择文本复制。"); }
  }
  $("copyPairCode").addEventListener("click", copyPairingCode); $("copyPair").addEventListener("click", copyPairingInformation); $("copyInvite").addEventListener("click", () => copy("inviteLink"));
  const params = new URL(window.location.href).searchParams, invite = params.get("invite");
  authMode(!!invite); if (invite) $("invite").value = invite;
  if (setupConnector) { $("setupContext").hidden = false; $("pairingTitle").dataset.i18n = "绑定这台电脑"; $("pairingTitle").textContent = t("绑定这台电脑"); }
  renderLanguageChoice();
  const ready = refresh();
  return { ready, refresh };
}
