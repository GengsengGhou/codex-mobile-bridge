import { mkdir, readFile, writeFile, mkdtemp, rm, readdir, lstat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
const root = fileURLToPath(new URL('..', import.meta.url));
const { values } = parseArgs({ options: { 'runtime-executable': { type: 'string' }, 'webview-package': { type: 'string' }, 'output-directory': { type: 'string' }, 'hub-only': { type: 'boolean', default: false } } });
const output = resolve(root, values['output-directory'] || 'dist');
const releaseExcludes = JSON.parse(await readFile(join(root, 'deploy/release-excludes.json'), 'utf8'));
async function checkReleaseInput(relative) {
  if ((await lstat(join(root, relative))).isSymbolicLink()) throw new Error(`Private or local-only release input rejected: ${relative}`);
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const path = `${relative}/${entry.name}`;
    if (path === 'docs/verification') continue;
    if (entry.isSymbolicLink() || /(?:^|\/)(?:\.local|work|data|mobile-uploads|coverage|\.cache)(?:\/|$)/.test(path) || (entry.name !== '.env.example' && /^\.env(?:\.|$)/.test(entry.name)) || /\.(?:sqlite(?:-.*)?|db(?:-.*)?|pem|key|pfx|p12|log|tmp)$/i.test(entry.name)) throw new Error(`Private or local-only release input rejected: ${path}`);
    if (entry.isDirectory()) await checkReleaseInput(path);
  }
}
for (const directory of ['hub', 'public', 'src', 'scripts', 'deploy', 'docs']) await checkReleaseInput(directory);
await mkdir(output, { recursive: true });
const file = join(output, 'codex-device-hub.tar.gz');
const runtimeDependencies = ['node_modules/ws', 'node_modules/@iarna/toml'];
for (const dependency of runtimeDependencies) await checkReleaseInput(dependency);
const result = spawnSync('tar', ['--exclude=.env', '--exclude=*.sqlite*', '--exclude=*.tmp', '--exclude=docs/verification', ...releaseExcludes.map(pattern => `--exclude=${pattern}`), '-czf', file, 'package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'hub', 'public', 'src', 'scripts', 'deploy', ...runtimeDependencies, 'docs'], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Packaging failed; a compatible tar executable is required.');
const digest = createHash('sha256').update(await readFile(file)).digest('hex');
let sums = `${digest}  codex-device-hub.tar.gz\n`;
if (process.platform === 'win32' && !values['hub-only']) {
  const staging = await mkdtemp(join(tmpdir(), 'codex-hub-release-'));
  try {
    if (spawnSync('tar', ['-xzf', file, '-C', staging], { stdio: 'inherit' }).status !== 0) throw new Error('Release extraction failed.');
    const zip = join(output, 'codex-mobile-connector-windows.zip');
    const literal = value => `'${value.replaceAll("'", "''")}'`;
    const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem; if (Test-Path -LiteralPath ${literal(zip)}) { Remove-Item -LiteralPath ${literal(zip)} }; [IO.Compression.ZipFile]::CreateFromDirectory(${literal(staging)},${literal(zip)})`;
    if (spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'inherit' }).status !== 0) throw new Error('Windows ZIP packaging failed.');
    sums += `${createHash('sha256').update(await readFile(zip)).digest('hex')}  codex-mobile-connector-windows.zip\n`;
    const buildArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'deploy/build-windows-installer.ps1'), '-OutputDirectory', output];
    if (values['runtime-executable']) buildArgs.push('-RuntimeExecutable', values['runtime-executable']);
    if (values['webview-package']) buildArgs.push('-WebViewPackage', values['webview-package']);
    const build = spawnSync('powershell.exe', buildArgs, { windowsHide: true, stdio: 'inherit' });
    if (build.status !== 0) throw new Error('Windows EXE installer packaging failed.');
    const exe = join(output, 'CodexMobileConnector-Setup.exe');
    sums += `${createHash('sha256').update(await readFile(exe)).digest('hex')}  CodexMobileConnector-Setup.exe\n`;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
await writeFile(join(output, 'SHA256SUMS'), sums);
console.log(`Release bundle ready: ${file}; checksum in ${join(output, 'SHA256SUMS')}. No live credentials or databases are included.`);
