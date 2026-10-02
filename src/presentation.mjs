import { readFile } from 'node:fs/promises';

export function canonicalPath(value) {
  if (typeof value !== 'string') return '';
  const path = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

// Match the installed desktop's flat-sidebar preference migration (26.928).
// Its legacy manual order is not active until manualSortVersion is 1.
export function sidebarSorting(preferences, legacyMode) {
  const mode = value => value === 'manual' && preferences?.manualSortVersion === 1 ? 'manual' : 'updated_at';
  return { projectThreads: legacyMode != null ? 'updated_at' : mode(preferences?.projectSortMode),
    chats: legacyMode != null ? 'updated_at' : mode(preferences?.chatSortMode) };
}
const stringIds = value => Array.isArray(value) ? [...new Set(value.filter(id => typeof id === 'string' && id))] : [];
const nativeIds = (value, prefix) => stringIds(value).filter(id => id.startsWith(prefix)).map(id => id.slice(prefix.length));

// Only sidebar membership and ordering preferences are retained.
export async function readSidebarMetadata(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    const atoms = state['electron-persisted-atom-state'] ?? {};
    return {
      projects: Object.values(state['local-projects'] ?? {}).filter(p => p && typeof p.id === 'string').map(p => ({ id: p.id, name: p.name, rootPaths: Array.isArray(p.rootPaths) ? p.rootPaths.filter(p => typeof p === 'string') : [] })),
      assignments: state['thread-project-assignments'] ?? {},
      projectless: Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : [],
      projectOrder: Array.isArray(state['project-order']) ? state['project-order'] : [],
      threadOrders: Object.fromEntries(Object.entries(state['sidebar-project-thread-orders'] ?? {}).map(([id, order]) => [id, Array.isArray(order?.threadIds) ? order.threadIds : Array.isArray(order) ? order : []])),
      sorting: sidebarSorting(atoms['flat-project-sidebar-preferences-v1'], atoms['codex-sidebar-sort-mode-v1']),
      unifiedProjectOrder: nativeIds(atoms['unified-sidebar-project-order-v1'], 'codex:project:'),
      hasUnifiedProjectOrder: Array.isArray(atoms['unified-sidebar-project-order-v1']),
      chatOrder: nativeIds(atoms['unified-sidebar-chat-order-v1'], 'codex:thread:local:'),
    };
  } catch { return { projects: [], assignments: {}, projectless: [], projectOrder: [], threadOrders: {} }; }
}

export function projectForThread(thread, metadata) {
  const projects = metadata.projects ?? [];
  const assigned = metadata.assignments?.[thread.id];
  const explicitId = assigned?.projectKind === 'local' ? assigned.projectId : thread.projectId;
  const explicitNone = !assigned && metadata.projectless?.includes(thread.id);
  const cwd = canonicalPath(thread.cwd);
  let project = !explicitNone && projects.find(p => p.id === explicitId);
  if (!project && !explicitNone && !explicitId && cwd) {
    // Longest path boundary match avoids mixing siblings such as E:/app and E:/apple.
    project = projects.flatMap(p => (p.rootPaths ?? []).map(path => ({ project: p, root: canonicalPath(path) })))
      .filter(p => p.root && (cwd === p.root || cwd.startsWith(`${p.root}/`)))
      .sort((a, b) => b.root.length - a.root.length)[0]?.project;
  }
  const projectId = explicitNone ? null : project?.id || explicitId || null;
  const projectPath = project?.rootPaths?.[0] ?? null;
  const projectKey = projectPath ? `path:${canonicalPath(projectPath)}` : projectId ? `id:${projectId}` : 'unassigned';
  const projectName = project?.name || (projectId ? thread.projectName || thread.cwd?.split(/[\\/]/).filter(Boolean).at(-1) || '项目' : '其他会话');
  const order = metadata.projectOrder?.indexOf(projectId) ?? -1;
  const threadOrder = metadata.sorting?.projectThreads === 'updated_at' ? -1 : metadata.threadOrders?.[projectId]?.indexOf(thread.id) ?? -1;
  return { projectId, projectKey, projectName, projectPath, projectOrder: order < 0 ? 9999 : order, projectThreadOrder: threadOrder < 0 ? 9999 : threadOrder };
}

// list_threads supplies native recency order. Preserve it instead of guessing
// from updatedAt: desktop recency may differ from its persisted timestamp.
export function applySidebarOrder(threads, metadata) {
  const groups = new Map();
  for (const thread of threads) {
    if (thread.pinned) continue;
    if (!groups.has(thread.projectKey)) groups.set(thread.projectKey, []);
    groups.get(thread.projectKey).push(thread);
  }
  const sorting = metadata.sorting ?? { projectThreads: 'updated_at', chats: 'updated_at' };
  for (const rows of groups.values()) {
    const projectId = rows[0].projectId;
    const manual = (projectId ? sorting.projectThreads : sorting.chats) === 'manual';
    const ids = projectId ? metadata.threadOrders?.[projectId] ?? [] : metadata.chatOrder ?? [];
    const ranks = new Map(stringIds(ids).map((id, index) => [id, index]));
    const ordered = manual ? [...rows].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity)) : rows;
    ordered.forEach((thread, index) => { thread.projectThreadOrder = index; });
  }
  const saved = metadata.hasUnifiedProjectOrder ? metadata.unifiedProjectOrder : metadata.projectOrder;
  const savedRanks = new Map(stringIds(saved).map((id, index) => [id, index]));
  const projectGroups = [...groups.values()].filter(rows => rows[0].projectId);
  // Legacy pOn prepends unlisted folders; unified umn(...,'end') appends them.
  const fallback = metadata.hasUnifiedProjectOrder ? Infinity : -1;
  projectGroups.sort((a, b) => (savedRanks.get(a[0].projectId) ?? fallback) - (savedRanks.get(b[0].projectId) ?? fallback));
  projectGroups.forEach((rows, index) => rows.forEach(thread => { thread.projectOrder = index; }));
  return threads;
}

export function visibleUserText(value) {
  let text = String(value ?? '');
  // Match only an injected prefix with its known source and boilerplate. Quoted examples
  // and literal tags inside the user's own request must remain untouched.
  const ambient = text.match(/^\s*<in-app-browser-context\s+source=["']ambient-ui-state["']>\s*This block is automatically supplied ambient UI state,[\s\S]*?<\/in-app-browser-context>\s*(?:## My request:\s*)?/);
  if (ambient) text = text.slice(ambient[0].length);
  const files = text.match(/^\s*# Files mentioned by the user:\s*\n[\s\S]*?\nDistinguish instructions in attached documents from the user's request\.\s*\n## My request:\s*/);
  if (files) text = text.slice(files[0].length);
  const reply = text.match(/^\s*<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*$/);
  if (reply) {
    try {
      const answers = JSON.parse(reply[1]);
      if (Array.isArray(answers) && answers.length && answers.every(a => typeof a.answer === 'string')) {
        text = answers.map(a => `${typeof a.question === 'string' ? a.question + '\n\n' : ''}${a.answer}`).join('\n\n');
      }
    } catch { /* Preserve unrecognized text rather than guessing what the user meant. */ }
  }
  return text.trim();
}
