import { readdir, lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backupScopes = [
  { directory: '/opt/codex-mobile-hub/backups', pattern: /^release-\d{8}(?:T\d{6}Z|-\d{6})(?:-\d+)?$/, directories: true },
  { directory: '/opt/codex-mobile-hub', pattern: /^app-backup-\d{8}T\d{6}Z(?:-\d+)?$/, directories: true },
  { directory: '/etc/caddy', pattern: /^Caddyfile\.codexhub-backup-\d{8}T\d{6}Z$/, directories: false },
];

export async function pruneBackups(scope, { keep = 3 } = {}) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new Error('Keep at least one rollback backup.');
  const directory = resolve(scope.directory);
  let entries;
  try {
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Backup directory must resolve to its exact configured path.');
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const candidates = [];
  for (const entry of entries) {
    if (!scope.pattern.test(entry.name) || entry.isSymbolicLink() || (scope.directories ? !entry.isDirectory() : !entry.isFile())) continue;
    const path = join(directory, entry.name), stat = await lstat(path);
    if (stat.isSymbolicLink() || await realpath(path) !== path) throw new Error('Unsafe backup path.');
    candidates.push({ path, mtime: stat.mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime || b.path.localeCompare(a.path));
  const removed = [];
  for (const candidate of candidates.slice(keep)) {
    // Recheck after listing. Recursive removal does not follow child symlinks.
    if ((await lstat(candidate.path)).isSymbolicLink() || await realpath(candidate.path) !== candidate.path) throw new Error('Backup path changed during maintenance.');
    await rm(candidate.path, { recursive: scope.directories, force: false }); removed.push(candidate.path);
  }
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const scope of backupScopes) await pruneBackups(scope);
}
