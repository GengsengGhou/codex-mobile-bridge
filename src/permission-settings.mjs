import { BridgeError } from './desktop.mjs';
import { posix, win32 } from 'node:path';

export const permissionOptions = Object.freeze([
  Object.freeze({ id: 'request-approval', label: '请求批准' }),
  Object.freeze({ id: 'full-access', label: '完全访问' }),
]);

export function permissionSelection(body) {
  if (body.permissionMode === undefined) return {};
  if (!permissionOptions.some(option => option.id === body.permissionMode)) throw new BridgeError('权限模式无效，请重新选择', 'INVALID_REQUEST', 400);
  return { permissionMode: body.permissionMode };
}

export function currentPermissionMode(state, latestTurn) {
  const settings = state.latestThreadSettings, turn = latestTurn?.params, current = state.currentPermissions;
  const approval = settings?.approvalPolicy ?? turn?.approvalPolicy ?? current?.approvalPolicy;
  const sandbox = settings?.sandboxPolicy ?? turn?.sandboxPolicy ?? current?.sandboxPolicy;
  const reviewer = settings?.approvalsReviewer ?? turn?.approvalsReviewer ?? current?.approvalsReviewer;
  if (approval == null || sandbox?.type == null || reviewer == null) return 'unknown';
  if (reviewer !== 'user') return 'custom';
  if (approval === 'never' && sandbox.type === 'dangerFullAccess') return 'full-access';
  if (approval === 'on-request' && sandbox.type === 'workspaceWrite' && sandbox.networkAccess === false && sandbox.excludeSlashTmp === false && sandbox.excludeTmpdirEnvVar === false) return 'request-approval';
  return 'custom';
}

export function permissionRoots(state) {
  const roots = state.currentPermissions?.runtimeWorkspaceRoots;
  const values = roots === undefined ? [state.cwd] : roots;
  const key = value => {
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return null;
    const root = win32.parse(value).root;
    if (win32.isAbsolute(value) && (/^[a-z]:[\\/]$/i.test(root) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(root))) return win32.normalize(value).toLowerCase();
    if (posix.isAbsolute(value) && !value.startsWith('//')) return posix.normalize(value);
    return null;
  };
  if (!Array.isArray(values) || values.length > 32 || key(state.cwd) === null) return null;
  const unique = new Map();
  for (const value of [...values, state.cwd]) {
    const normalized = key(value); if (normalized === null) return null;
    if (!unique.has(normalized)) unique.set(normalized, value);
  }
  return [...unique.values()];
}

// Installed desktop 26.924.2738: app-shared rA/Hrt/tA; native FCe handles
// explicit request permissions. usePermissionSelection=true would use defaults.
export function nativePermissionSettings(mode, roots) {
  permissionSelection({ permissionMode: mode });
  if (!Array.isArray(roots) || !roots.length) throw new BridgeError('无法确认会话的权限工作目录，请在桌面载入后重试', 'PERMISSION_UNAVAILABLE', 503);
  return {
    approvalPolicy: mode === 'full-access' ? 'never' : 'on-request',
    approvalsReviewer: 'user',
    permissions: mode === 'full-access' ? ':danger-full-access' : ':workspace',
    runtimeWorkspaceRoots: roots,
  };
}
