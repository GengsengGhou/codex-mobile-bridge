import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { initializeHub } from "../hub/public/hub.js";
const html = await readFile(new URL("../hub/public/index.html", import.meta.url), "utf8");
const ID = "00000000-0000-0000-0000-000000000001";
const account = { user: { id: "account", username: "alice", role: "admin" }, devices: [{ id: ID, name: "<script>unsafe</script>", online: true }] };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup(handler, url = "https://hub.test/") { const dom = new JSDOM(html, { url }); const calls = []; const panel = initializeHub({ document: dom.window.document, window: dom.window, fetchImpl: async (path, options) => { calls.push([path, options]); return handler(path, options); } }); return { dom, calls, panel, $: id => dom.window.document.getElementById(id) }; }
test("dashboard renders only returned devices and requires explicit revoke confirmation", async () => {
  const ui = setup(async (path, options) => options.method ? json({ revoked: true }) : json(account)); await ui.panel.ready;
  assert.equal(ui.$("pairingTitle").textContent, "添加设备"); assert.equal(ui.$("setupContext").hidden, true); assert.notEqual(ui.dom.window.document.activeElement, ui.$("deviceName"));
  const row = ui.$("deviceList"); assert.equal(row.querySelector("script"), null); assert.equal(row.querySelector("a").getAttribute("href"), `/devices/${ID}/`);
  const revoke = [...row.querySelectorAll("button")].find(button => button.textContent === "移除设备"); revoke.click(); assert.equal(ui.calls.length, 1); revoke.click(); await tick();
  assert.equal(ui.calls.filter(([, options]) => options.method === "DELETE").length, 1); assert.equal(ui.calls[1][1].headers["X-Bridge-Client"], "mobile-v1"); ui.dom.window.close();
});
test("lost pairing response is never repeated and secret remains only in ephemeral DOM", async () => {
  const ui = setup(async (path, options) => { if (options.method) throw new Error("network"); return json(account); }); await ui.panel.ready;
  ui.$("pairForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick();
  assert.equal(ui.calls.filter(([path]) => path === "/api/hub/pairings").length, 1); assert.match(ui.$("feedback").textContent, /未确认/); assert.equal(ui.$("pairCode").value, ""); assert.equal(ui.dom.window.localStorage.length, 0); assert.equal(ui.dom.window.sessionStorage.length, 0); ui.dom.window.close();
});
test("invite signup clears password on denial and account expiry removes device list", async () => {
  const ui = setup(async () => json({ code: "LOGIN_REQUIRED" }, 401), "https://hub.test/?invite=invite-code"); await ui.panel.ready;
  assert.equal(ui.$("invite").value, "invite-code"); assert.equal(ui.$("inviteLabel").hidden, false);
  ui.$("username").value = "alice"; ui.$("password").value = "password-secret";
  ui.$("authForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick();
  const register = ui.calls.find(([path]) => path === "/api/hub/register"); assert.equal(JSON.parse(register[1].body).invite, "invite-code"); assert.equal(ui.$("password").value, ""); assert.equal(ui.$("deviceList").children.length, 0); assert.equal(ui.$("auth").hidden, false); ui.dom.window.close();
});
test("successful pairing survives refresh and copies either the raw code or full one-time JSON ticket on click", async () => {
  let result = account;
  const code = "p".repeat(43), expiresAt = Date.now() + 600000, copied = []; let expireTicket;
  const ui = setup(async (path) => path === "/api/hub/pairings" ? json({ pairingCode: code, expiresAt }) : json(result));
  Object.defineProperty(ui.dom.window, "setTimeout", { value: callback => { expireTicket = callback; return 7; } });
  Object.defineProperty(ui.dom.window.navigator, "clipboard", { value: { writeText: async text => copied.push(text) } }); await ui.panel.ready;
  ui.$("deviceName").value = "Office PC";
  ui.$("pairForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick(); assert.equal(ui.$("pairCode").value, code); assert.equal(copied.length, 0);
  const body = JSON.parse(ui.calls.find(([path]) => path === "/api/hub/pairings")[1].body); assert.deepEqual(body, { name: "Office PC" });
  ui.$("copyPairCode").click(); await tick(); assert.equal(copied[0], code); assert.match(ui.$("feedback").textContent, /配对码已复制/);
  ui.$("copyPair").click(); await tick();
  const ticket = JSON.parse(copied[1]); assert.deepEqual(ticket, { type: "codex-mobile-pairing", version: 1, server: "https://hub.test", code, name: "Office PC", expiresAt: new Date(expiresAt).toISOString() });
  assert.equal(ui.$("copyPair").textContent, "复制配对信息");
  await ui.panel.refresh(); assert.equal(ui.$("pairCode").value, code);
  expireTicket(); assert.equal(ui.$("pairCode").value, ""); assert.equal(ui.$("pairResult").hidden, true); ui.$("copyPairCode").click(); await tick(); ui.$("copyPair").click(); await tick(); assert.equal(copied.length, 2);
  result = { ...account, user: { id: "other", username: "bob", role: "user" } }; await ui.panel.refresh(); assert.equal(ui.$("pairCode").value, ""); assert.equal(ui.$("admin").hidden, true); ui.dom.window.close();
});
test("connector setup keeps invite registration context and focuses desktop pairing after signup", async () => {
  const invite = "invite-code"; let authenticated = false;
  const ui = setup(async (path, options) => {
    if (path === "/api/hub/me") return authenticated ? json(account) : json({ error: "LOGIN_REQUIRED" }, 401);
    if (path === "/api/hub/register") authenticated = true;
    return json(account);
  }, `https://hub.test/?setup=connector&invite=${invite}`);
  await ui.panel.ready;
  assert.equal(ui.$("setupContext").hidden, false); assert.equal(ui.$("setupContext").textContent, "电脑设备配对"); assert.equal(ui.$("invite").value, invite); assert.equal(ui.$("pairingTitle").textContent, "绑定这台电脑");
  ui.$("authMode").click(); assert.equal(ui.$("authTitle").textContent, "登录"); assert.equal(ui.$("setupContext").hidden, false);
  ui.$("authMode").click(); assert.equal(ui.$("authTitle").textContent, "邀请注册"); assert.equal(ui.$("invite").value, invite);
  ui.$("username").value = "alice"; ui.$("password").value = "a-long-enough-password";
  ui.$("authForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick(); await tick();
  const register = ui.calls.find(([path]) => path === "/api/hub/register"); assert.equal(JSON.parse(register[1].body).invite, invite);
  assert.equal(ui.$("auth").hidden, true); assert.equal(ui.dom.window.document.activeElement, ui.$("deviceName")); ui.dom.window.close();
});
test("connector setup survives login and focuses desktop pairing", async () => {
  let authenticated = false;
  const ui = setup(async (path) => {
    if (path === "/api/hub/me") return authenticated ? json(account) : json({ error: "LOGIN_REQUIRED" }, 401);
    if (path === "/api/hub/login") authenticated = true;
    return json(account);
  }, "https://hub.test/?setup=connector");
  await ui.panel.ready; assert.equal(ui.$("setupContext").hidden, false);
  ui.$("username").value = "alice"; ui.$("password").value = "account-password";
  ui.$("authForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick(); await tick();
  assert.ok(ui.calls.some(([path]) => path === "/api/hub/login")); assert.equal(ui.$("auth").hidden, true);
  assert.equal(ui.dom.window.document.activeElement, ui.$("deviceName")); ui.dom.window.close();
});
