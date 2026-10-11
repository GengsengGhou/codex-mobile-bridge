import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPrivate, writePrivate } from './collaboration-common.mjs';
import { registerCollaboration } from './collaboration-registration.mjs';

export async function disableCollaborationForUninstall({ root, register = registerCollaboration } = {}) {
  const policyPath = resolve(root, '.local/computer-collaboration.json');
  const policy = await readPrivate(policyPath);
  if (policy) await writePrivate(policyPath, { ...policy, controlEnabled: false, receiveEnabled: false });
  const ledger = await readPrivate(resolve(root, '.local/collaboration-registration.json'));
  // A foreign same-name entry with no ownership ledger belongs to the user and is left alone.
  if (ledger) await register({ root, enabled: false, codexHome: dirname(ledger.configPath) });
  return { disabled: true, ownedRegistrationRemoved: !!ledger };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { if (!process.argv.includes('--uninstall')) throw new Error('Unsupported lifecycle operation'); console.log(JSON.stringify({ ok: true, ...await disableCollaborationForUninstall({ root: fileURLToPath(new URL('..', import.meta.url)) }) })); }
  catch (error) { console.log(JSON.stringify({ ok: false, code: error.code || 'COLLABORATION_CLEANUP_FAILED', error: error.message })); process.exitCode = 1; }
}
