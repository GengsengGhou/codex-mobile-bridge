import { lstat, stat as fileStat, realpath, opendir, open } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BridgeError } from './desktop.mjs';

const MiB = 1024 * 1024;
const denied = /^(?:\..*|node_modules|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const textExtensions = new Set('txt md markdown json jsonl csv tsv log js mjs cjs ts tsx jsx css html htm svg xml yaml yml toml ini cfg py r sh ps1 bat tex bib sql gitignore'.split(' '));
const images = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const fail = (message, code = 'FILE_FORBIDDEN', status = 403) => { throw new BridgeError(message, code, status); };
const deniedSegment = segment => denied.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment) || /^(?:\$recycle\.bin|system volume information)$/i.test(segment);
const within = (root, candidate) => { const relative = path.relative(root, candidate); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
function kind(name) {
  const ext = path.extname(name).toLowerCase();
  return images[ext] ? 'image' : ext === '.pdf' ? 'pdf' : textExtensions.has(ext.slice(1)) || !ext ? 'text' : null;
}
function metadata(target, stat) {
  return { name: path.basename(target.absolute), path: target.relative, size: stat.size, modifiedAt: stat.mtime.toISOString(), previewKind: stat.isFile() ? kind(target.absolute) : null };
}
async function targetFor(bridge, id, input = '') {
  const { thread } = await bridge.read(id, undefined, { turnLimit: 1 });
  if (thread?.id !== id || thread.kind !== 'codex' || (thread.hostId && thread.hostId !== 'local') || typeof thread.cwd !== 'string' || !path.isAbsolute(thread.cwd)) fail('此会话没有可访问的本机工作目录', 'FILES_UNAVAILABLE');
  const root = path.resolve(thread.cwd);
  if (root === path.parse(root).root || /^\\\\/.test(root)) fail('工作目录不允许访问', 'FILES_UNAVAILABLE');
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f]/.test(input)) fail('文件路径无效', 'INVALID_REQUEST', 400);
  input = input.replace(/:\d+(?::\d+)?$/, '');
  if (/^(?:\\\\|\/\/)/.test(input) || input.includes(':') && !/^[a-z]:[\\/][^:]*$/i.test(input) || /(^|[\\/])\.\.([\\/]|$)/.test(input)) fail('文件路径不允许访问');
  const absolute = path.resolve(root, input || '.');
  if (!within(root, absolute)) fail('文件路径超出工作目录');
  const relative = path.relative(root, absolute);
  if (relative.split(path.sep).some(deniedSegment)) fail('此文件不允许访问');
  try {
    if ((await lstat(root)).isSymbolicLink()) fail('链接工作目录不允许访问', 'FILES_UNAVAILABLE');
    const rootReal = await realpath(root);
    let current = root;
    // Reject every link below the trusted workspace, including Windows junctions.
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) fail('链接文件不允许访问');
    }
    const canonical = await realpath(absolute);
    if (!within(rootReal, canonical)) fail('文件路径超出工作目录');
    if (path.relative(rootReal, canonical).split(path.sep).some(deniedSegment)) fail('此文件不允许访问');
    return { absolute, canonical, relative: relative.split(path.sep).join('/'), rootReal, stat: await lstat(absolute) };
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('文件不存在', 'FILE_NOT_FOUND', 404);
    fail('文件无法访问');
  }
}
export async function listThreadFiles(bridge, id, input) {
  const target = await targetFor(bridge, id, input);
  if (!target.stat.isDirectory()) fail('路径不是目录', 'INVALID_REQUEST', 400);
  const entries = [];
  let scanned = 0, scanTruncated = false;
  const directory = await opendir(target.absolute);
  // Bound filesystem work even when a folder contains only excluded entries.
  for await (const item of directory) {
    if (++scanned > 1500) { scanTruncated = true; break; }
    if (deniedSegment(item.name) || item.isSymbolicLink() || (!item.isFile() && !item.isDirectory())) continue;
    try {
      const absolute = path.join(target.absolute, item.name), stat = await lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      const relative = path.posix.join(target.relative, item.name);
      entries.push({ ...metadata({ absolute, relative }, stat), type: stat.isDirectory() ? 'directory' : 'file' });
    } catch { /* Files may disappear while the directory is being listed. */ }
  }
  entries.sort((a, b) => (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { path: target.relative, parentPath: target.relative ? path.posix.dirname(target.relative) === '.' ? '' : path.posix.dirname(target.relative) : null, entries: entries.slice(0, 300), truncated: scanTruncated || entries.length > 300 };
}
export async function serveThreadFile(bridge, id, input, mode, req, res) {
  if (!input || !['info', 'preview', 'download'].includes(mode)) fail('文件请求无效', 'INVALID_REQUEST', 400);
  const target = await targetFor(bridge, id, input);
  if (!target.stat.isFile()) fail('路径不是文件', 'INVALID_REQUEST', 400);
  const info = metadata(target, target.stat);
  if (mode === 'info') return info;
  const limit = mode === 'download' ? 100 * MiB : { text: MiB, image: 20 * MiB, pdf: 30 * MiB }[info.previewKind];
  if (!limit) fail('此文件不支持预览', 'PREVIEW_UNSUPPORTED', 415);
  if (info.size > limit) fail('文件超过读取大小限制', 'FILE_TOO_LARGE', 413);
  const handle = await open(target.canonical, 'r');
  try {
    const stat = await handle.stat();
    const current = await targetFor(bridge, id, input);
    const currentStat = await fileStat(current.canonical);
    // Windows path stats report dev=0 while descriptor stats report the volume ID.
    if (!stat.isFile() || (process.platform !== 'win32' && stat.dev !== currentStat.dev) || stat.ino !== currentStat.ino || stat.size > limit) fail('文件已改变，请刷新', 'FILE_CHANGED', 409);
    const mime = mode === 'download' ? 'application/octet-stream' : info.previewKind === 'text' ? 'text/plain; charset=utf-8' : info.previewKind === 'pdf' ? 'application/pdf' : images[path.extname(info.name).toLowerCase()];
    const fallback = info.name.replace(/[^a-zA-Z0-9._-]/g, '_');
    const encoded = encodeURIComponent(info.name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${mode === 'download' ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    if (!stat.size) { res.end(); return null; }
    const stream = handle.createReadStream({ autoClose: false, end: stat.size - 1 });
    await pipeline(stream, res);
    return null;
  } finally { await handle.close(); }
}
