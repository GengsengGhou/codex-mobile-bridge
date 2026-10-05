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

test('304 cannot reuse another thread or cursor snapshot and a different validator requires a fresh validated read', async () => {
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
  assert.equal((await api(paths[0])).thread.id, a); assert.equal(snapshots.length, before + 1);
  assert.equal(calls.at(-1).etag, undefined, 'the unrelated validator cannot authorize cached content');
});

test('GET 304 accepts only RFC weak equality and returns isolated copies across repeated polls', async () => {
  for (const [first, next] of [['"same"', 'W/"same"'], ['W/"same"', '"same"'], ['W/"same"', 'W/"same"'], ['""', 'W/""']]) {
    let calls = 0;
    const api = createApi({ fetchImpl: async (_path, options) => {
      if (++calls === 1) return new Response('{"connected":true}', { headers: { ETag: first } });
      assert.equal(options.headers['If-None-Match'], first);
      return new Response(null, { status: 304, headers: { ETag: next } });
    } });
    (await api('/api/status')).connected = false;
    for (let i = 0; i < 4; i++) assert.equal((await api('/api/status')).connected, true);
    assert.equal(calls, 5);
  }
});

test('opaque validator recovery is bounded, removes conditional headers, and pauses rather than continually retrying', async t => {
  const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  t.after(() => { Date.now = originalNow; });
  const calls = []; let divergent = true;
  const api = createApi({ headers: { 'if-none-match': 'global-validator' }, fetchImpl: async (_path, options) => {
    calls.push(options);
    if (options.headers['If-None-Match']) return new Response(null, { status: 304, headers: { ETag: divergent ? '"unrelated"' : 'W/"compressed"' } });
    return new Response('{"connected":true}', { headers: { ETag: '"compressed"' } });
  } });
  const opts = { headers: { 'iF-NoNe-MaTcH': 'caller-validator' } };
  await api('/api/status'); await api('/api/status', opts);
  assert.equal(calls.length, 3);
  assert.ok(Object.keys(calls.at(-1).headers).every(key => key.toLowerCase() !== 'if-none-match'));
  assert.equal(calls.at(-1).cache, 'no-store');
  now += 10000; await api('/api/status', opts); assert.equal(calls.length, 4);
  now += 10000; await api('/api/status', opts); assert.equal(calls.length, 5);
  assert.ok(calls.slice(3).every(call => Object.keys(call.headers).every(key => key.toLowerCase() !== 'if-none-match')));
  divergent = false; now += 10001; await api('/api/status');
  assert.equal(calls.length, 6); assert.equal(calls.at(-1).headers['If-None-Match'], '"compressed"', 'intermediate 200s do not prolong the 30-second pause');
  await api('/api/status'); assert.equal(calls.length, 7);
});

test('unconditional recovery rejects repeated 304, bad JSON, wrong IDs and invalid shapes with safe reason and stage', async () => {
  const id = '00000000-0000-0000-0000-000000000001', path = `/api/threads/${id}`;
  for (const [reply, reason, code] of [
    [() => new Response(null, { status: 304 }), 'unexpected-not-modified', 'RESPONSE_INVALID'],
    [() => new Response('{'), 'json-parse', 'RESPONSE_INVALID'],
    [() => new Response('null'), 'json-shape', 'RESPONSE_INVALID'],
    [() => new Response(JSON.stringify({ thread: { id: 'wrong' }, turns: [] })), 'thread-identity', 'THREAD_MISMATCH'],
    [() => new Response(JSON.stringify({ thread: { id }, turns: {} })), 'thread-turns-shape', 'RESPONSE_INVALID']
  ]) {
    let calls = 0; const snapshots = [];
    const api = createApi({ onSnapshot: body => snapshots.push(body), fetchImpl: async (_path, options) => {
      calls++;
      if (calls === 1) return new Response(JSON.stringify({ thread: { id }, turns: [] }), { headers: { ETag: '"cached"' } });
      if (calls === 2) return new Response(null, { status: 304, headers: { ETag: '"unrelated"' } });
      assert.equal(options.headers['If-None-Match'], undefined); assert.equal(options.cache, 'no-store'); return reply();
    } });
    await api(path);
    await assert.rejects(api(path), error => error.code === code && error.reason === reason && error.stage === 'conditional-recovery');
    assert.equal(calls, 3); assert.equal(snapshots.length, 1);
  }
});

test('validator cooldown is scoped to the exact page and API instance, and mutation invalidation removes it', async () => {
  const a = '00000000-0000-0000-0000-000000000001', b = '00000000-0000-0000-0000-000000000002';
  const path = `/api/threads/${a}`, seen = [];
  const create = () => createApi({ fetchImpl: async (route, options) => {
    seen.push({ route, validator: options.headers['If-None-Match'] });
    if (options.headers['If-None-Match']) return new Response(null, { status: 304, headers: { ETag: '"different"' } });
    return new Response(JSON.stringify(options.method === 'POST' ? { accepted: true } : { thread: { id: route.includes(b) ? b : a }, turns: [] }), { headers: { ETag: '"current"' } });
  } });
  const first = create(); await first(path); await first(path); await first(`${path}?cursor=older`);
  await first(`/api/threads/${b}`); const other = create(); await other(path);
  await first(path, { method: 'POST', body: '{}' }); await first(path); await first(path);
  assert.deepEqual(seen.map(call => call.validator), [undefined, '"current"', undefined, undefined, undefined, undefined, undefined, undefined, '"current"', undefined]);
});

test('an aborted recovery preserves the original cancellation and never issues further requests', async () => {
  const controller = new AbortController(); let calls = 0;
  const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const api = createApi({ fetchImpl: async (_path, options) => {
    calls++;
    if (calls === 1) return new Response('{}', { headers: { ETag: '"first"' } });
    if (calls === 2) return new Response(null, { status: 304, headers: { ETag: '"different"' } });
    assert.equal(options.signal, controller.signal); controller.abort(); throw cancellation;
  } });
  await api('/api/status'); await assert.rejects(api('/api/status', { signal: controller.signal }), error => error === cancellation);
  assert.equal(calls, 3);
});

test('eviction and missing or malformed 200 validators discard both old snapshots and conditional cooldowns', async () => {
  const id = '00000000-0000-0000-0000-000000000001', path = `/api/threads/${id}`;
  for (const nextEtag of [null, 'unquoted', 'w/"invalid"']) {
    let calls = 0; const seen = [];
    const api = createApi({ fetchImpl: async (_path, options) => {
      seen.push(options.headers['If-None-Match']); calls++;
      const etag = calls === 1 ? '"old"' : nextEtag;
      return new Response(JSON.stringify({ thread: { id }, turns: [] }), { headers: etag ? { ETag: etag } : {} });
    } });
    await api(path); await api(path); await api(path);
    assert.deepEqual(seen, [undefined, '"old"', undefined]);
  }
  const seen = [], api = createApi({ fetchImpl: async (route, options) => {
    seen.push(options.headers['If-None-Match']);
    if (options.headers['If-None-Match']) return new Response(null, { status: 304, headers: { ETag: '"divergent"' } });
    return new Response(JSON.stringify({ thread: { id: route.split('/').at(-1) }, turns: [] }), { headers: { ETag: '"current"' } });
  } });
  await api(path); await api(path);
  for (let i = 2; i < 35; i++) await api('/api/threads/00000000-0000-0000-0000-' + String(i).padStart(12, '0'));
  await api(path); assert.equal(seen.at(-1), undefined);
  await api(path); assert.equal(seen.at(-2), '"current"', 'evicted cooldown must not suppress the new entry');
});

test('GET session renewal clears conditional cooldown and uses an unconditional authenticated retry', async () => {
  let failSession = false; const calls = [];
  const api = createApi({ fetchImpl: async (path, options) => {
    calls.push({ path, ...options });
    if (path === '/') { failSession = false; return new Response('renewed'); }
    if (failSession) return new Response('{}', { status: 401 });
    if (options.headers['If-None-Match']) return new Response(null, { status: 304, headers: { ETag: '"other"' } });
    return new Response('{}', { headers: { ETag: '"current"' } });
  } });
  await api('/api/status'); await api('/api/status');
  failSession = true; await api('/api/status'); await api('/api/status');
  assert.equal(calls.filter(call => call.path === '/').length, 1);
  await api('/api/status'); assert.equal(calls.at(-2).headers['If-None-Match'], '"current"', 'renewed session can validate after one fresh cache insert');
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
