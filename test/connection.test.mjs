import test from "node:test";
import assert from "node:assert/strict";
import { createApi, syncPollDelay } from "../public/connection.js";

const jsonResponse = (status, value) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => value
});

test("concurrent GET 401 responses share one session refresh and retry once", async () => {
  let releaseRefresh;
  const refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
  const calls = [];
  const counts = new Map();
  const api = createApi({
    headers: { "X-Bridge-Client": "mobile-v1" },
    fetchImpl: async (path, options) => {
      calls.push([path, options]);
      if (path === "/") {
        await refreshGate;
        return jsonResponse(200, {});
      }
      const count = (counts.get(path) || 0) + 1;
      counts.set(path, count);
      return count === 1 ? jsonResponse(401, {}) : jsonResponse(200, { path });
    }
  });

  const first = api("/api/status");
  const second = api("/api/threads");
  while (!calls.some(([path]) => path === "/")) await new Promise(resolve => setImmediate(resolve));
  releaseRefresh();

  assert.deepEqual(await Promise.all([first, second]), [{ path: "/api/status" }, { path: "/api/threads" }]);
  assert.equal(calls.filter(([path]) => path === "/").length, 1);
  assert.equal(counts.get("/api/status"), 2);
  assert.equal(counts.get("/api/threads"), 2);
  assert.ok(calls.every(([, options]) => options.credentials === "same-origin"));
  assert.ok(calls.every(([, options]) => options.headers["X-Bridge-Client"] === "mobile-v1"));
});

test("a POST 401 is never refreshed or retried", async () => {
  const calls = [];
  const api = createApi({
    fetchImpl: async (path, options) => {
      calls.push([path, options]);
      return jsonResponse(401, { error: "unauthorized" });
    }
  });

  await assert.rejects(api("/api/threads/id/messages", {
    method: "POST",
    body: JSON.stringify({ prompt: "hello" })
  }), error => error.status === 401 && error.message === "unauthorized");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/api/threads/id/messages");
});

test('conditional GET returns an isolated cached snapshot on bodyless 304 and mutations invalidate it', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (path, options) => {
    calls.push(options);
    if (options.headers['If-None-Match']) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ thread: { title: 'Original' } }), { headers: { ETag: '"snapshot"' } });
  } });
  const first = await api('/api/threads/00000000-0000-0000-0000-000000000001');
  first.thread.title = 'Changed locally';
  assert.equal((await api('/api/threads/00000000-0000-0000-0000-000000000001')).thread.title, 'Original');
  assert.equal(calls[1].headers['If-None-Match'], '"snapshot"');
  await api('/api/threads/id/messages', { method: 'POST', body: '{}' });
  await api('/api/threads/00000000-0000-0000-0000-000000000001');
  assert.equal(calls.at(-1).headers['If-None-Match'], undefined);
});

test('snapshot validators are private to each API instance and fresh GETs after mutation cannot reuse old validators', async () => {
  const calls = [];
  const fetchImpl = async (path, options) => {
    calls.push(options.headers['If-None-Match']);
    return new Response('{}', { headers: { ETag: '"private"' } });
  };
  const accountA = createApi({ fetchImpl }), accountB = createApi({ fetchImpl });
  await accountA('/api/status'); await accountA('/api/status'); await accountB('/api/status');
  assert.deepEqual(calls, [undefined, '"private"', undefined]);
});

test('idle sync backs off while running, approvals and unavailable desktop remain fast', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(idlePolls => syncPollDelay({ idlePolls })), [10000, 10000, 20000, 20000, 30000, 30000]);
  for (const option of ['active', 'pending', 'unavailable']) assert.equal(syncPollDelay({ [option]: true, idlePolls: 10 }), 3000);
});
