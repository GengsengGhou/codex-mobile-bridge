import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import TOML from '@iarna/toml';
import { fileURLToPath } from 'node:url';
import { installCollaborationLauncher, removeCollaborationLauncher, readCollaborationLaunch } from './collaboration-launcher.mjs';
import { registerCollaboration, collaborationServerName } from './collaboration-registration.mjs';
import { readPrivate, writePrivate, fail } from './collaboration-common.mjs';

export async function prepareCollaborationCompatibility({ root, codexHome = process.env.CODEX_HOME || resolve(homedir(), '.codex') } = {}) {
  await installCollaborationLauncher({ root });
  const ledger = await readPrivate(resolve(root, '.local/collaboration-registration.json'));
  // Existing launch ownership is the prerequisite. Never create authorization
  // or a new Codex registration merely because an installer was run.
  if (!ledger) return { prepared: true, registrationUpdated: false };
  const configPath = resolve(codexHome, 'config.toml');
  if (ledger.configPath !== configPath) fail('MCP_REGISTRATION_RECOVERY_REQUIRED', 409, '协作配置目录需要核对。已保留 Codex 设置，请使用原配置目录重试修复安装。');
  let current; try { current = TOML.parse(await readFile(configPath, 'utf8')).mcp_servers?.[collaborationServerName]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!current) return { prepared: true, registrationUpdated: false, registrationRemoved: true };
  const result = await registerCollaboration({ root, codexHome, enabled: true, upgradeLaunch: true });
  await writePrivate(resolve(root, '.local/collaboration-registration-state.json'), { ...result, restartCodexRequired: true, message: '协作连接已修复。请完全退出并重新打开 Codex，配对和授权已保留。' });
  return { prepared: true, registrationUpdated: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const args = process.argv.slice(2), mode = args.length === 3 ? args.shift() : 'prepare'; if (args.length !== 2 || args[0] !== '--install-root' || !['prepare', '--remove-launcher', '--launch-info'].includes(mode)) throw new Error('Invalid arguments'); console.log(JSON.stringify(mode === '--remove-launcher' ? await removeCollaborationLauncher(args[1]) : mode === '--launch-info' ? await readCollaborationLaunch(args[1]) : await prepareCollaborationCompatibility({ root: args[1] }))); }
  catch (error) { console.error(JSON.stringify({ code: error.code || 'COLLABORATION_REPAIR_REQUIRED', message: '协作连接未完成修复。配对和授权已保留，请重试修复安装。' })); process.exitCode = 1; }
}
