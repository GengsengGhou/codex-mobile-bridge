import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const fixtureThread = '00000000-0000-0000-0000-000000000001';
const root = new URL('../../public/', import.meta.url);
/** Isolated read-only UI fixture; never connects to Codex, a hub, or a real device. */
export async function startWebAcceptanceFixture() {
  const row = { id: fixtureThread, title: '中文用户标题 · User task', cwd: 'E:/中文项目', projectKey: 'fixture', projectName: '我的项目', status: 'idle' };
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (request.method !== 'GET') { response.writeHead(405); response.end('Read-only fixture'); return; }
    const modelOptions = { send: [{ id: 'gpt-6-luna', efforts: ['low', 'high'] }], create: [{ id: 'gpt-6-luna', efforts: ['low', 'high'] }] };
    const endpoints = {
      '/api/status': { connected: true, canSend: true, canCreate: true, sendScope: 'all-local', callerThreadId: fixtureThread, defaultThreadId: fixtureThread, modelOptions, permissionOptions: { send: [{ id: 'full-access' }, { id: 'request-approval' }] } },
      '/api/threads': { threads: [row] }, '/api/sidebar-order': { revision: 0, order: { projects: [], threads: {} } },
      '/api/access': { remote: false, authenticated: true, mode: 'local' },
      '/api/archives': { threads: [], nextCursor: null },
      '/api/projects': { projects: [{ projectId: 'fixture', label: '我的项目', path: 'E:/中文项目' }], canCreate: true },
      '/api/recovery': { supported: true, autoStart: false, autoRestart: true, supervisorRunning: true, state: 'running', restartCount: 0 },
      [`/api/threads/${fixtureThread}/files`]: { path: '', parentPath: null, entries: [{ name: '我的文件.txt', type: 'file', size: 42 }, { name: '已完成', type: 'directory' }], truncated: false },
      [`/api/threads/${fixtureThread}/context`]: { threadId: fixtureThread, available: true, permissions: { current: 'request-approval', canOverride: true }, git: { available: true, branch: 'main', commit: 'a'.repeat(40), dirty: false }, agents: { available: true, items: [] }, sources: { available: true, items: [] } },
      [`/api/threads/${fixtureThread}`]: { thread: row, canSend: true, sendMode: 'message', page: { hasMore: false, nextCursor: null }, turns: [{ id: 'fixture-turn', status: 'completed', durationMs: 1200, items: [{ id: 'comment', type: 'agentMessage', phase: 'commentary', text: '用户与智能体原文：已完成 / Completed' }, { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Language changes preserve this conversation.\n\n中文原文保持不变。\n\n```js\nconst message = "你好";\n```' }] }] },
    };
    if (url.pathname in endpoints) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(endpoints[url.pathname])); return; }
    if (url.pathname.startsWith('/api/')) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
    let name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (name.includes('..')) { response.writeHead(400); response.end(); return; }
    try {
      const data = await readFile(new URL(name, root));
      response.writeHead(200, { 'Content-Type': name.endsWith('.js') || name.endsWith('.mjs') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.woff2') ? 'font/woff2' : 'text/html' }); response.end(data);
    } catch { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/?thread=${fixtureThread}`, close: () => new Promise(resolve => server.close(resolve)), root: fileURLToPath(root) };
}
