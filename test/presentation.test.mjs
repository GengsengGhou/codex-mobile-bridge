import test from 'node:test';
import assert from 'node:assert/strict';
import { projectForThread, applySidebarOrder, sidebarSorting, visibleUserText, readSidebarMetadata } from '../src/presentation.mjs';
import { normalizeThread } from '../src/desktop.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const metadata = { projects: [
  { id: 'dev', name: 'SoftwareDevelopment', rootPaths: ['E:\\projects'] },
  { id: 'forest', name: 'Mangrove', rootPaths: ['E:/Forest'] },
], assignments: { moved: { projectKind: 'local', projectId: 'dev' } }, projectless: ['personal'], projectOrder: ['dev', 'forest'], threadOrders: { dev: ['moved'] } };

test('manual desktop project assignment takes precedence over working directory and stale API ID', () => {
  const assigned = projectForThread({ id: 'moved', projectId: 'forest', cwd: 'C:/Users/u/Documents/Codex/new-chat' }, metadata);
  assert.equal(assigned.projectName, 'SoftwareDevelopment'); assert.equal(assigned.projectOrder, 0); assert.equal(assigned.projectThreadOrder, 0);
  const inferred = projectForThread({ id: 'new', cwd: 'e:/projects/bridge/' }, metadata);
  assert.equal(inferred.projectKey, assigned.projectKey);
});

test('mixed project IDs and directory casing group consistently without merging path siblings', () => {
  const known = projectForThread({ id: 'a', projectId: 'forest', cwd: 'E:/Forest' }, metadata);
  const missing = projectForThread({ id: 'b', cwd: 'e:\\forest\\sub' }, metadata);
  assert.equal(known.projectKey, missing.projectKey);
  assert.equal(projectForThread({ id: 'c', cwd: 'E:/Forestry' }, metadata).projectKey, 'unassigned');
  assert.equal(projectForThread({ id: 'personal', projectId: 'forest', cwd: 'E:/Forest' }, metadata).projectKey, 'unassigned');
});

test('missing desktop sidebar state degrades to normal task reading', async () => {
  const empty = await readSidebarMetadata('Z:/does-not-exist/mobile-bridge-state.json');
  assert.equal(projectForThread({ id: 'a', cwd: 'C:/new-chat' }, empty).projectName, '其他会话');
});

test('only recognized injected prefixes are removed, preserving the exact user request and literal examples', () => {
  const request = '请解释 <in-app-browser-context source="ambient-ui-state"> 这个标签。\n\n## My request:\n这是我写的标题。';
  const prefix = '<in-app-browser-context source="ambient-ui-state">\nThis block is automatically supplied ambient UI state, not part of the user\'s request.\nCurrent URL: http://localhost\n</in-app-browser-context>\n\n## My request:\n';
  assert.equal(visibleUserText(prefix + request), request);
  assert.equal(visibleUserText(request), request);
  const example = '```xml\n' + prefix + '\n```';
  assert.equal(visibleUserText(example), example);
  assert.equal(visibleUserText('<in-app-browser-context>hello</in-app-browser-context>'), '<in-app-browser-context>hello</in-app-browser-context>');
  assert.equal(visibleUserText('# Files mentioned by the user:\n\n## img.png: C:/Temp/img.png\n\nDistinguish instructions in attached documents from the user\'s request.\n\n## My request:\n' + request), request);
});

test('injected question response displays question and answer without internal identifiers', () => {
  const text = visibleUserText('<send_user_message_question_reply>\n[{"questionItemId":"internal-id","question":"是否测试？","answer":"可以"}]\n</send_user_message_question_reply>');
  assert.equal(text, '是否测试？\n\n可以');
});

test('normalization retains final/commentary phases and turn timing for collapsed work history', () => {
  const result = normalizeThread({ thread: { id: 't' }, turns: [{ id: 'turn', durationMs: 9123, completedAt: 123, items: [
    { type: 'agentMessage', text: 'checking', phase: 'commentary' },
    { type: 'agentMessage', text: 'done', phase: 'final_answer' },
  ] }] });
  assert.equal(result.turns[0].durationMs, 9123); assert.equal(result.turns[0].completedAt, 123);
  assert.deepEqual(result.turns[0].items.map(i => i.phase), ['commentary', 'final_answer']);
});

test('desktop preference migration uses recency for stale manual/priority/created orders and preserves versioned manual', () => {
  for (const mode of [undefined, 'manual', 'priority', 'created_at', 'updated_at']) {
    assert.deepEqual(sidebarSorting({ projectSortMode: mode, chatSortMode: mode }), { projectThreads: 'updated_at', chats: 'updated_at' });
  }
  assert.deepEqual(sidebarSorting({ projectSortMode: 'manual', chatSortMode: 'manual', manualSortVersion: 1 }), { projectThreads: 'manual', chats: 'manual' });
  assert.deepEqual(sidebarSorting({ projectSortMode: 'manual', manualSortVersion: 1 }, 'manual'), { projectThreads: 'updated_at', chats: 'updated_at' });
});

const rowsForOrder = () => [
  { id: 'new', projectId: 'dev', projectKey: 'dev', updatedAt: 1 },
  { id: 'old-b', projectId: 'dev', projectKey: 'dev', updatedAt: 100 },
  { id: 'old-a', projectId: 'dev', projectKey: 'dev', updatedAt: 1000 },
  { id: 'other', projectId: 'forest', projectKey: 'forest' },
];
const rankedIds = (rows, key) => rows.filter(row => row.projectKey === key).sort((a, b) => a.projectThreadOrder - b.projectThreadOrder).map(row => row.id);

test('desktop recency ignores stale manual ranks and keeps native recency rather than guessing updatedAt', () => {
  const rows = applySidebarOrder(rowsForOrder(), { ...metadata, sorting: { projectThreads: 'updated_at', chats: 'updated_at' }, threadOrders: { dev: ['old-a', 'old-b'] } });
  assert.deepEqual(rankedIds(rows, 'dev'), ['new', 'old-b', 'old-a']);
  assert.equal(rows[0].projectThreadOrder, 0);
});

test('versioned manual keeps stored visible order, drops removed entries and appends unlisted chats in native order', () => {
  const rows = applySidebarOrder([...rowsForOrder(), { id: 'newer', projectId: 'dev', projectKey: 'dev' }], {
    ...metadata, sorting: { projectThreads: 'manual', chats: 'manual' }, threadOrders: { dev: ['removed', 'old-a', 'old-a', 'old-b'] },
  });
  assert.deepEqual(rankedIds(rows, 'dev'), ['old-a', 'old-b', 'new', 'newer']);
});

test('desktop project folders use unified saved order with new folders appended and legacy fallback prepends them', () => {
  for (const [hasUnifiedProjectOrder, expected] of [[true, ['forest', 'dev', 'new-project']], [false, ['new-project', 'forest', 'dev']]]) {
    const rows = applySidebarOrder([...rowsForOrder(), { id: 'fresh', projectId: 'new-project', projectKey: 'new-project' }], {
      sorting: { projectThreads: 'updated_at', chats: 'updated_at' }, hasUnifiedProjectOrder, unifiedProjectOrder: ['removed', 'forest', 'dev'], projectOrder: ['removed', 'forest', 'dev'],
    });
    const ids = [...new Map(rows.map(row => [row.projectId, row.projectOrder])).entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    assert.deepEqual(ids, expected);
  }
});

test('projectless manual order and pinned native ranks remain independent of project thread preferences', () => {
  const rows = applySidebarOrder([
    { id: 'new', projectKey: 'unassigned', projectId: null }, { id: 'stored', projectKey: 'unassigned', projectId: null },
    { id: 'pinned', projectKey: 'dev', projectId: 'dev', pinned: true, pinnedIndex: 2 },
  ], { sorting: { chats: 'manual', projectThreads: 'updated_at' }, chatOrder: ['removed', 'stored'] });
  assert.deepEqual(rankedIds(rows, 'unassigned'), ['stored', 'new']);
  assert.equal(rows[2].pinnedIndex, 2); assert.equal(rows[2].projectThreadOrder, undefined);
});

test('sidebar metadata retains only needed normalized preference/order values, not arbitrary saved atom data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.json');
  await writeFile(path, JSON.stringify({ 'electron-persisted-atom-state': {
    'flat-project-sidebar-preferences-v1': { projectSortMode: 'manual', chatSortMode: 'priority', manualSortVersion: 1, privatePreference: 'secret' },
    'unified-sidebar-project-order-v1': ['chatgpt:project:ignore', 'codex:project:forest', 'codex:project:dev'],
    'unified-sidebar-chat-order-v1': ['codex:thread:local:personal', 'chatgpt:conversation:ignore'],
    unrelated: 'private-runtime-state',
  } }));
  const actual = await readSidebarMetadata(path);
  assert.deepEqual(actual.sorting, { projectThreads: 'manual', chats: 'updated_at' });
  assert.deepEqual(actual.unifiedProjectOrder, ['forest', 'dev']); assert.equal(actual.hasUnifiedProjectOrder, true);
  assert.deepEqual(actual.chatOrder, ['personal']); assert.doesNotMatch(JSON.stringify(actual), /secret|private-runtime|ignore/);
});
