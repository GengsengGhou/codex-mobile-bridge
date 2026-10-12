import { readFile, lstat, unlink } from 'node:fs/promises';
import { resolve, dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hubOrigin } from './setup-connector.mjs';
import { createConnectorControl } from './connector-control.mjs';
import { removeCollaborationForReset } from './collaboration-registration.mjs';
import { writePrivate, readPrivate, withCollaborationLock, collaborationResetPath, fail, UUID } from './collaboration-common.mjs';

const identityFiles = ['hub-connector.json', 'hub-connector-state.json', 'computer-collaboration.json', 'collaboration-registration.json', 'collaboration-registration-state.json', 'connector-login.json', 'runtime.json', 'recovery.json', 'recovery-state.json'];
async function ordinaryPath(path) {
  for (let current = resolve(path);; current = dirname(current)) {
    try { if ((await lstat(current)).isSymbolicLink()) fail('COLLABORATION_RESET_UNSAFE_PATH', 403, '安装或配置路径包含链接，尚未重置。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(current) === current) return;
  }
}
async function verifyInstallation(root) {
  if (!isAbsolute(root) || /^(?:\\\\|\/\/)/.test(root)) fail('COLLABORATION_RESET_INSTALLATION_UNVERIFIED', 403, '无法确认当前安装目录，尚未重置。');
  await ordinaryPath(root); await ordinaryPath(resolve(root, 'installed.json')); await ordinaryPath(resolve(root, '.local'));
  let marker; try { marker = JSON.parse(await readFile(resolve(root, 'installed.json'), 'utf8')); } catch { fail('COLLABORATION_RESET_INSTALLATION_UNVERIFIED', 403, '无法确认当前安装目录，尚未重置。'); }
  if (marker?.version !== 1 || typeof marker.root !== 'string' || resolve(marker.root).toLowerCase() !== root.toLowerCase()) fail('COLLABORATION_RESET_INSTALLATION_UNVERIFIED', 403, '安装目录记录不一致，尚未重置。');
}
async function discardFile(path) {
  await ordinaryPath(path);
  try { if (!(await lstat(path)).isFile()) fail('COLLABORATION_RESET_UNSAFE_PATH', 403, '待重置的身份文件不是普通文件，已保留。'); await unlink(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export async function resetCollaborationPairing(command, { root, control, removeRegistration = removeCollaborationForReset, codexHome, beforeRegistrationReplace } = {}) {
  if (command.confirm !== true || Object.keys(command).some(key => !['action', 'confirm', 'expectedHubOrigin', 'expectedDeviceId'].includes(key))) fail('COLLABORATION_RESET_CONFIRMATION_REQUIRED', 400, '请在应用内明确确认重置范围。');
  if (Object.hasOwn(command, 'expectedHubOrigin') || Object.hasOwn(command, 'expectedDeviceId')) {
    if (typeof command.expectedHubOrigin !== 'string' || typeof command.expectedDeviceId !== 'string' || !UUID.test(command.expectedDeviceId)) fail('INVALID_COLLABORATION_SETTINGS', 400, '重置确认身份无效。');
    hubOrigin(command.expectedHubOrigin);
  }
  if (typeof root !== 'string') fail('COLLABORATION_RESET_INSTALLATION_UNVERIFIED', 403);
  if (!isAbsolute(root)) fail('COLLABORATION_RESET_INSTALLATION_UNVERIFIED', 403);
  root = resolve(root); await verifyInstallation(root);
  return withCollaborationLock(resolve(root, '.local/collaboration-settings'), async () => {
    await verifyInstallation(root);
    const pairingPath = resolve(root, '.local/hub-connector.json'); await ordinaryPath(pairingPath);
    let pairing; try { pairing = await readPrivate(pairingPath); } catch { pairing = null; }
    let identityValid = typeof pairing?.deviceId === 'string' && UUID.test(pairing.deviceId); try { hubOrigin(pairing?.hubOrigin); } catch { identityValid = false; }
    if (identityValid && command.expectedHubOrigin !== undefined && (command.expectedHubOrigin !== pairing.hubOrigin || command.expectedDeviceId !== pairing.deviceId)) fail('COLLABORATION_BINDING_CHANGED', 409, '配对身份已改变，请重新打开重置确认。');
    const result = { completed: false, partialFailure: false, code: null, registrationRemoved: false, registrationPreserved: false, pairingCleared: false, serverDeviceRecordRemoved: false, needsPairing: true };
    try { if (pairing?.hubOrigin) result.previousHubOrigin = hubOrigin(pairing.hubOrigin); } catch {}
    const journalPath = collaborationResetPath(root); await ordinaryPath(journalPath);
    await writePrivate(journalPath, { version: 1, root, phase: 'pausing' });
    try {
      const generationPath = resolve(root, '.local/collaboration-reset-generation.json'); await ordinaryPath(generationPath); await writePrivate(generationPath, { version: 1, generation: randomUUID() });
      await (control || createConnectorControl({ root })).resetForRecovery();
      await writePrivate(journalPath, { version: 1, root, phase: 'registration' });
      let registrationError;
      try {
        const registration = await removeRegistration({ root, codexHome, beforeReplace: beforeRegistrationReplace });
        result.registrationRemoved = registration.removed === true; result.registrationPreserved = registration.preserved === true;
        if (registration.preserved) registrationError = { code: registration.code || 'MCP_RESET_REGISTRATION_UNVERIFIED' };
      } catch (error) { result.registrationPreserved = true; registrationError = error; }
      // Never remove receipts, outbox, projects, uploads/downloads,
      // private user backups or anything found through a damaged ledger.
      for (const name of identityFiles) await discardFile(resolve(root, '.local', name));
      result.pairingCleared = true;
      if (registrationError) throw registrationError;
      await discardFile(journalPath); result.completed = true;
    } catch (error) {
      result.partialFailure = true; result.code = /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code || '') ? error.code : 'COLLABORATION_RESET_FAILED';
      await writePrivate(journalPath, { version: 1, root, phase: 'retry-required', code: result.code }).catch(() => {});
    }
    return { reset: result };
  });
}
