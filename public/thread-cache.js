function cloneSnapshot(snapshot) {
  return JSON.parse(JSON.stringify(snapshot));
}

function validateLimit(name, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

export function createThreadSnapshotCache({ maxEntries = 20, maxTurns = 1000 } = {}) {
  validateLimit("maxEntries", maxEntries);
  validateLimit("maxTurns", maxTurns);

  const entries = new Map();
  let turnCount = 0;

  function remove(threadId) {
    const entry = entries.get(threadId);
    if (!entry) return false;
    entries.delete(threadId);
    turnCount -= entry.snapshot.turns.length;
    return true;
  }

  return {
    restore(threadId) {
      const entry = entries.get(threadId);
      if (!entry) return undefined;
      entries.delete(threadId);
      entries.set(threadId, entry);
      return cloneSnapshot(entry.snapshot);
    },

    save(threadId, snapshot) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new TypeError("threadId must be a non-empty string");
      }
      if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.turns)) {
        throw new TypeError("snapshot must be an object with a turns array");
      }

      const copiedSnapshot = cloneSnapshot(snapshot);
      remove(threadId);

      if (maxEntries === 0 || copiedSnapshot.turns.length > maxTurns) return false;

      entries.set(threadId, { snapshot: copiedSnapshot });
      turnCount += copiedSnapshot.turns.length;

      while (entries.size > maxEntries || turnCount > maxTurns) {
        remove(entries.keys().next().value);
      }
      return entries.has(threadId);
    },

    delete(threadId) {
      return remove(threadId);
    },

    clear() {
      entries.clear();
      turnCount = 0;
    },

    get size() {
      return entries.size;
    },

    get turnCount() {
      return turnCount;
    }
  };
}
