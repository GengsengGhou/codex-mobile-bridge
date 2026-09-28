import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { createThreadContextPanel } from "../public/thread-context.js";
import { createDeviceContext } from "../public/connection.js";

const A = "00000000-0000-0000-0000-000000000001", B = "00000000-0000-0000-0000-000000000002", C = "00000000-0000-0000-0000-000000000003";
const options = { permissionOptions: { send: [{ id: "full-access" }, { id: "request-approval" }], create: [] } };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function mount(t, api, mobile = false, storageFactory) {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { url: "http://127.0.0.1" }); t.after(() => dom.window.close());
  const { window } = dom; window.matchMedia = () => ({ matches: !mobile, addEventListener() {} });
  const selected = [], notices = [];
  const panel = createThreadContextPanel({ document: window.document, window, api, storage: storageFactory?.(window) || window.sessionStorage, onSelectThread: id => selected.push(id), onNotice: value => notices.push(value) });
  panel.setState({ status: options, connected: true, sendMode: "message" }); panel.setThread(A);
  const change = value => { const select = window.document.getElementById("messagePermission"); select.value = value; select.dispatchEvent(new window.Event("change")); };
  return { window, doc: window.document, panel, change, selected, notices };
}
function context(id = A) { return { threadId: id, available: true, permissions: { current: "request-approval", canOverride: true }, git: { available: true, branch: "feature/context", commit: "a".repeat(40), dirty: true }, agents: { available: true, items: [] }, sources: { available: true, items: [] } }; }

test("permissions preserve thread choice, omit inheritance and active overrides, and fail closed on older backends", async t => {
  const ui = await mount(t, async () => context());
  assert.deepEqual(ui.panel.sendOverride(), {}); ui.change("full-access");
  assert.deepEqual(ui.panel.sendOverride(), { permissionMode: "full-access" });
  ui.panel.setThread(B); assert.equal(ui.doc.getElementById("messagePermission").value, "");
  ui.panel.setThread(A); assert.equal(ui.doc.getElementById("messagePermission").value, "full-access");
  ui.panel.setState({ status: options, connected: true, sendMode: "follow-up" });
  assert.deepEqual(ui.panel.sendOverride(), {}); assert.match(ui.doc.getElementById("permissionState").textContent, /本轮补充沿用当前权限/);
  assert.equal(ui.window.sessionStorage.getItem(`codex-mobile-permission:${A}`), "full-access");
  ui.panel.setState({ status: {}, connected: true, sendMode: "message" });
  assert.throws(() => ui.panel.sendOverride(), { code: "PERMISSION_UNAVAILABLE" });
  ui.change(""); assert.deepEqual(ui.panel.sendOverride(), {}); assert.equal(ui.doc.getElementById("permissionState").hidden, true);
});

test("context opens only on demand, renders safe nested data and reports partial/empty states", async t => {
  let reads = 0;
  const ui = await mount(t, async () => { reads++; return { ...context(), agents: { available: true, partial: true, items: [{ threadId: B, name: "长名称".repeat(80), path: "/root/worker", status: "running", canRead: true }, { threadId: C, parentThreadId: B, name: "子代理", path: "/root/worker/child", status: "idle", canRead: false }] }, sources: { available: true, partial: true, items: [{ type: "web", label: "<script>bad</script>", url: "javascript:alert(1)" }, { type: "file", label: "run.slurm", path: "E:/" + "long-path/".repeat(40) }, { type: "tool", label: "weather · current", count: 2 }] } }; });
  assert.equal(ui.doc.getElementById("threadContext").hidden, true); assert.equal(reads, 0);
  ui.doc.getElementById("contextToggle").click(); await tick();
  assert.equal(reads, 1); assert.match(ui.doc.getElementById("contextContent").textContent, /feature\/context/);
  assert.equal(ui.doc.querySelectorAll("#contextContent script").length, 0); assert.equal(ui.doc.querySelectorAll("#contextContent a").length, 0);
  assert.equal(ui.doc.querySelectorAll(".context-agent")[1].style.getPropertyValue("--agent-depth"), "1");
  assert.match(ui.doc.getElementById("contextContent").textContent, /部分代理信息/);
  ui.doc.querySelector("button.context-item-title").click(); assert.deepEqual(ui.selected, [B]); assert.equal(ui.doc.getElementById("threadContext").hidden, true);
});

test("an active context does not mark next-turn permission capability permanently unavailable", async t => {
  const ui = await mount(t, async () => ({ ...context(), permissions: { current: "full-access", supported: true, canOverride: false, reason: "正在运行" } }));
  ui.panel.setState({ status: options, connected: true, sendMode: "follow-up" });
  ui.doc.getElementById("contextToggle").click(); await tick(); ui.change("request-approval");
  assert.deepEqual(ui.panel.sendOverride(), {});
  ui.panel.setState({ status: options, connected: true, sendMode: "message" });
  assert.deepEqual(ui.panel.sendOverride(), { permissionMode: "request-approval" });
});

test("late context cannot cross conversations and disconnected data is marked unavailable", async t => {
  let finish;
  const ui = await mount(t, id => id.includes(A) ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ...context(B), git: { available: false, reason: "不属于 Git 仓库" } }));
  ui.doc.getElementById("contextToggle").click(); ui.panel.setThread(B); await tick();
  assert.match(ui.doc.getElementById("contextContent").textContent, /不属于 Git 仓库/);
  finish({ ...context(A), git: { available: true, branch: "wrong-thread" } }); await tick();
  assert.ok(!ui.doc.getElementById("contextContent").textContent.includes("wrong-thread"));
  ui.panel.setState({ status: options, connected: false });
  assert.match(ui.doc.getElementById("contextState").textContent, /连接中断/);
  assert.equal(ui.doc.getElementById("contextContent").dataset.stale, "true");
});

test("mobile context is modal, focus stays reachable and Escape restores the toggle", async t => {
  const ui = await mount(t, async () => context(), true);
  ui.doc.getElementById("contextToggle").click(); await tick();
  assert.equal(ui.doc.getElementById("threadContext").getAttribute("aria-modal"), "true");
  assert.equal(ui.doc.querySelector(".conversation").inert, true);
  assert.equal(ui.doc.getElementById("contextScrim").hidden, false);
  assert.equal(ui.doc.activeElement.id, "closeContext");
  ui.doc.getElementById("threadContext").dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
  assert.equal(ui.doc.activeElement.id, "refreshContext");
  ui.doc.getElementById("threadContext").dispatchEvent(new ui.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(ui.doc.querySelector(".conversation").inert, false); assert.equal(ui.doc.activeElement.id, "contextToggle");
});

test("clearing an archived selection aborts the drawer and a late context cannot reopen it", async t => {
  let finish;
  const ui = await mount(t, () => new Promise(resolve => { finish = resolve; }), true);
  ui.doc.getElementById("contextToggle").click();
  assert.equal(ui.doc.querySelector(".conversation").inert, true);
  ui.panel.setThread(null); finish(context()); await tick();
  assert.equal(ui.doc.getElementById("threadContext").hidden, true); assert.equal(ui.doc.getElementById("contextToggle").disabled, true);
  assert.equal(ui.doc.querySelector(".conversation").inert, false); assert.equal(ui.doc.getElementById("contextContent").textContent, "");
});

test("a permission saved for a device cannot appear in another device or account", async t => {
  const shared = new JSDOM("", { url: "https://hub.test" }); t.after(() => shared.window.close());
  const store = (device, user) => createDeviceContext({ pathname: `/devices/${device}/`, context: { user: { id: user }, device: { id: device, online: true } }, window: shared.window }).sessionStorage;
  const first = await mount(t, async () => context(), false, () => store(A, "account-a")); first.change("request-approval");
  const second = await mount(t, async () => context(), false, () => store(B, "account-a"));
  const third = await mount(t, async () => context(), false, () => store(A, "account-b"));
  assert.equal(second.doc.getElementById("messagePermission").value, ""); assert.equal(third.doc.getElementById("messagePermission").value, "");
});
