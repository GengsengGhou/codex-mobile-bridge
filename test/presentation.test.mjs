import test from 'node:test';
import assert from 'node:assert/strict';
import { projectForThread, visibleUserText, readSidebarMetadata } from '../src/presentation.mjs';
import { normalizeThread } from '../src/desktop.mjs';

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
