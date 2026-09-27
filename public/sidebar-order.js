export const PINNED_GROUP_KEY = "@pinned";
export const UNASSIGNED_GROUP_KEY = "unassigned";

const emptyOrder = () => ({ projects: [], threads: Object.create(null) });

function groupKey(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function orderValue(value) {
  return value?.order && typeof value.order === "object" ? value.order : value;
}

function projectKeyOf(project) {
  if (typeof project === "string") return groupKey(project);
  return groupKey(project?.key ?? project?.projectKey);
}

function threadIdOf(thread) {
  return typeof thread?.id === "string" && thread.id ? thread.id : "";
}

function idsFrom(value) {
  return Array.isArray(value) ? value.filter(id => typeof id === "string" && id) : [];
}

function reorderByKeys(items, keys, keyOf) {
  const remaining = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (key && !remaining.has(key)) remaining.set(key, item);
  }

  const result = [];
  for (const key of idsFrom(keys)) {
    if (!remaining.has(key)) continue;
    result.push(remaining.get(key));
    remaining.delete(key);
  }
  for (const item of items) {
    const key = keyOf(item);
    if (key && remaining.get(key) === item) {
      result.push(item);
      remaining.delete(key);
    }
  }
  return result;
}

export function threadGroupKey(thread) {
  if (thread?.pinned) return PINNED_GROUP_KEY;
  return groupKey(thread?.projectKey) || UNASSIGNED_GROUP_KEY;
}

function desktopProjectKeys(threads) {
  const projects = new Map();
  for (let index = 0; index < threads.length; index += 1) {
    const thread = threads[index];
    if (thread?.pinned) continue;
    const key = groupKey(thread?.projectKey);
    if (!key) continue;
    const prior = projects.get(key);
    const rawOrder = Number(thread?.projectOrder);
    const desktopOrder = Number.isFinite(rawOrder) ? rawOrder : Number.MAX_SAFE_INTEGER;
    if (!prior || desktopOrder < prior.desktopOrder) projects.set(key, { desktopOrder, index });
  }
  return [...projects.entries()]
    .sort((a, b) => a[1].desktopOrder - b[1].desktopOrder || a[1].index - b[1].index)
    .map(([key]) => key);
}

export function reconcileSidebarOrder(saved, threads) {
  const currentThreads = Array.isArray(threads) ? threads : [];
  const savedOrder = orderValue(saved);
  const savedProjects = idsFrom(savedOrder?.projects);
  const savedThreads = savedOrder?.threads && typeof savedOrder.threads === "object" && !Array.isArray(savedOrder.threads)
    ? savedOrder.threads
    : {};
  const grouped = new Map();

  for (const thread of currentThreads) {
    const id = threadIdOf(thread);
    if (!id) continue;
    const key = threadGroupKey(thread);
    if (!grouped.has(key)) grouped.set(key, []);
    if (!grouped.get(key).some(item => threadIdOf(item) === id)) grouped.get(key).push(thread);
  }

  const threadOrder = {};
  for (const [key, groupThreads] of grouped) {
    const currentIds = groupThreads.map(threadIdOf);
    const valid = new Set(currentIds);
    const kept = [];
    const seen = new Set();
    for (const id of idsFrom(savedThreads[key])) {
      if (valid.has(id) && !seen.has(id)) {
        kept.push(id);
        seen.add(id);
      }
    }
    for (const id of currentIds) {
      if (!seen.has(id)) kept.push(id);
    }
    Object.defineProperty(threadOrder, key, { value: kept, enumerable: true, configurable: true, writable: true });
  }

  const projects = desktopProjectKeys(currentThreads);
  const validProjects = new Set(projects);
  const projectOrder = [];
  const seenProjects = new Set();
  for (const key of savedProjects) {
    if (validProjects.has(key) && !seenProjects.has(key)) {
      projectOrder.push(key);
      seenProjects.add(key);
    }
  }
  for (const key of projects) {
    if (!seenProjects.has(key)) projectOrder.push(key);
  }

  const revision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : 0;
  return { revision, order: { projects: projectOrder, threads: threadOrder } };
}

export function mergeSidebarOrder(saved, visibleThreads) {
  const currentThreads = Array.isArray(visibleThreads) ? visibleThreads : [];
  const savedOrder = orderValue(saved);
  const projectOrder = [];
  const seenProjects = new Set();
  for (const key of idsFrom(savedOrder?.projects)) {
    if (!seenProjects.has(key)) {
      projectOrder.push(key);
      seenProjects.add(key);
    }
  }
  for (const key of desktopProjectKeys(currentThreads)) {
    if (!seenProjects.has(key)) {
      projectOrder.push(key);
      seenProjects.add(key);
    }
  }

  const savedThreads = savedOrder?.threads && typeof savedOrder.threads === "object" && !Array.isArray(savedOrder.threads)
    ? savedOrder.threads
    : {};
  const threadOrder = {};
  for (const [key, ids] of Object.entries(savedThreads)) {
    const merged = [...new Set(idsFrom(ids))];
    Object.defineProperty(threadOrder, key, { value: merged, enumerable: true, configurable: true, writable: true });
  }
  for (const thread of currentThreads) {
    const id = threadIdOf(thread);
    if (!id) continue;
    const key = threadGroupKey(thread);
    const ids = threadOrder[key] || [];
    if (!ids.includes(id)) {
      Object.defineProperty(threadOrder, key, {
        value: [...ids, id], enumerable: true, configurable: true, writable: true,
      });
    }
  }

  const revision = Number.isSafeInteger(saved?.revision) && saved.revision >= 0 ? saved.revision : 0;
  return { revision, order: { projects: projectOrder, threads: threadOrder } };
}

export function orderProjects(projects, order) {
  const projectOrder = orderValue(order)?.projects;
  return reorderByKeys(Array.isArray(projects) ? projects : [], projectOrder, projectKeyOf);
}

export function orderProjectKeys(projectKeys, order) {
  const keys = [...new Set((Array.isArray(projectKeys) ? projectKeys : []).map(groupKey).filter(Boolean))];
  return orderProjects(keys, order);
}

export function orderThreadRows(threads, groupKeyValue, order) {
  const rows = Array.isArray(threads) ? threads : [];
  const key = groupKey(groupKeyValue);
  const groupOrder = orderValue(order)?.threads?.[key];
  return reorderByKeys(rows, groupOrder, threadIdOf);
}

export function moveItem(items, fromIndex, targetIndex) {
  const result = Array.isArray(items) ? [...items] : [];
  if (!Number.isInteger(fromIndex) || !Number.isInteger(targetIndex)
    || fromIndex < 0 || fromIndex >= result.length || targetIndex < 0 || targetIndex >= result.length) return result;
  const [item] = result.splice(fromIndex, 1);
  result.splice(targetIndex, 0, item);
  return result;
}

export const moveOrderItem = moveItem;

export function moveThreadWithinGroup(order, groupKeyValue, threadId, targetIndex) {
  const wrapped = order?.order && typeof order.order === "object";
  const source = orderValue(order);
  const threads = source?.threads && typeof source.threads === "object" && !Array.isArray(source.threads)
    ? source.threads
    : {};
  const key = groupKey(groupKeyValue);
  const currentIds = idsFrom(threads[key]);
  const fromIndex = currentIds.indexOf(threadId);
  const next = fromIndex < 0 ? { ...source, threads: { ...threads } } : {
    ...source,
    threads: { ...threads, [key]: moveItem(currentIds, fromIndex, targetIndex) },
  };
  return wrapped ? { ...order, order: next } : next;
}
