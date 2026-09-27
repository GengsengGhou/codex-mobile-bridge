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
        if (item?.type === "userMessage" && item.text === message.prompt
          && !message.baselineKeys?.includes(key) && available.has(key)) {
          available.delete(key);
          return false;
        }
      }
    }
    return true;
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
