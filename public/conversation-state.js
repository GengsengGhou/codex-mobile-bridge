function messageKey(turn, item) {
  return `${String(turn?.id ?? "")}\u001f${String(item?.id ?? "")}`;
}

function attachmentPromptKey(value, expectedCount) {
  if (typeof value !== "string" || !Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 5) return null;
  const text = value.replace(/\r\n?/g, "\n").trim();
  const marker = "\n\n附件：\n";
  const markerIndex = text.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const base = text.slice(0, markerIndex);
  const lines = text.slice(markerIndex + marker.length).split("\n");
  if (lines.length !== expectedCount) return null;

  const htmlDecode = input => {
    let result = input;
    for (let pass = 0; pass < 2; pass++) {
      const decoded = result.replace(/&(?:amp|lt|gt|quot|#39|#x27);/gi, entity => ({
        "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'",
      })[entity.toLowerCase()] ?? entity);
      if (decoded === result) break;
      result = decoded;
    }
    return result;
  };
  const links = [];
  for (const source of lines) {
    const line = htmlDecode(source);
    const match = line.match(/^\[((?:\\.|[^\]])*)\]\((.*)\)$/);
    if (!match) return null;
    let path = match[2];
    if (path.startsWith("<") && path.endsWith(">")) path = path.slice(1, -1);
    const drive = path.match(/^([a-z]):[\\/]/i);
    const unc = path.startsWith("\\\\");
    if (drive) path = `${drive[1].toLowerCase()}:${path.slice(2).replaceAll("\\", "/")}`;
    else if (unc) path = `//${path.slice(2).replaceAll("\\", "/")}`;
    else if (!path.startsWith("/") || path.startsWith("//")) return null;
    const label = htmlDecode(match[1].replace(/\\([\\[\]])/g, "$1"));
    links.push([label, path]);
  }
  return JSON.stringify([base, links]);
}

function sameUserMessage(message, item) {
  if (item?.text === message.prompt) return true;
  const attachmentCount = Array.isArray(message.attachmentIds) ? message.attachmentIds.length : 0;
  if (!attachmentCount) return false;
  const expected = attachmentPromptKey(message.prompt, attachmentCount);
  return expected !== null && expected === attachmentPromptKey(item?.text, attachmentCount);
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
        const baselineKeys = Array.isArray(message.baselineKeys) ? message.baselineKeys : [];
        const preexisting = baselineKeys.some(value => value === key || stableId && value.endsWith(`\u001f${stableId}`));
        if (item?.type === "userMessage" && sameUserMessage(message, item)
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
