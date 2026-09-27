import { DesktopBridge } from '../src/desktop.mjs';
import { loadRuntimeConfig } from '../src/runtime.mjs';
import { createDesktopRequest } from '../src/discovery.mjs';
try {
  const { callerThreadId } = await loadRuntimeConfig();
  const bridge = new DesktopBridge({ callerThreadId, request: createDesktopRequest({ preferredPipe: process.env.CODEX_APP_TOOLS_PIPE_PATH }) });
  const capabilities = await bridge.capabilities();
  const data = await bridge.read(bridge.callerThreadId);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), transport: 'desktop-app-tools-pipe', sameThread: data.thread.id === bridge.callerThreadId, status: data.thread.status, turnCount: data.turns.length, textItems: data.turns.flatMap(t => t.items).filter(i => i.type !== 'activity').length, operations: ['list_threads', 'read_thread', 'send_message_to_thread'].filter(n => capabilities.includes(n)), verified: ['live desktop connection', 'existing task identity', 'current task snapshot'], notVerified: ['message delivery', 'active steering', 'interrupt', 'approval', 'desktop restart'] }, null, 2));
} catch (error) { console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1; }
