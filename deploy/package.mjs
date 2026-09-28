import { mkdir, readFile, writeFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
async function checkReleaseInput(relative) {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (path === 'docs/verification') continue;
    if (entry.isSymbolicLink() || /(?:^|\/)(?:\.local|work|data|mobile-uploads|coverage|\.cache)(?:\/|$)/.test(path) || (entry.name !== '.env.example' && /^\.env(?:\.|$)/.test(entry.name)) || /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|pfx|p12|log|tmp)$/i.test(entry.name)) throw new Error(`Private or local-only release input rejected: ${path}`);
    if (entry.isDirectory()) await checkReleaseInput(path);
  }
}
for (const directory of ['hub', 'public', 'src', 'scripts', 'deploy', 'docs']) await checkReleaseInput(directory);
await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const file = 'dist/codex-device-hub.tar.gz';
const result = spawnSync('tar', ['--exclude=.env', '--exclude=*.sqlite*', '--exclude=*.tmp', '--exclude=docs/verification', '-czf', file, 'package.json', 'package-lock.json', 'README.md', 'hub', 'public', 'src', 'scripts', 'deploy', 'node_modules/ws', 'docs'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Packaging failed; a compatible tar executable is required.');
const digest = createHash('sha256').update(await readFile(new URL('../' + file, import.meta.url))).digest('hex');
let sums = `${digest}  codex-device-hub.tar.gz\n`;
if (process.platform === 'win32') {
  const staging = await mkdtemp(join(tmpdir(), 'codex-hub-release-'));
  try {
    if (spawnSync('tar', ['-xzf', join(root, file), '-C', staging], { stdio: 'inherit' }).status !== 0) throw new Error('Release extraction failed.');
    const zip = join(root, 'dist/codex-mobile-connector-windows.zip');
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath ${literal(zip)}) { Remove-Item -LiteralPath ${literal(zip)} }; [IO.Compression.ZipFile]::CreateFromDirectory(${literal(staging)},${literal(zip)})`;
    if (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'inherit' }).status !== 0) throw new Error('Windows ZIP packaging failed.');
    sums += `${createHash('sha256').update(await readFile(zip)).digest('hex')}  codex-mobile-connector-windows.zip\n`;
    const build = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'deploy/build-windows-installer.ps1')], { windowsHide: true, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Windows EXE installer packaging failed.');
    const exe = join(root, 'dist/CodexMobileConnector-Setup.exe');
    sums += `${createHash('sha256').update(await readFile(exe)).digest('hex')}  CodexMobileConnector-Setup.exe\n`;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
await writeFile(new URL('../dist/SHA256SUMS', import.meta.url), sums);
console.log(`Release bundle ready: ${file}; checksum in dist/SHA256SUMS. No live credentials or databases are included.`);
