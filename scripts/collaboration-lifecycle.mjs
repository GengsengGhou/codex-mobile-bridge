import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivate, writePrivate } from './collaboration-common.mjs';
import { registerCollaboration } from './collaboration-registration.mjs';

export async function disableCollaborationForUninstall({ root, register = registerCollaboration } = {}) {
  const policyPath = resolve(root, '.local/computer-collaboration.json');
  const policy = await readPrivate(policyPath);
  if (policy) await writePrivate(policyPath, { ...policy, controlEnabled: false, receiveEnabled: false, controlPending: false, requiresAuthorization: false });
  const ledger = await readPrivate(resolve(root, '.local/collaboration-registration.json'));
  // A foreign same-name entry with no ownership ledger belongs to the user and is left alone.
  if (ledger) {
    try { await register({ root, enabled: false, codexHome: dirname(ledger.configPath) }); }
    catch (error) {
      // Only a verified ownership ledger with a changed/foreign entry can take
      // this path. Unsafe files, broken ledgers, interrupted writes and locks
      // must still stop uninstall. Process ownership/stop is checked by the helper.
      if (error.code !== 'MCP_REGISTRATION_CONFLICT') throw error;
      return { disabled: true, ownedRegistrationRemoved: false, configurationPreserved: true, warning: '电脑协作已关闭。Codex 中同名连接已被修改，已完整保留，未自动删除。卸载完成后请在 Codex 设置中检查该连接；如仍指向已卸载应用，请手动移除。 / Computer collaboration is disabled. The changed same-name Codex connection was preserved. After uninstall, check this connection in Codex settings and remove it manually if it still points to the removed app.' };
    }
  }
  return { disabled: true, ownedRegistrationRemoved: !!ledger };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!process.argv.includes('--uninstall')) throw new Error('Unsupported lifecycle operation'); console.log(JSON.stringify({ ok: true, ...await disableCollaborationForUninstall({ root: fileURLToPath(new URL('..', import.meta.url)) }) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, code: error.code || 'COLLABORATION_CLEANUP_FAILED', error: error.message })); process.exitCode = 1; }
}
