import { resolve } from 'node:path';
import { effectivePolicy, readPrivate, writePrivate, localBridge, UUID, validRoot, fail, withCollaborationLock, collaborationAuthorizationMessage, assertNoCollaborationReset, collaborationResetGeneration, assertCollaborationResetGeneration } from './collaboration-common.mjs';
import { hubCollaboration } from './collaboration-client.mjs';
import { registerCollaboration } from './collaboration-registration.mjs';

export async function collaborationSettings(command, { root, configPath = resolve(root, '.local/hub-connector.json'), fetchImpl, bridge = localBridge, register = registerCollaboration, codexHome, nodePath } = {}) {
  if (command.action === 'save-collaboration') {
    const generation = await collaborationResetGeneration(root);
    return withCollaborationLock(resolve(root, '.local/collaboration-settings'), async () => { await assertCollaborationResetGeneration(root, generation); return changeSettings(command, { root, configPath, fetchImpl, bridge, register, codexHome, nodePath }); });
  }
  return changeSettings(command, { root, configPath, fetchImpl, bridge, register, codexHome, nodePath });
}
async function changeSettings(command, { root, configPath, fetchImpl, bridge, register, codexHome, nodePath }) {
  if (command.action === 'save-collaboration') await assertNoCollaborationReset(root);
  const policyPath = resolve(root, '.local/computer-collaboration.json'); const config = await readPrivate(configPath);
  if (command.action === 'save-collaboration' && (Object.hasOwn(command, 'expectedHubOrigin') || Object.hasOwn(command, 'expectedDeviceId'))) {
    if (typeof command.expectedHubOrigin !== 'string' || !command.expectedHubOrigin || command.expectedHubOrigin.length > 2048 || typeof command.expectedDeviceId !== 'string' || !UUID.test(command.expectedDeviceId)) fail('INVALID_COLLABORATION_SETTINGS', 400, '电脑协作设置无效。');
    if (command.expectedHubOrigin !== config?.hubOrigin || command.expectedDeviceId !== config?.deviceId) fail('COLLABORATION_BINDING_CHANGED', 409, '配对已改变，请刷新电脑协作设置并重新选择授权。');
  }
  const policy = effectivePolicy(await readPrivate(policyPath), config);
  const downgrade = command.action === 'save-collaboration' && typeof command.controlEnabled === 'boolean' && typeof command.receiveEnabled === 'boolean' && (!command.controlEnabled || policy.controlEnabled) && (!command.receiveEnabled || policy.receiveEnabled) && Array.isArray(command.allowedDeviceIds) && Array.isArray(command.allowedProjectRoots) && (!command.receiveEnabled || command.allowedDeviceIds.every(v => policy.allowedDeviceIds.includes(v)) && command.allowedProjectRoots.every(v => policy.allowedProjectRoots.includes(v)));
  let devices = [], projects = [], featureAvailable = false, projectsAvailable = false, error = '', featureCode;
  if (config && !downgrade) {
    try { devices = (await hubCollaboration(config, null, null, { fetchImpl, timeoutMs: 8000 })).devices; featureAvailable = true; }
    catch (e) { featureCode = e.code; error = e.code === 'DEVICE_REVOKED' ? e.message : e.code === 'FEATURE_UNAVAILABLE' || e.code === 'FORBIDDEN' || e.code === 'LOGIN_REQUIRED' ? '服务器尚未支持电脑协作，请由管理员更新服务器后重试。' : '暂时无法读取同账号电脑，请检查服务器连接后重试。'; }
    try { projects = (await bridge(config, '/api/projects', undefined, { timeoutMs: 8000 })).projects.map(p => ({ id: p.projectId, cwd: p.path, name: p.label })); projectsAvailable = true; }
    catch { error ||= '本机 Codex 尚未就绪，请打开 Codex 后重试。'; }
  }
  let registration = await readPrivate(resolve(root, '.local/collaboration-registration-state.json'), { status: 'disabled' });
  if (command.action === 'save-collaboration') {
    if (Object.keys(command).some(k => !['action', 'controlEnabled', 'receiveEnabled', 'allowedDeviceIds', 'allowedProjectRoots', 'expectedHubOrigin', 'expectedDeviceId'].includes(k)) || typeof command.controlEnabled !== 'boolean' || typeof command.receiveEnabled !== 'boolean' || !Array.isArray(command.allowedDeviceIds) || !Array.isArray(command.allowedProjectRoots) || command.allowedDeviceIds.length > 10 || command.allowedProjectRoots.length > 100 || command.allowedDeviceIds.some(v => !UUID.test(v || '')) || command.allowedProjectRoots.some(v => !validRoot(v))) fail('INVALID_COLLABORATION_SETTINGS', 400, '电脑协作设置无效。');
    if (!downgrade && (command.controlEnabled || command.receiveEnabled) && !featureAvailable) fail(featureCode === 'DEVICE_REVOKED' ? featureCode : 'FEATURE_UNAVAILABLE', 503, error || '请先配对并连接服务器。');
    if (!downgrade && command.receiveEnabled && !projectsAvailable) fail('COLLABORATION_PROJECTS_UNAVAILABLE', 503, '本机项目列表暂时无法读取，尚未保存授权。已保留原设置；请打开 Codex，刷新电脑协作设置后重试。');
    if (!downgrade && command.receiveEnabled && (command.allowedDeviceIds.some(v => !devices.some(d => d.id === v)) || command.allowedProjectRoots.some(v => !projects.some(p => p.cwd === v)))) fail('COLLABORATION_SELECTION_CHANGED', 409, '所选电脑或项目已改变，请刷新后重新选择。');
    if (command.receiveEnabled && (!command.allowedDeviceIds.length || !command.allowedProjectRoots.length)) fail('COLLABORATION_EMPTY_ALLOWLIST', 400, '请至少选择一台允许的电脑和一个本机项目。');
    const value = { version: 1, hubOrigin: config?.hubOrigin, deviceId: config?.deviceId, controlEnabled: false, controlPending: command.controlEnabled, ...(command.controlEnabled ? {} : { requiresAuthorization: false }), receiveEnabled: command.receiveEnabled, allowedDeviceIds: [...new Set(command.allowedDeviceIds)], allowedProjectRoots: [...new Set(command.allowedProjectRoots)] };
    // Disable tool use before removing configuration; a registration conflict never leaves tools active.
    await writePrivate(policyPath, value);
    try { registration = await register({ root, enabled: command.controlEnabled, codexHome, nodePath }); }
    catch (e) { registration = { status: 'error', code: e.code || 'COLLABORATION_REGISTRATION_FAILED', message: e.message }; await writePrivate(resolve(root, '.local/collaboration-registration-state.json'), registration); delete value.controlPending; await writePrivate(policyPath, value); throw e; }
    const current = await readPrivate(configPath); if (config && (current?.deviceId !== config.deviceId || current?.hubOrigin !== config.hubOrigin || current?.deviceToken !== config.deviceToken)) fail('COLLABORATION_BINDING_CHANGED', 409, '配对已改变，请刷新电脑协作设置。');
    delete value.controlPending; value.requiresAuthorization = false; value.controlEnabled = command.controlEnabled; await writePrivate(policyPath, value);
    await writePrivate(resolve(root, '.local/collaboration-registration-state.json'), registration);
    Object.assign(policy, value, { requiresAuthorization: false });
    delete policy.controlPending;
  }
  if (policy.controlPending) registration = { status: 'recovering', message: '电脑协作设置正在保存，请稍后重试。' };
  if (policy.requiresAuthorization) registration = { status: 'authorization-required', message: collaborationAuthorizationMessage };
  return { collaboration: { ...policy, hubOrigin: config?.hubOrigin, deviceId: config?.deviceId, paired: !!config, devices, projects, devicesAvailable: featureAvailable, projectsAvailable, featureAvailable, error, registration } };
}
