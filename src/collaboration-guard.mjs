import { resolve, dirname } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { effectivePolicy, readPrivate, UUID, validRoot } from '../scripts/collaboration-common.mjs';
import { BridgeError } from './desktop.mjs';

export function createCollaborationGuard({ root = fileURLToPath(new URL('..', import.meta.url)) } = {}) {
  return async function authorize(req, thread, projects, projectId) {
    const source = req.headers['x-collaboration-source'];
    if (!source) return;
    const deny = () => { throw new BridgeError('电脑协作授权已改变或项目不在允许范围。', 'COLLABORATION_NOT_AUTHORIZED', 403); };
    const config = await readPrivate(resolve(root, '.local/hub-connector.json'));
    const p = effectivePolicy(await readPrivate(resolve(root, '.local/computer-collaboration.json')), config);
    if (!UUID.test(source) || req.headers['x-collaboration-target'] !== config?.deviceId || !p.receiveEnabled || !p.allowedDeviceIds.includes(source)) deny();
    if (/\/(respond|settings|uploads)(?:\/|$)/.test(req.url)) deny();
    if (!thread && projectId === undefined) return;
    const project = projects.find(item => item.projectId === (projectId ?? thread?.projectId) || !projectId && !thread?.projectId && thread?.cwd && resolve(item.path) === resolve(thread.cwd));
    if (!project || project.hostId !== 'local' || !validRoot(project.path) || !p.allowedProjectRoots.some(path => resolve(path) === resolve(project.path))) deny();
    if (thread && (thread.kind !== 'codex' || thread.hostId && thread.hostId !== 'local' || thread.archived || thread.delegated || !validRoot(thread.cwd) || resolve(thread.cwd) !== resolve(project.path))) deny();
    let current = resolve(project.path);
    try { while (true) { if ((await lstat(current)).isSymbolicLink()) deny(); const parent = dirname(current); if (parent === current) break; current = parent; } await realpath(project.path); }
    catch { deny(); }
  };
}
