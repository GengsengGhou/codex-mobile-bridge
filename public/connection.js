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
  let expired = false;
  const requireLogin = () => { expired = true; window.dispatchEvent(new window.Event("bridge-login-required")); };
  const acceptSnapshot = (path, body) => {
    if (!id || !["/api/access", "/api/status"].includes(path)) return;
    if (body.device?.id === id) { context.device.online = body.device.online; context.device.name = body.device.name; }
    else if (path === "/api/status") context.device.online = body.connected === true;
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
      const response = await fetchImpl(id ? base + path.slice(1) : path, options);
      if (id && response.status === 401) requireLogin();
      if (id && response.status === 503) context.device.online = false;
      if (id && ["/api/access", "/api/status"].includes(path) && response.ok) {
        try { acceptSnapshot(path, await response.clone().json()); } catch {}
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
    if (response.status === 304 && cached && snapshotGeneration === cacheGeneration) { const body = structuredClone(cached.body); onSnapshot(path, body); return body; }
    if (response.status === 304) response = await send(path, options);
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (response.status === 401 && body.code === "LOGIN_REQUIRED") {
      clearSnapshots();
      loginRequired = true;
      onLoginRequired();
    } else if (response.status === 401 && method === "GET") {
      clearSnapshots();
      if (generation === sessionGeneration) await refreshSession();
      response = await send(path, options);
      try { body = await response.json(); } catch { body = {}; }
      if (response.status === 401 && body.code === "LOGIN_REQUIRED") { loginRequired = true; onLoginRequired(); }
    }
    if (!response.ok) {
      const error = new Error(typeof body.error === "string" ? body.error : `请求失败（${response.status}）`);
      error.code = body.code;
      error.status = response.status;
      throw error;
    }
    if (conditional && snapshotGeneration === cacheGeneration) saveSnapshot(path, response.headers?.get?.("etag"), body);
    if (method === "GET") onSnapshot(path, body);
    return body;
  };
}

export function syncPollDelay({ active = false, pending = false, unavailable = false, idlePolls = 0 } = {}) {
  if (active || pending || unavailable) return 3000;
  return idlePolls < 2 ? 10000 : idlePolls < 4 ? 20000 : 30000;
}
