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

test('unexpected mutation 304 is uncertain and never retried, refreshed or cached', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const calls = [], snapshots = [];
    const api = createApi({ fetchImpl: async (path, options) => { calls.push({ path, ...options }); return new Response(null, { status: 304 }); }, onSnapshot: (...snapshot) => snapshots.push(snapshot) });
    await assert.rejects(api('/api/threads/id/messages', { method, body: '{}' }), { code: 'DELIVERY_UNKNOWN', status: 409 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, method);
    assert.equal(calls[0].headers['If-None-Match'], undefined);
    assert.deepEqual(snapshots, []);
  }
});

test('conditional GET returns an isolated cached snapshot on bodyless 304 and mutations invalidate it', async () => {
  const calls = [];
  const api = createApi({ fetchImpl: async (path, options) => {
    calls.push(options);
    if (options.headers['If-None-Match']) return new Response(null, { status: 304 });
    return new Response(JSON.stringify({ thread: { id: '00000000-0000-0000-0000-000000000001', title: 'Original' }, turns: [] }), { headers: { ETag: '"snapshot"' } });
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

test('invalid success JSON and mismatched thread shapes never enter the snapshot cache', async () => {
  const id = '00000000-0000-0000-0000-000000000001', path = `/api/threads/${id}`;
  for (const [body, code] of [['{', 'RESPONSE_INVALID'], ['null', 'RESPONSE_INVALID'], ['[]', 'RESPONSE_INVALID'],
    [JSON.stringify({ thread: { id: 'wrong' }, turns: [] }), 'THREAD_MISMATCH'], [JSON.stringify({ thread: { id }, turns: {} }), 'RESPONSE_INVALID']]) {
    let calls = 0; const snapshots = [];
    const api = createApi({ onSnapshot: (...args) => snapshots.push(args), fetchImpl: async (_path, options) => {
      assert.equal(options.headers['If-None-Match'], undefined);
      return ++calls === 1 ? new Response(body, { headers: { ETag: '"broken"' } })
        : new Response(JSON.stringify({ thread: { id }, turns: [] }), { headers: { ETag: '"healthy"' } });
    } });
    await assert.rejects(api(path), { code });
    assert.deepEqual(snapshots, []);
    assert.equal((await api(path)).thread.id, id); assert.equal(calls, 2);
  }
});

test('304 cannot reuse another thread or cursor snapshot and an explicit wrong validator fails closed', async () => {
  const a = '00000000-0000-0000-0000-000000000001', b = '00000000-0000-0000-0000-000000000002';
  const paths = [`/api/threads/${a}`, `/api/threads/${b}`, `/api/threads/${a}?cursor=older`];
  const calls = [], snapshots = [];
  let wrongValidator = false;
  const api = createApi({ onSnapshot: path => snapshots.push(path), fetchImpl: async (path, options) => {
    const etag = options.headers['If-None-Match']; calls.push({ path, etag });
    if (etag) return new Response(null, { status: 304, headers: { ETag: wrongValidator ? '"unrelated"' : etag } });
    const id = path.includes(b) ? b : a;
    return new Response(JSON.stringify({ thread: { id }, turns: [], page: { nextCursor: path.includes('?') ? null : 'older' } }), { headers: { ETag: JSON.stringify(path) } });
  } });
  for (const path of paths) { await api(path); await api(path); }
  assert.deepEqual(calls.map(call => call.etag), [undefined, JSON.stringify(paths[0]), undefined, JSON.stringify(paths[1]), undefined, JSON.stringify(paths[2])]);
  assert.equal((await api(paths[0])).thread.id, a);
  wrongValidator = true; const before = snapshots.length;
  await assert.rejects(api(paths[0]), { code: 'RESPONSE_INVALID' }); assert.equal(snapshots.length, before);
});

test('an uncached repeated 304 and invalid mutation response cannot masquerade as an empty success', async () => {
  let calls = 0;
  const api = createApi({ fetchImpl: async () => { calls++; return new Response(null, { status: 304 }); } });
  await assert.rejects(api('/api/status'), { code: 'RESPONSE_INVALID' }); assert.equal(calls, 2);
  for (const body of ['', '{', 'null', '[]']) {
    let writes = 0;
    const write = createApi({ fetchImpl: async () => { writes++; return new Response(body); } });
    await assert.rejects(write('/api/threads/id/messages', { method: 'POST', body: '{}' }), { code: 'DELIVERY_UNKNOWN' }); assert.equal(writes, 1);
  }
});
