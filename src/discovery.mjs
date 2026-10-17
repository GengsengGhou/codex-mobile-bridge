import { readdir } from 'node:fs/promises';
import { BridgeError, pipeRequest } from './desktop.mjs';

export async function desktopPipeCandidates({ platform = process.platform, readDirectory = readdir } = {}) {
  if (platform !== 'win32') return [];
  const names = await readDirectory('\\\\.\\pipe\\');
  // Probe the current app transport first. Do not truncate a mixed list: old
  // browser pipes must neither hide the app pipe nor hide another desktop.
  const paths = names.filter(name => /^codex-(?:app-tools|browser-use)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name))
    .sort((a, b) => Number(/^codex-app-tools-/i.test(b)) - Number(/^codex-app-tools-/i.test(a)) || a.localeCompare(b))
    .map(name => `\\\\.\\pipe\\${name}`);
  if (paths.length > 128) throw new BridgeError('Codex 桌面连接入口过多，请关闭多余桌面后重试。');
  return paths;
}

// Discovery only reads tool catalogs. Writes never retry, even after reconnect.
export function createDesktopRequest({ preferredPipe, request = pipeRequest, candidates = desktopPipeCandidates } = {}) {
  let selected = preferredPipe, discovering = null, retryAfter = 0;
  async function discover() {
    if (discovering) return discovering;
    if (performance.now() < retryAfter) throw new BridgeError('正在等待 Codex 桌面重新连接。');
    discovering = (async () => {
      const paths = await candidates();
      const matches = [];
      for (let start = 0; start < paths.length; start += 8) {
        const results = await Promise.allSettled(paths.slice(start, start + 8).map(async path => {
          const catalog = await request(path, 'tools/list', { threadStartKind: 'all' }, { timeoutMs: 1000 });
          const tools = Array.isArray(catalog?.tools) ? catalog.tools.filter(tool => tool?.namespace === 'codex_app').map(tool => tool.name) : [];
          return ['list_threads', 'read_thread'].every(name => tools.includes(name)) ? path : null;
        }));
        for (const result of results) if (result.status === 'fulfilled' && result.value) matches.push(result.value);
      }
      if (matches.length !== 1) throw new BridgeError(matches.length > 1
        ? '发现多个 Codex 桌面连接，请从目标桌面任务重新启动桥接。'
        : '未找到可用的 Codex 桌面连接，请打开 Codex；网页会自动重试。');
      selected = matches[0];
      return selected;
    })();
    try { return await discovering; }
    catch (error) { retryAfter = performance.now() + 3000; throw error instanceof BridgeError ? error : new BridgeError('暂时无法发现 Codex 桌面连接。'); }
    finally { discovering = null; }
  }
  return async (_path, method, params, options = {}) => {
    const path = selected || await discover();
    try { return await request(path, method, params, options); }
    catch (error) {
      if (!['DESKTOP_UNAVAILABLE', 'PROTOCOL_ERROR', 'DESKTOP_REJECTED'].includes(error.code)) throw error;
      if (selected === path) selected = null;
      if (options.mutation) throw error;
      return request(selected || await discover(), method, params, options);
    }
  };
}
