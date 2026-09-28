import test from "node:test";
import assert from "node:assert/strict";
import { reconcileOptimisticMessages, mergeTranscriptTurns } from "../public/conversation-state.js";

test("optimistic messages clear only when a new matching desktop user item appears", () => {
  const pending = [
    { requestId: "one", prompt: "same text", baselineKeys: ["old\u001fprevious"] },
    { requestId: "two", prompt: "same text", baselineKeys: ["old\u001fprevious"] }
  ];
  const turns = [
    { id: "old", items: [{ id: "previous", type: "userMessage", text: "same text" }] },
    { id: "new", items: [{ id: "new-user", type: "userMessage", text: "same text" }] }
  ];

  assert.deepEqual(reconcileOptimisticMessages(pending, turns), [pending[1]]);
});

test("unrelated or pre-existing messages do not erase a pending optimistic send", () => {
  const pending = [{ requestId: "one", prompt: "follow up", baselineKeys: ["turn-1\u001fuser-1"] }];
  const turns = [
    { id: "turn-1", items: [{ id: "user-1", type: "userMessage", text: "follow up" }] },
    { id: "turn-2", items: [{ id: "assistant", type: "agentMessage", text: "follow up" }] }
  ];

  assert.deepEqual(reconcileOptimisticMessages(pending, turns), pending);
});

test("stable user item migration removes its cached old position and stale history cannot move it back", () => {
  const user = { id: "desktop-item", type: "userMessage", text: "same supplement" };
  const before = [{ id: "old-turn", items: [user, { id: "work", type: "activity" }] }];
  const current = { id: "active-turn", items: [user] };
  const moved = mergeTranscriptTurns(before, [current]);
  assert.equal(moved.flatMap(turn => turn.items).filter(item => item.id === user.id).length, 1);
  assert.equal(moved.find(turn => turn.id === "old-turn").items[0].id, "work");
  const historical = mergeTranscriptTurns(moved, before, { latest: false });
  assert.equal(historical.find(turn => turn.id === "active-turn").items[0].id, user.id);
  assert.equal(historical.flatMap(turn => turn.items).filter(item => item.id === user.id).length, 1);
});

test("identical text with distinct stable IDs remains visible and moved baseline IDs do not consume a new optimistic send", () => {
  const pending = [{ requestId: "next-send", prompt: "same supplement", baselineKeys: ["old-turn\u001fdesktop-item"] }];
  const migrated = [{ id: "active-turn", items: [{ id: "desktop-item", type: "userMessage", text: "same supplement" }] }];
  assert.deepEqual(reconcileOptimisticMessages(pending, migrated), pending);
  const repeated = mergeTranscriptTurns(migrated, [{ id: "active-turn", items: [...migrated[0].items, { id: "new-desktop-item", type: "userMessage", text: "same supplement" }] }]);
  assert.equal(repeated[0].items.length, 2); assert.deepEqual(reconcileOptimisticMessages(pending, repeated), []);
});
