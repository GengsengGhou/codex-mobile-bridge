const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function initializeHub({ document, window, fetchImpl = fetch }) {
  const $ = id => document.getElementById(id);
  let user = null, registering = false, busy = false, generation = 0;
  const notify = message => { $("feedback").textContent = message; };
  function clearSecrets() { $("password").value = $("pairCode").value = $("inviteLink").value = ""; $("pairResult").hidden = $("inviteResult").hidden = true; $("pairCode").type = "password"; $("showPair").textContent = "显示配对码"; }
  function authMode(value) { registering = value; $("authTitle").textContent = $("authSubmit").textContent = value ? "邀请注册" : "登录"; $("inviteLabel").hidden = !value; $("invite").required = value; $("password").minLength = value ? 12 : 1; $("password").autocomplete = value ? "new-password" : "current-password"; $("authMode").textContent = value ? "已有账户，登录" : "使用邀请注册"; }
  function signedOut() { ++generation; user = null; clearSecrets(); $("deviceList").replaceChildren(); $("auth").hidden = false; $("dashboard").hidden = $("logout").hidden = true; $("accountName").textContent = ""; }
  async function request(path, options = {}) {
    const token = generation;
    const response = await fetchImpl(path, { ...options, credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1", ...(options.body ? { "Content-Type": "application/json" } : {}) } });
    let body = {}; try { body = await response.json(); } catch {}
    if (!response.ok) { if (response.status === 401 && token === generation) signedOut(); const error = new Error(response.status === 429 ? "尝试次数过多，请稍后再试。" : typeof body.error === "string" ? body.error : `请求失败（${response.status}）`); error.status = response.status; throw error; }
    return body;
  }
  function signedIn(value) { if (user?.id !== value.user?.id) clearSecrets(); $("password").value = ""; user = value.user; $("auth").hidden = true; $("dashboard").hidden = $("logout").hidden = false; $("admin").hidden = user?.role !== "admin"; $("accountName").textContent = user?.username || ""; }
  const make = (tag, text, className) => { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; };
  function renderDevices(devices) {
    const list = $("deviceList"); list.replaceChildren();
    for (const device of devices.filter(device => UUID.test(device.id) && !device.revoked)) {
      const row = make("article", null, "device"), top = make("div", null, "device-top");
      top.append(make("h2", device.name || "未命名设备"), make("span", device.online ? "在线" : "离线", `device-state${device.online ? " online" : ""}`));
      const enter = make("a", "打开会话", "device-link"); enter.href = `/devices/${device.id}/`;
      const actions = make("div", null, "device-actions"), rename = make("button", "重命名", "secondary"), revoke = make("button", "移除设备", "secondary"); rename.type = revoke.type = "button";
      const form = make("form"), name = make("input"), save = make("button", "保存名称"), cancel = make("button", "取消", "secondary"); name.value = device.name || ""; name.maxLength = 80; name.required = true; name.setAttribute("aria-label", "设备名称"); cancel.type = "button"; form.hidden = true; form.append(name, save, cancel);
      rename.addEventListener("click", () => { form.hidden = false; name.focus(); }); cancel.addEventListener("click", () => { form.hidden = true; });
      form.addEventListener("submit", event => { event.preventDefault(); mutate(`/api/hub/devices/${device.id}`, { name: name.value }, "PATCH"); });
      let confirming = false;
      revoke.addEventListener("click", () => { if (!confirming) { confirming = true; revoke.textContent = "确认移除并断开设备"; revokeCancel.hidden = false; } else mutate(`/api/hub/devices/${device.id}`, null, "DELETE"); });
      const revokeCancel = make("button", "取消移除", "secondary"); revokeCancel.type = "button"; revokeCancel.hidden = true; revokeCancel.addEventListener("click", () => { confirming = false; revoke.textContent = "移除设备"; revokeCancel.hidden = true; });
      actions.append(rename, revoke, revokeCancel); row.append(top, enter, actions, form); list.append(row);
    }
    if (!list.children.length) list.append(make("p", "尚未添加设备"));
  }
  async function refresh() {
    const token = ++generation;
    try { const result = await request("/api/hub/me"); if (token !== generation) return; signedIn(result); renderDevices(result.devices || []); }
    catch (error) { if (token === generation) { signedOut(); notify(error.status === 401 ? "" : "无法连接服务，请稍后刷新。"); } }
  }
  function setBusy(value) { busy = value; for (const button of document.querySelectorAll("button")) button.disabled = value; }
  async function mutate(path, body, method = "POST") {
    if (busy) return;
    setBusy(true); ++generation; notify("");
    try {
      const result = await request(path, { method, body: JSON.stringify(body || {}) });
      if (path === "/api/hub/pairings") {
        $("pairCode").value = result.pairingCode; $("pairCode").type = "password"; $("showPair").textContent = "显示配对码"; $("pairResult").hidden = false; $("pairExpiry").textContent = `有效期至 ${new Date(result.expiresAt).toLocaleString("zh-CN")}`;
      } else if (path === "/api/hub/invitations") {
        const link = new URL("/", window.location.origin); link.searchParams.set("invite", result.invite); $("inviteLink").value = link.href; $("inviteResult").hidden = false; $("inviteExpiry").textContent = `有效期至 ${new Date(result.expiresAt).toLocaleString("zh-CN")}`;
      } else if (path === "/api/hub/logout") signedOut();
      else { if (result.user) signedIn(result); await refresh(); }
    } catch (error) {
      $("password").value = "";
      if (!error.status) { clearSecrets(); await refresh(); notify("操作结果未确认，请核对当前状态后再操作。" + (["/api/hub/pairings", "/api/hub/invitations"].includes(path) ? "本次配对码或邀请链接无法恢复。" : "")); }
      else notify(path.endsWith("/login") || path.endsWith("/register") ? error.status === 429 ? error.message : "无法登录或注册，请检查账户信息与邀请码。" : error.message);
    } finally { setBusy(false); }
  }
  $("authForm").addEventListener("submit", event => { event.preventDefault(); mutate(`/api/hub/${registering ? "register" : "login"}`, { username: $("username").value, password: $("password").value, ...(registering ? { invite: $("invite").value } : {}) }); });
  $("authMode").addEventListener("click", () => authMode(!registering));
  $("pairForm").addEventListener("submit", event => { event.preventDefault(); $("pairCode").value = ""; $("pairResult").hidden = true; mutate("/api/hub/pairings", { name: $("deviceName").value }); });
  $("createInvite").addEventListener("click", () => mutate("/api/hub/invitations", {}));
  $("logout").addEventListener("click", () => mutate("/api/hub/logout", {}));
  $("refreshDevices").addEventListener("click", () => { if (!busy) refresh(); });
  $("showPair").addEventListener("click", () => { const hidden = $("pairCode").type === "password"; $("pairCode").type = hidden ? "text" : "password"; $("showPair").textContent = hidden ? "隐藏配对码" : "显示配对码"; });
  async function copy(id) { try { await window.navigator.clipboard.writeText($(id).value); notify("已复制"); } catch { notify("无法复制，请选择文本复制。"); } }
  $("copyPair").addEventListener("click", () => copy("pairCode")); $("copyInvite").addEventListener("click", () => copy("inviteLink"));
  const invite = new URL(window.location.href).searchParams.get("invite"); authMode(!!invite); if (invite) $("invite").value = invite;
  const ready = refresh();
  return { ready, refresh };
}
if (typeof document !== "undefined" && document.getElementById("authForm")) initializeHub({ document, window });
