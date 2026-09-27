import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnBlocks, formatWorkSummary, mergeReadThread, projectGroup } from '../public/presentation.js';

test('keeps user messages and final answers in order around folded work segments', () => {
  const blocks = buildTurnBlocks({ items: [
    { type: 'userMessage', id: 'u1', text: 'first' },
    { type: 'activity', id: 'a1', text: 'Reading files' },
    { type: 'agentMessage', id: 'c1', phase: 'commentary', text: 'I found the issue' },
    { type: 'agentMessage', id: 'f1', phase: 'final_answer', text: 'Fixed' },
    { type: 'userMessage', id: 'u2', text: 'follow up' },
    { type: 'activity', id: 'a2', text: 'Updating tests' },
    { type: 'agentMessage', id: 'f2', text: 'Done' },
    { type: 'agentMessage', id: 'hidden', phase: 'analysis', text: 'private reasoning' },
  ] });

  assert.deepEqual(blocks.map(block => block.type), ['user', 'work', 'final', 'user', 'work', 'final']);
  assert.deepEqual(blocks[1].items.map(item => item.id), ['a1', 'c1']);
  assert.equal(blocks[2].item.id, 'f1');
  assert.equal(blocks[3].item.id, 'u2');
  assert.equal(blocks[5].item.id, 'f2');
  assert.ok(!JSON.stringify(blocks).includes('private reasoning'));
});

test('summarizes active and completed work durations', () => {
  assert.equal(formatWorkSummary({ status: 'inProgress' }), '工作过程 · 进行中');
  assert.equal(formatWorkSummary({ status: 'completed', durationMs: 62000 }), '工作过程 · 用时 1 分 2 秒');
  assert.equal(formatWorkSummary({ status: 'completed', startedAt: 1730000000, completedAt: 1730000060 }), '工作过程 · 用时 1 分');
  assert.equal(formatWorkSummary({ status: 'completed' }), '工作过程 · 已完成');
  assert.equal(formatWorkSummary({ status: 'completed', durationMs: null }), '工作过程 · 已完成');
  assert.equal(formatWorkSummary({ status: 'interrupted' }), '工作过程 · 已中断');
});

test('groups matching project keys together and collects unscoped sessions', () => {
  assert.deepEqual(projectGroup({ projectKey: 'repo-a', projectName: 'Repository A' }), { key: 'repo-a', label: 'Repository A' });
  assert.deepEqual(projectGroup({ cwd: 'C:/work/repo-b' }), { key: 'unassigned', label: '其他会话' });
  assert.deepEqual(projectGroup({ id: 'one' }), { key: 'unassigned', label: '其他会话' });
  assert.equal(projectGroup({ projectKey: 'same', title: 'new chat' }).key, projectGroup({ projectKey: 'same', title: 'another chat' }).key);
});

test('fills project and pin metadata missing from a freshly read thread', () => {
  const result = mergeReadThread(
    { id: 'thread-1', title: 'Task', status: 'idle', cwd: undefined },
    [{ id: 'thread-1', projectKey: 'repo', projectName: 'Repo', projectId: 'p1', projectPath: '/repo', cwd: '/repo', pinned: true, pinnedIndex: 0 }],
  );
  assert.equal(result.projectKey, 'repo');
  assert.equal(result.projectName, 'Repo');
  assert.equal(result.projectPath, '/repo');
  assert.equal(result.pinned, true);
  assert.equal(result.pinnedIndex, 0);
});
