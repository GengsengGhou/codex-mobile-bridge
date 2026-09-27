import { readFile } from 'node:fs/promises';

export function canonicalPath(value) {
  if (typeof value !== 'string') return '';
  const path = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return /^[a-z]:\//i.test(path) || path.startsWith('//') ? path.toLowerCase() : path;
}

// Only sidebar membership is retained. Other desktop preferences are never forwarded.
export async function readSidebarMetadata(path) {
  try {
    const state = JSON.parse(await readFile(path, 'utf8'));
    return {
      projects: Object.values(state['local-projects'] ?? {}).filter(p => p && typeof p.id === 'string').map(p => ({ id: p.id, name: p.name, rootPaths: Array.isArray(p.rootPaths) ? p.rootPaths.filter(p => typeof p === 'string') : [] })),
      assignments: state['thread-project-assignments'] ?? {},
      projectless: Array.isArray(state['projectless-thread-ids']) ? state['projectless-thread-ids'] : [],
      projectOrder: Array.isArray(state['project-order']) ? state['project-order'] : [],
      threadOrders: Object.fromEntries(Object.entries(state['sidebar-project-thread-orders'] ?? {}).map(([id, order]) => [id, Array.isArray(order?.threadIds) ? order.threadIds : Array.isArray(order) ? order : []])),
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
  const threadOrder = metadata.threadOrders?.[projectId]?.indexOf(thread.id) ?? -1;
  return { projectId, projectKey, projectName, projectPath, projectOrder: order < 0 ? 9999 : order, projectThreadOrder: threadOrder < 0 ? 9999 : threadOrder };
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
