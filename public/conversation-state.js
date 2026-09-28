function messageKey(turn, item) {
  return `${String(turn?.id ?? "")}\u001f${String(item?.id ?? "")}`;
}

export function reconcileOptimisticMessages(pending, turns) {
  const matched = new Set();
  for (const turn of Array.isArray(turns) ? turns : []) {
    for (const item of Array.isArray(turn?.items) ? turn.items : []) {
      if (item?.type === "userMessage") matched.add(messageKey(turn, item));
    }
  }

  const available = new Set(matched);
  return (Array.isArray(pending) ? pending : []).filter(message => {
    for (const turn of Array.isArray(turns) ? turns : []) {
      for (const item of Array.isArray(turn?.items) ? turn.items : []) {
        const key = messageKey(turn, item);
        const stableId = item?.id == null ? "" : String(item.id);
        const preexisting = message.baselineKeys?.some(value => value === key || stableId && value.endsWith(`\u001f${stableId}`));
        if (item?.type === "userMessage" && item.text === message.prompt
          && !preexisting && available.has(key)) {
          available.delete(key);
          return false;
        }
      }
    }
    return true;
  });
}

export function mergeTranscriptTurns(previous, incoming, { latest = true } = {}) {
  const turns = new Map((Array.isArray(previous) ? previous : []).map(turn => [String(turn.id), turn]));
  const owners = new Map();
  for (const turn of turns.values()) for (const item of turn.items || []) {
    if (item.type === "userMessage" && item.id != null && String(item.id)) owners.set(String(item.id), String(turn.id));
  }
  const updates = (Array.isArray(incoming) ? incoming : []).filter(turn => turn?.id != null);
  for (const turn of updates) {
    const id = String(turn.id);
    if (!latest && turns.has(id)) continue;
    for (const item of turn.items || []) {
      if (item.type === "userMessage" && item.id != null && String(item.id) && (latest || !owners.has(String(item.id)))) owners.set(String(item.id), id);
    }
    turns.set(id, turn);
  }
  // Native snapshots can reassign one stable user item to another turn. A later
  // historical page must not move it back into its old cached position.
  return [...turns.values()].map(turn => {
    const seen = new Set();
    const items = (turn.items || []).filter(item => {
      if (item.type !== "userMessage" || item.id == null || !String(item.id)) return true;
      const id = String(item.id);
      if (owners.get(id) !== String(turn.id) || seen.has(id)) return false;
      seen.add(id); return true;
    });
    return items.length === (turn.items || []).length ? turn : { ...turn, items };
  });
}

export function transcriptAnchor(scroller) {
  const bounds = scroller.getBoundingClientRect();
  const anchor = [...scroller.querySelectorAll(".turn")].find(turn => turn.getBoundingClientRect().bottom > bounds.top);
  return anchor ? { turnId: anchor.dataset.turnId, offset: anchor.getBoundingClientRect().top - bounds.top, scrollTop: scroller.scrollTop } : { turnId: null, offset: 0, scrollTop: scroller.scrollTop };
}

export function restoreTranscriptAnchor(scroller, anchor) {
  if (!anchor?.turnId) {
    scroller.scrollTop = anchor?.scrollTop ?? 0;
    return;
  }
  const turn = [...scroller.querySelectorAll(".turn")].find(item => item.dataset.turnId === anchor.turnId);
  if (!turn) {
    scroller.scrollTop = anchor.scrollTop ?? 0;
    return;
  }
  const bounds = scroller.getBoundingClientRect();
  scroller.scrollTop += turn.getBoundingClientRect().top - bounds.top - anchor.offset;
}
