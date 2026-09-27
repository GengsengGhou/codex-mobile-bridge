import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createApi } from "../public/connection.js";
import { createAccessPanel } from "../public/access.js";
const tick = () => new Promise(resolve => setImmediate(resolve));
test("remote expiry signals login and never refreshes or retries mutations", async () => {
  let calls = 0, signals = 0;
  const api = createApi({ onLoginRequired: () => signals++, fetchImpl: async () => { calls++; return { ok: false, status: 401, json: async () => ({ code: "LOGIN_REQUIRED" }) }; } });
  await assert.rejects(api("/api/status"), { code: "LOGIN_REQUIRED" });
  await assert.rejects(api("/api/action", { method: "POST" }), { code: "LOGIN_REQUIRED" });
  assert.equal(calls, 1); assert.equal(signals, 1);
});
test("revoke needs confirmation and lost response reconciles status without replay", async () => {
  const dom = new JSDOM('<aside id="taskDrawer"><div class="drawer-foot"></div></aside>', { url: "https://example.test" });
  const calls = [];
  const panel = createAccessPanel({ document: dom.window.document, window: dom.window, api: async () => ({ mode: "remote" }), fetchImpl: async (path) => { calls.push(path); if (path === "/auth/status") return { ok: true, json: async () => ({ authenticated: false }) }; throw new Error(); } });
  await panel.ready;
  const revoke = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "撤销全部登录");
  revoke.click(); assert.equal(calls.length, 0); revoke.click(); await tick();
  assert.deepEqual(calls, ["/auth/revoke-all", "/auth/status"]);
  assert.equal(dom.window.document.querySelector(".access-notice").hidden, false);
});
test("local setup probes only when opened and never starts automatically", async () => {
  const dom = new JSDOM('<aside id="taskDrawer"></aside>', { url: "http://localhost" }); const calls = [];
  const panel = createAccessPanel({ document: dom.window.document, window: dom.window, api: async (path, options) => { calls.push([path, options]); return path === "/api/access" ? { mode: "local" } : { state: "stopped", supported: true }; } });
  await panel.ready; assert.equal(calls.length, 1);
  dom.window.document.getElementById("remoteAccessSettings").click(); await tick();
  assert.equal(calls[1][0], "/api/remote-access"); assert.equal(calls[1][1], undefined);
});

function localSetup(api) {
  const dom = new JSDOM('<aside id="taskDrawer"></aside>', { url: "http://localhost" });
  const panel = createAccessPanel({ document: dom.window.document, window: dom.window, api: (path, options) => path === "/api/access" ? Promise.resolve({ mode: "local" }) : api(options) });
  return { dom, panel, click: id => dom.window.document.getElementById(id).click() };
}
const stopped = { state: "stopped", supported: true, installed: true };
test("stale setup read cannot clear newly issued code, hiding keeps code", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let reads = 0, resolveRead;
  const ui = localSetup(async options => {
    if (options) return { ...stopped, state: "starting", accessCode: "once-only" };
    if (++reads === 1) return stopped;
    return new Promise(resolve => { resolveRead = resolve; });
  });
  await ui.panel.ready; ui.click("remoteAccessSettings"); await tick();
  ui.click("remoteAccessSettings"); ui.click("remoteAccessSettings"); await tick();
  ui.click("remoteAccessStart"); await tick();
  resolveRead(stopped); await tick();
  assert.equal(ui.dom.window.document.getElementById("remoteAccessCode").value, "once-only");
  ui.click("remoteAccessSettings"); t.mock.timers.tick(5000); await tick();
  assert.equal(reads, 2);
  assert.equal(ui.dom.window.document.getElementById("remoteAccessCode").value, "once-only");
});
test("closing a pending setup read prevents hidden polling", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveRead, reads = 0;
  const ui = localSetup(() => { reads++; return new Promise(resolve => { resolveRead = resolve; }); });
  await ui.panel.ready; ui.click("remoteAccessSettings"); ui.click("remoteAccessSettings");
  resolveRead({ ...stopped, state: "starting" }); await tick(); t.mock.timers.tick(10000); await tick();
  assert.equal(reads, 1);
});
test("unknown setup status disables start until confirmed installed", async () => {
  let fail = true;
  const ui = localSetup(async () => { if (fail) throw new Error(); return stopped; });
  await ui.panel.ready;
  const start = ui.dom.window.document.getElementById("remoteAccessStart"); assert.equal(start.disabled, true);
  ui.click("remoteAccessSettings"); await tick(); assert.equal(start.disabled, true);
  fail = false; ui.click("remoteAccessSettings"); ui.click("remoteAccessSettings"); await tick(); assert.equal(start.disabled, false);
});
