import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initializeLogin } from "../public/login.js";

test("login denial and unknown network result clear secret without retry or persistence", async () => {
  for (const outcome of [401, 429, "network"]) {
    const dom = new JSDOM('<form id="loginForm"><input id="password"><button id="loginButton"></button><p id="loginError"></p></form>', { url: "https://example.test/login" });
    let calls = 0;
    initializeLogin({ document: dom.window.document, fetchImpl: async (path, options) => { calls++; assert.equal(path, "/auth/login"); assert.equal(JSON.parse(options.body).password, "secret"); if (outcome === "network") throw new Error("secret"); return { ok: false, status: outcome }; } });
    dom.window.document.getElementById("password").value = "secret";
    dom.window.document.getElementById("loginForm").dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1); assert.equal(dom.window.document.getElementById("password").value, "");
    assert.equal(dom.window.localStorage.length, 0); assert.equal(dom.window.sessionStorage.length, 0);
    assert.ok(!dom.window.document.getElementById("loginError").textContent.includes("secret"));
  }
});
