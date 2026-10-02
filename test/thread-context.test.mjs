import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { summarizeThreadContext, safeSourceUrl, readGitContext, hydrateAgentContext } from '../src/thread-context.mjs';
const ID = '00000000-0000-7000-8000-000000000001', CHILD = '00000000-0000-7000-8000-000000000002';
test('agent hydration reads fresh metadata without transcript outputs and preserves unavailable/completed semantics', async () => {
  const agents = { items: [{ threadId: CHILD, status: 'completed', name: 'Saved' }, { threadId: ID, status: 'active', name: 'Unknown' }] };
  const actual = await hydrateAgentContext(agents, {
    read: async () => { throw Error('Transcript hydration must not run'); },
    readMetadata: async id => {
      if (id === ID) throw Error('Unavailable child');
      return { thread: { id, kind: 'codex', hostId: 'local', title: 'Current title', status: 'notLoaded' }, turns: [] };
    },
  });
  assert.equal(actual.items[0].name, 'Current title'); assert.equal(actual.items[0].status, 'completed'); assert.equal(actual.items[0].canRead, true);
  assert.equal(actual.items[1].status, 'unknown'); assert.equal(actual.items[1].canRead, false);
});
test('sources contain recognized attachment/web/tool metadata and omit raw arguments, output, queries and credentials', () => {
  const result = summarizeThreadContext({ id: ID, cwd: 'E:/repo', source: 'vscode' }, [{ params: { attachments: [{ path: 'E:/repo/report.pdf', label: 'Report' }] }, items: [
    { type: 'webSearch', query: 'private query', action: { type: 'openPage', url: 'https://example.com/page?token=private#private' } },
    { type: 'mcpToolCall', server: 'zotero', tool: 'search', arguments: { token: 'raw secret' }, result: { content: [{ type: 'text', text: 'raw private output' }] } },
    { type: 'mcpToolCall', server: 'notion', tool: 'notion_fetch', result: { content: [{ type: 'text', text: JSON.stringify({ metadata: { type: 'page' }, title: 'Doc', url: 'https://notion.so/doc' }) }] } },
    { type: 'webSearch', action: { type: 'openPage', url: 'https://user:secret@example.com/private' } },
  ] }]);
  const rendered = JSON.stringify(result.sources); assert.equal(rendered.includes('private'), false); assert.equal(rendered.includes('secret'), false);
  assert.equal(result.sources.items.some(item => item.label === 'Report'), true);
  assert.equal(result.sources.items.some(item => item.url === 'https://example.com/page'), true);
  assert.equal(result.sources.items.some(item => item.label === 'Doc'), true);
  assert.equal(result.sources.items.some(item => item.type === 'tool'), true); assert.equal(result.sources.partial, true);
  for (const url of ['javascript:alert(1)', 'file:///C:/private', 'https://u:p@example.com']) assert.equal(safeSourceUrl(url), null);
});
test('agent activity only discloses stable identity/path and current readable state', async () => {
  const context = summarizeThreadContext({ id: ID, cwd: 'E:/repo' }, [{ items: [
    { type: 'subAgentActivity', kind: 'started', agentThreadId: CHILD, agentPath: '/root/worker' },
    { type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: ID, receiverThreadIds: [CHILD], prompt: 'private task', agentsStates: { [CHILD]: { status: 'running', message: 'private response' } } },
  ] }]);
  assert.equal(JSON.stringify(context.agents).includes('private'), false);
  const hydrated = await hydrateAgentContext(context.agents, { read: async id => ({ thread: { id, kind: 'codex', hostId: 'local', title: 'Worker', status: 'idle' } }) });
  assert.equal(hydrated.items[0].threadId, CHILD); assert.equal(hydrated.items[0].path, '/root/worker'); assert.equal(hydrated.items[0].parentThreadId, ID);
  assert.equal(hydrated.items[0].canRead, true); assert.equal(hydrated.items[0].status, 'idle');
});

test('agent messaging updates activity without inventing or replacing spawn parents', () => {
  const other = '00000000-0000-7000-8000-000000000003';
  const context = summarizeThreadContext({ id: ID, cwd: 'E:/repo' }, [{ items: [
    { type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: ID, receiverThreadIds: [CHILD] },
    { type: 'collabAgentToolCall', tool: 'sendMessage', senderThreadId: other, receiverThreadIds: [CHILD] },
    { type: 'collabAgentToolCall', tool: 'sendInput', senderThreadId: ID, receiverThreadIds: [other] },
  ] }]);
  assert.equal(context.agents.items.find(item => item.threadId === CHILD).parentThreadId, ID);
  assert.equal(context.agents.items.find(item => item.threadId === other).parentThreadId, null);
});
test('recorded completion survives dormant native loading state without guessing that idle agents are completed', async () => {
  const completed = summarizeThreadContext({ id: ID }, [{ items: [{ type: 'subAgentActivity', kind: 'completed', agentThreadId: CHILD }] }]).agents;
  for (const status of ['idle', 'notLoaded', 'unknown']) {
    const hydrated = await hydrateAgentContext(completed, { read: async id => ({ thread: { id, kind: 'codex', hostId: 'local', status } }) });
    assert.equal(hydrated.items[0].status, 'completed'); assert.equal(hydrated.items[0].canRead, true);
  }
  const active = await hydrateAgentContext(completed, { read: async id => ({ thread: { id, kind: 'codex', status: 'active' } }) });
  assert.equal(active.items[0].status, 'active');
  const unavailable = await hydrateAgentContext(completed, { read: async () => { throw new Error('not loaded'); } });
  assert.equal(unavailable.items[0].status, 'completed'); assert.equal(unavailable.items[0].canRead, false);
  const running = { ...completed, items: completed.items.map(item => ({ ...item, status: 'running' })) };
  const idle = await hydrateAgentContext(running, { read: async id => ({ thread: { id, kind: 'codex', status: 'idle' } }) });
  assert.equal(idle.items[0].status, 'idle');
});
test('Git context reads current branch and untracked dirtiness without returning filenames or remote authentication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-git-context-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await promisify(execFile)('git', ['init', '--initial-branch=context-test', dir], { windowsHide: true });
  const clean = await readGitContext(dir); assert.equal(clean.available, true); assert.equal(clean.branch, 'context-test'); assert.equal(clean.dirty, false); assert.equal(clean.commit, null);
  await writeFile(join(dir, 'secret-filename.txt'), 'private content');
  const dirty = await readGitContext(dir); assert.equal(dirty.dirty, true); assert.equal(JSON.stringify(dirty).includes('secret-filename'), false);
  assert.equal((await readGitContext(join(dir, 'missing'))).available, false);
});
