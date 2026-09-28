import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { summarizeThreadContext, safeSourceUrl, readGitContext, hydrateAgentContext } from '../src/thread-context.mjs';
const ID = '00000000-0000-7000-8000-000000000001', CHILD = '00000000-0000-7000-8000-000000000002';
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
test('Git context reads current branch and untracked dirtiness without returning filenames or remote authentication', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-git-context-')); t.after(() => rm(dir, { recursive: true, force: true }));
  await promisify(execFile)('git', ['init', '--initial-branch=context-test', dir], { windowsHide: true });
  const clean = await readGitContext(dir); assert.equal(clean.available, true); assert.equal(clean.branch, 'context-test'); assert.equal(clean.dirty, false); assert.equal(clean.commit, null);
  await writeFile(join(dir, 'secret-filename.txt'), 'private content');
  const dirty = await readGitContext(dir); assert.equal(dirty.dirty, true); assert.equal(JSON.stringify(dirty).includes('secret-filename'), false);
  assert.equal((await readGitContext(join(dir, 'missing'))).available, false);
});
