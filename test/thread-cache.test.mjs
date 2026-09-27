import test from "node:test";
import assert from "node:assert/strict";
import { createThreadSnapshotCache } from "../public/thread-cache.js";

const snapshot = (id, count, extra = {}) => ({
  thread: { id, title: `Thread ${id}` },
  turns: Array.from({ length: count }, (_, index) => ({ id: `${id}-${index}`, text: `turn ${index}` })),
  cursor: `${id}-cursor`,
  hasMore: true,
  scrollTop: 24,
  readAt: `${id}-read`,
  ...extra
});

test("snapshot cache refreshes LRU order and enforces entry and turn bounds", () => {
  const cache = createThreadSnapshotCache({ maxEntries: 2, maxTurns: 5 });
  assert.equal(cache.save("a", snapshot("a", 2)), true);
  assert.equal(cache.save("b", snapshot("b", 2)), true);
  assert.equal(cache.restore("a").thread.id, "a");

  assert.equal(cache.save("c", snapshot("c", 2)), true);
  assert.equal(cache.restore("b"), undefined);
  assert.equal(cache.size, 2);
  assert.equal(cache.turnCount, 4);

  assert.equal(cache.save("d", snapshot("d", 4)), true);
  assert.equal(cache.restore("a"), undefined);
  assert.equal(cache.restore("c"), undefined);
  assert.equal(cache.restore("d").thread.id, "d");
  assert.equal(cache.turnCount, 4);
});

test("oversized snapshots are skipped and replacing a thread removes its previous snapshot", () => {
  const cache = createThreadSnapshotCache({ maxEntries: 3, maxTurns: 3 });
  cache.save("a", snapshot("a", 2));
  cache.save("b", snapshot("b", 1));

  assert.equal(cache.save("a", snapshot("a", 4)), false);
  assert.equal(cache.restore("a"), undefined);
  assert.equal(cache.restore("b").thread.id, "b");
  assert.equal(cache.turnCount, 1);
});

test("snapshots are isolated on save and restore, including between thread IDs", () => {
  const cache = createThreadSnapshotCache();
  const input = snapshot("a", 1);
  cache.save("a", input);
  cache.save("b", snapshot("b", 1));

  input.thread.title = "changed after save";
  input.turns[0].text = "changed after save";
  const restoredA = cache.restore("a");
  restoredA.thread.title = "changed after restore";
  restoredA.turns[0].text = "changed after restore";

  assert.deepEqual(cache.restore("a"), snapshot("a", 1));
  assert.deepEqual(cache.restore("b"), snapshot("b", 1));
});

test("delete and clear maintain the tracked turn count", () => {
  const cache = createThreadSnapshotCache();
  cache.save("a", snapshot("a", 2));
  cache.save("b", snapshot("b", 3));
  assert.equal(cache.delete("a"), true);
  assert.equal(cache.delete("a"), false);
  assert.equal(cache.turnCount, 3);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.turnCount, 0);
});
