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
test("successful pairing survives ordinary refresh but account switch clears it", async () => {
  let result = account;
  const ui = setup(async (path) => path === "/api/hub/pairings" ? json({ pairingCode: "private-code", expiresAt: Date.now() + 600000 }) : json(result)); await ui.panel.ready;
  ui.$("pairForm").dispatchEvent(new ui.dom.window.Event("submit", { cancelable: true })); await tick(); assert.equal(ui.$("pairCode").value, "private-code");
  await ui.panel.refresh(); assert.equal(ui.$("pairCode").value, "private-code");
  result = { ...account, user: { id: "other", username: "bob", role: "user" } }; await ui.panel.refresh(); assert.equal(ui.$("pairCode").value, ""); assert.equal(ui.$("admin").hidden, true); ui.dom.window.close();
});
