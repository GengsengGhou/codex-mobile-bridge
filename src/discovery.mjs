import { readdir } from 'node:fs/promises';
import { BridgeError, pipeRequest } from './desktop.mjs';

export async function desktopPipeCandidates() {
  if (process.platform !== 'win32') return [];
  const names = await readdir('\\\\.\\pipe\\');
  return names.filter(name => /^codex-browser-use-[0-9a-f-]{36}$/i.test(name))
    .slice(0, 64).map(name => `\\\\.\\pipe\\${name}`);
}

// Discovery only reads tool catalogs. Writes never retry, even after reconnect.
export function createDesktopRequest({ preferredPipe, request = pipeRequest, candidates = desktopPipeCandidates } = {}) {
  let selected = preferredPipe, discovering = null, retryAfter = 0;
  async function discover() {
    if (discovering) return discovering;
    if (Date.now() < retryAfter) throw new BridgeError('正在等待 Codex 桌面重新连接。');
    discovering = (async () => {
      const paths = await candidates();
      const matches = [];
      for (let start = 0; start < paths.length; start += 8) {
        const results = await Promise.allSettled(paths.slice(start, start + 8).map(async path => {
          const catalog = await request(path, 'tools/list', { threadStartKind: 'all' }, { timeoutMs: 1000 });
          const tools = catalog?.tools?.filter(tool => tool.namespace === 'codex_app').map(tool => tool.name) ?? [];
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
    catch (error) { retryAfter = Date.now() + 3000; throw error instanceof BridgeError ? error : new BridgeError('暂时无法发现 Codex 桌面连接。'); }
    finally { discovering = null; }
  }
  return async (_path, method, params, options = {}) => {
    const path = selected || await discover();
    try { return await request(path, method, params, options); }
    catch (error) {
      if (error.code !== 'DESKTOP_UNAVAILABLE') throw error;
      if (selected === path) selected = null;
      if (options.mutation) throw error;
      return request(await discover(), method, params, options);
    }
  };
}
