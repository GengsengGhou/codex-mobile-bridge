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

test("two Huawei photo attachments reconcile across native link escaping and Windows line endings", () => {
  const names = ["IMG_20260928_173422.jpg", "IMG_20260928_173429.jpg"];
  const paths = names.map(name => `C:\\Users\\Huawei User\\AppData\\Local\\Codex\\mobile-uploads\\upload-id\\${name}`);
  const prompt = `请帮我对比这两张照片。\n\n附件：\n${names.map((name, index) => `[${name}](<${paths[index]}>)`).join("\n")}`;
  const nativeText = [
    "请帮我对比这两张照片。",
    "",
    "附件：",
    ...names.map((name, index) => `[${name}](&lt;${paths[index].replaceAll("\\", "/")}&gt;)`),
  ].join("\r\n");
  const turn = { id: "native-turn", items: [{ id: "native-images", type: "userMessage", text: nativeText, source: "desktop-bridge" }] };

  for (const state of ["sending", "unknown", "accepted"]) {
    const pending = { requestId: `request-${state}`, prompt, attachmentIds: ["upload-one", "upload-two"], baselineKeys: [], state };
    assert.deepEqual(reconcileOptimisticMessages([pending], [turn]), [], `${state} attachment send should be represented by its native item`);
  }
  const duplicateSends = ["accepted", "unknown"].map((state, index) => ({
    requestId: `duplicate-${index}`, prompt, attachmentIds: ["upload-one", "upload-two"], baselineKeys: [], state,
  }));
  assert.deepEqual(reconcileOptimisticMessages(duplicateSends, [turn]), [duplicateSends[1]]);
});

test("attachment reconciliation is one-to-one across refresh and pagination and respects reassigned baseline IDs", () => {
  const prompt = "查看这两张照片。\n\n附件：\n[IMG_20260928_173422.jpg](<C:\\photos\\one\\IMG_20260928_173422.jpg>)\n[IMG_20260928_173429.jpg](<C:\\photos\\two\\IMG_20260928_173429.jpg>)";
  const pending = { requestId: "unknown-send", prompt, attachmentIds: ["upload-one", "upload-two"], baselineKeys: [], state: "unknown" };
  const nativeItem = { id: "stable-photo-message", type: "userMessage", text: prompt };
  const latest = mergeTranscriptTurns([], [{ id: "current", items: [nativeItem] }]);
  assert.deepEqual(reconcileOptimisticMessages([pending], latest), []);
  const paged = mergeTranscriptTurns(latest, [{ id: "older", items: [nativeItem] }], { latest: false });
  assert.equal(paged.flatMap(turn => turn.items).filter(item => item.id === nativeItem.id).length, 1);
  assert.deepEqual(reconcileOptimisticMessages([pending], paged), []);

  const reassigned = mergeTranscriptTurns(latest, [{ id: "active", items: [nativeItem] }]);
  const baselinePending = { ...pending, requestId: "new-send", baselineKeys: ["previous-turn\u001fstable-photo-message"] };
  assert.equal(reassigned.flatMap(turn => turn.items).filter(item => item.id === nativeItem.id).length, 1);
  assert.deepEqual(reconcileOptimisticMessages([baselinePending], reassigned), [baselinePending]);
});

test("attachment links do not make legitimate repeated user messages interchangeable", () => {
  const firstPrompt = "再看一下。\n\n附件：\n[IMG_20260928_173422.jpg](<C:\\uploads\\first\\IMG_20260928_173422.jpg>)\n[IMG_20260928_173429.jpg](<C:\\uploads\\first\\IMG_20260928_173429.jpg>)";
  const nextPrompt = firstPrompt.replaceAll("\\first\\", "\\second\\");
  const first = { id: "first", items: [{ id: "user-first", type: "userMessage", text: firstPrompt }] };
  const pending = { requestId: "next", prompt: nextPrompt, attachmentIds: ["new-one", "new-two"], baselineKeys: ["first\u001fuser-first"], state: "sending" };
  assert.deepEqual(reconcileOptimisticMessages([pending], [first]), [pending]);
  const repeated = mergeTranscriptTurns([first], [{ id: "second", items: [{ id: "user-second", type: "userMessage", text: firstPrompt }] }]);
  assert.equal(repeated.flatMap(turn => turn.items).filter(item => item.type === "userMessage").length, 2);
  assert.deepEqual(reconcileOptimisticMessages([pending], repeated), [pending]);
});
