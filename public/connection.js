const DEVICE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function deviceIdFromPath(pathname) {
  const match = /^\/devices\/([^/]+)\/$/.exec(pathname);
  if (!match) { if (pathname.startsWith("/devices/")) throw new Error("设备地址无效"); return null; }
  if (!DEVICE_UUID.test(match[1])) throw new Error("设备地址无效");
  return match[1].toLowerCase();
}
export function scopedStorage(storage, prefix = "") {
  const backing = () => typeof storage === "function" ? storage() : storage;
  const keys = () => Array.from({ length: backing().length }, (_, index) => backing().key(index)).filter(key => key?.startsWith(prefix));
  return {
    get length() { return keys().length; },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem: key => backing().getItem(prefix + key),
    setItem: (key, value) => backing().setItem(prefix + key, value),
    removeItem: key => backing().removeItem(prefix + key)
  };
}
export function createDeviceContext({ pathname, context = null, fetchImpl = fetch, window }) {
  const id = deviceIdFromPath(pathname);
  if (id && (!context?.user?.id || typeof context.user.id !== "string" || context.device?.id?.toLowerCase() !== id)) throw new Error("无法确认设备所属账户");
  const base = id ? `/devices/${id}/` : "/";
  const prefix = id ? `codex-hub:${encodeURIComponent(context.user.id)}:${id}:` : "";
  let expired = false, requestSequence = 0, lastConnectionSequence = 0;
  const setOnline = (online, sequence, code = null) => {
    if (sequence < lastConnectionSequence) return;
    lastConnectionSequence = sequence;
    if (context.device.online === online) return;
    context.device.online = online;
    window.dispatchEvent(new window.CustomEvent("bridge-device-state-changed", { detail: { online, code } }));
  };
  const requireLogin = () => { expired = true; window.dispatchEvent(new window.Event("bridge-login-required")); };
  const acceptSnapshot = (path, body) => {
    if (!id || !["/api/access", "/api/status"].includes(path)) return;
    if (body.device?.id === id && typeof body.device.name === "string") context.device.name = body.device.name;
  };
  window.addEventListener("bridge-login-required", () => { expired = true; });
  return {
    id, base, context, acceptSnapshot,
    sessionStorage: scopedStorage(() => window.sessionStorage, prefix), localStorage: scopedStorage(() => window.localStorage, prefix),
    async fetch(path, options = {}) {
      if (id && (typeof path !== "string" || (path !== "/" && !path.startsWith("/api/")) || path.includes("\\") || /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(path.split("?")[0]))) throw new Error("请求地址无效");
      const method = (options.method || "GET").toUpperCase();
      if (id && method !== "GET" && (expired || context.device.online !== true)) {
        const error = new Error(expired ? "请重新登录后继续" : "设备离线，暂时无法操作");
        error.code = expired ? "LOGIN_REQUIRED" : "DEVICE_OFFLINE"; error.status = expired ? 401 : 503; throw error;
      }
      const sequence = ++requestSequence;
      const response = await fetchImpl(id ? base + path.slice(1) : path, options);
      if (id && response.status === 401) requireLogin();
      if (id && response.status === 503) {
        try {
          if ((await response.clone().json()).code === "DEVICE_OFFLINE") {
            setOnline(false, sequence, "DEVICE_OFFLINE");
          }
        } catch {}
      }
      if (id && (response.ok || response.status === 304) && path.startsWith("/api/")) {
        if (path === "/api/access") {
          try {
            const body = await response.clone().json();
            if (body.device?.id === id && typeof body.device.online === "boolean") setOnline(body.device.online, sequence);
            acceptSnapshot(path, body);
          } catch {}
        } else {
          // A successful relay response proves transport reachability, including bodyless 304s.
          setOnline(true, sequence);
        }
      }
      return response;
    }
  };
}
export async function loadDeviceContext({ window, fetchImpl = fetch }) {
  const id = deviceIdFromPath(window.location.pathname);
  let context = null;
  if (id) {
    const response = await fetchImpl(`/devices/${id}/context`, { credentials: "same-origin", headers: { "X-Bridge-Client": "mobile-v1" } });
    if (!response.ok) { const error = new Error(response.status === 401 ? "请登录后访问设备" : "设备不存在或无权访问"); error.status = response.status; throw error; }
    context = await response.json();
  }
  return createDeviceContext({ pathname: window.location.pathname, context, window, fetchImpl });
}

export function createApi({ fetchImpl = fetch, headers = {}, onSnapshot = () => {}, onLoginRequired = () => {
  if (typeof window !== "undefined") window.dispatchEvent(new window.Event("bridge-login-required"));
} } = {}) {
  let sessionGeneration = 0;
  let refreshPromise = null;
  let loginRequired = false;
  const snapshots = new Map();
  let cacheBytes = 0;
  let cacheGeneration = 0;
  const conditionalPath = path => /^\/api\/(?:status|threads(?:\/[0-9a-f-]+(?:\/control)?)?)(?:\?|$)/i.test(path);
  function clearSnapshots() { snapshots.clear(); cacheBytes = 0; cacheGeneration += 1; }
  function saveSnapshot(path, etag, body) {
    const bytes = JSON.stringify(body).length * 2;
    if (!etag || bytes > 1024 * 1024) return;
    if (snapshots.has(path)) { cacheBytes -= snapshots.get(path).bytes; snapshots.delete(path); }
    snapshots.set(path, { etag, body: structuredClone(body), bytes }); cacheBytes += bytes;
    while (snapshots.size > 32 || cacheBytes > 4 * 1024 * 1024) {
      const key = snapshots.keys().next().value; cacheBytes -= snapshots.get(key).bytes; snapshots.delete(key);
    }
  }

  function invalidResponse(method, code = "RESPONSE_INVALID", message = "电脑返回的数据不完整，请刷新重试") {
    return Object.assign(new Error(method === "GET" ? message : "提交结果尚未确认，请先核对送达回执"), {
      code: method === "GET" ? code : "DELIVERY_UNKNOWN", status: method === "GET" ? 502 : 409
    });
  }
  function validateBody(path, body, method) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidResponse(method);
    const match = /^\/api\/threads\/([0-9a-f-]+)(?:\?|$)/i.exec(path);
    if (method === "GET" && match) {
      if (body.thread?.id !== match[1]) throw invalidResponse(method, "THREAD_MISMATCH", "返回的会话与请求不匹配，已有内容和草稿仍保留。");
      if (!Array.isArray(body.turns)) throw invalidResponse(method);
    }
  }

  async function send(path, options) {
    return fetchImpl(path, {
      ...options,
      credentials: "same-origin",
      headers: { ...headers, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
    });
  }

  async function refreshSession() {
    if (!refreshPromise) {
      const refresh = send("/", { method: "GET" }).then(response => {
        if (!response.ok) {
          const error = new Error(`会话续期失败（${response.status}）`);
          error.code = "SESSION_REFRESH_FAILED";
          error.status = response.status;
          throw error;
        }
        sessionGeneration += 1;
      });
      refreshPromise = refresh.finally(() => { refreshPromise = null; });
    }
    return refreshPromise;
  }

  return async function api(path, options = {}) {
    const method = (options.method || "GET").toUpperCase();
    const conditional = method === "GET" && conditionalPath(path);
    if (method !== "GET") clearSnapshots();
    if (loginRequired && method !== "GET") {
      const error = new Error("请重新登录后继续");
      error.code = "LOGIN_REQUIRED";
      error.status = 401;
      throw error;
    }
    const generation = sessionGeneration;
    const snapshotGeneration = cacheGeneration;
    const cached = conditional ? snapshots.get(path) : null;
    const conditionalOptions = cached ? { ...options, headers: { ...options.headers, "If-None-Match": cached.etag } } : options;
    let response = await send(path, conditionalOptions);
    if (response.status === 304 && method !== "GET") {
      const error = new Error("提交结果尚未确认，请先核对送达回执");
      error.code = "DELIVERY_UNKNOWN";
      error.status = 409;
      throw error;
    }
    if (response.status === 304 && cached && snapshotGeneration === cacheGeneration) {
      const etag = response.headers?.get?.("etag");
      if (etag && etag !== cached.etag) throw invalidResponse(method);
      const body = structuredClone(cached.body); validateBody(path, body, method); onSnapshot(path, body); return body;
    }
    if (response.status === 304) response = await send(path, options);
    let body;
    try { body = await response.json(); } catch (error) {
      if (error.name === "AbortError" || options.signal?.aborted) throw error;
      if (response.ok || response.status === 304) throw invalidResponse(method);
      body = {};
    }
    if (response.status === 401 && body.code === "LOGIN_REQUIRED") {
      clearSnapshots();
      loginRequired = true;
      onLoginRequired();
    } else if (response.status === 401 && method === "GET") {
      clearSnapshots();
      if (generation === sessionGeneration) await refreshSession();
      response = await send(path, options);
      try { body = await response.json(); } catch (error) {
        if (error.name === "AbortError" || options.signal?.aborted) throw error;
        if (response.ok || response.status === 304) throw invalidResponse(method);
        body = {};
      }
      if (response.status === 401 && body.code === "LOGIN_REQUIRED") { loginRequired = true; onLoginRequired(); }
    }
    if (!response.ok) {
      const messages = {
        DEVICE_OFFLINE: "设备离线，请等待电脑重新连接",
        DEVICE_RECONNECTING: "设备正在重新连接，请稍后重试",
        DEVICE_BUSY: "设备请求繁忙，请稍后重试",
        ACCOUNT_BUSY: "当前账户请求繁忙，请稍后重试",
        HUB_BUSY: "入口请求繁忙，请稍后重试",
        BRIDGE_BUSY: "电脑端转发繁忙，请稍后重试",
        BRIDGE_UNAVAILABLE: "电脑端桥接暂时不可用",
        BRIDGE_ROUTE_UNSUPPORTED: "电脑端连接器不支持此请求，请更新并重启连接器",
        RELAY_TIMEOUT: "读取电脑响应超时，请稍后重试",
      };
      const message = messages[body.code] && (!body.error || body.error === body.code) ? messages[body.code] : body.error;
      const error = new Error(typeof message === "string" ? message : `请求失败（${response.status}）`);
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    validateBody(path, body, method);
    if (conditional && snapshotGeneration === cacheGeneration) saveSnapshot(path, response.headers?.get?.("etag"), body);
    if (method === "GET") onSnapshot(path, body);
    return body;
  };
}

export function syncPollDelay({ active = false, pending = false, unavailable = false, idlePolls = 0 } = {}) {
  if (active || pending || unavailable) return 3000;
  return idlePolls < 2 ? 10000 : idlePolls < 4 ? 20000 : 30000;
}
