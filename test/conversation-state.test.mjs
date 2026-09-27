import test from "node:test";
import assert from "node:assert/strict";
import { reconcileOptimisticMessages } from "../public/conversation-state.js";

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
