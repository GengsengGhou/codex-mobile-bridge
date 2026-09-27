import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveOrderItem,
  moveThreadWithinGroup,
  mergeSidebarOrder,
  orderProjectKeys,
  orderThreadRows,
  reconcileSidebarOrder,
  threadGroupKey,
} from '../public/sidebar-order.js';

test('reconciliation drops removed IDs and appends new IDs in current desktop order', () => {
  const saved = {
    revision: 4,
    order: {
      projects: ['repo-b', 'removed', 'repo-b'],
      threads: { 'repo-a': ['old', 'thread-2'], 'repo-b': ['thread-4'] },
    },
  };
  const threads = [
    { id: 'thread-1', projectKey: 'repo-a', projectOrder: 0 },
    { id: 'thread-2', projectKey: 'repo-a', projectOrder: 0 },
    { id: 'thread-3', projectKey: 'repo-b', projectOrder: 1 },
    { id: 'thread-4', projectKey: 'repo-b', projectOrder: 1 },
  ];

  assert.deepEqual(reconcileSidebarOrder(saved, threads), {
    revision: 4,
    order: {
      projects: ['repo-b', 'repo-a'],
      threads: { 'repo-a': ['thread-2', 'thread-1'], 'repo-b': ['thread-4', 'thread-3'] },
    },
  });
  assert.deepEqual(saved.order.threads['repo-a'], ['old', 'thread-2']);
});

test('pinned rows share the pinned group and missing project keys use unassigned', () => {
  const threads = [
    { id: 'pinned', pinned: true, projectKey: 'repo-a' },
    { id: 'unscoped', projectKey: '  ' },
    { id: 'scoped', projectKey: ' repo-a ' },
  ];
  assert.deepEqual(threads.map(threadGroupKey), ['@pinned', 'unassigned', 'repo-a']);
  assert.deepEqual(reconcileSidebarOrder({ revision: 0, order: { projects: ['@pinned'], threads: {} } }, threads), {
    revision: 0,
    order: {
      projects: ['repo-a'],
      threads: { '@pinned': ['pinned'], unassigned: ['unscoped'], 'repo-a': ['scoped'] },
    },
  });
});

test('project keys follow saved order and otherwise retain desktop project order', () => {
  assert.deepEqual(orderProjectKeys(['repo-a', 'repo-b', 'repo-c'], { projects: ['repo-c', 'missing', 'repo-a'] }), ['repo-c', 'repo-a', 'repo-b']);
  const reconciled = reconcileSidebarOrder({ order: { projects: [], threads: {} } }, [
    { id: 'b', projectKey: 'repo-b', projectOrder: 2 },
    { id: 'a', projectKey: 'repo-a', projectOrder: 1 },
    { id: 'a2', projectKey: 'repo-a', projectOrder: 1 },
    { id: 'p', pinned: true, projectKey: 'repo-c', projectOrder: 0 },
  ]);
  assert.deepEqual(reconciled.order.projects, ['repo-a', 'repo-b']);
});

test('thread row reordering stays within one group', () => {
  const order = { projects: ['repo-a', 'repo-b'], threads: { 'repo-a': ['a', 'b', 'c'], 'repo-b': ['x', 'y'] } };
  const moved = moveThreadWithinGroup(order, 'repo-a', 'a', 2);
  assert.deepEqual(moved.threads['repo-a'], ['b', 'c', 'a']);
  assert.deepEqual(moved.threads['repo-b'], ['x', 'y']);
  assert.deepEqual(order.threads['repo-a'], ['a', 'b', 'c']);
  assert.deepEqual(orderThreadRows([{ id: 'a' }, { id: 'c' }, { id: 'b' }], 'repo-a', moved), [{ id: 'b' }, { id: 'c' }, { id: 'a' }]);
  assert.deepEqual(moveOrderItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
});

test('merging a partial thread page and moving a visible row preserves unseen IDs and groups', () => {
  const saved = {
    revision: 9,
    order: {
      projects: ['repo-hidden', 'repo-a'],
      threads: { 'repo-a': ['visible-a', 'hidden-a'], 'repo-hidden': ['hidden-thread'] },
    },
  };
  const merged = mergeSidebarOrder(saved, [
    { id: 'visible-a', projectKey: 'repo-a', projectOrder: 0 },
    { id: 'visible-b', projectKey: 'repo-a', projectOrder: 0 },
    { id: 'visible-c', projectKey: 'repo-b', projectOrder: 1 },
  ]);
  const moved = moveThreadWithinGroup(merged, 'repo-a', 'visible-a', 2);

  assert.deepEqual(merged, {
    revision: 9,
    order: {
      projects: ['repo-hidden', 'repo-a', 'repo-b'],
      threads: {
        'repo-a': ['visible-a', 'hidden-a', 'visible-b'],
        'repo-hidden': ['hidden-thread'],
        'repo-b': ['visible-c'],
      },
    },
  });
  assert.deepEqual(moved.order.threads['repo-a'], ['hidden-a', 'visible-b', 'visible-a']);
  assert.deepEqual(moved.order.threads['repo-hidden'], ['hidden-thread']);
  assert.deepEqual(moved.order.threads['repo-b'], ['visible-c']);
  assert.deepEqual(saved.order.threads['repo-a'], ['visible-a', 'hidden-a']);
});
