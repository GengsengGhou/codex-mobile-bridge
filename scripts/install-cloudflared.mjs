import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Pinned official release; no PATH, registry, or Windows service changes.
const version = '2026.9.3';
const expected = 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2';
const directory = new URL('../.local/tools/', import.meta.url);
const target = new URL('cloudflared.exe', directory);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此安装脚本仅支持 Windows x64。');
let existing;
try { existing = await readFile(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing && digest(existing) === expected) console.log(`cloudflared ${version} 已安装并通过校验。`);
else {
  const response = await fetch(`https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-amd64.exe`, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new Error('下载大小超过预期。');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (digest(bytes) !== expected) throw new Error('SHA-256 不匹配，拒绝安装。');
  await mkdir(directory, { recursive: true });
  const temporary = new URL(`cloudflared.${randomUUID()}.tmp`, directory);
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, target); }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  console.log(`已安装 cloudflared ${version}：${fileURLToPath(target)}`);
}
