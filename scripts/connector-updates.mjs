import { readFile, writeFile, mkdir, rename, unlink, lstat, open, realpath } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateFile } from './setup-connector.mjs';

const repository = 'GengsengGhou/codex-mobile-bridge';
const github = `https://github.com/${repository}`;
export const UPDATE_API = `https://api.github.com/repos/${repository}/releases/latest`;
export const UPDATE_INSTALLER = 'CodexMobileConnector-Setup.exe';
const day = 86400000, retryDelay = 3600000;
const flights = new Map();
const execute = promisify(execFile);

export function stableVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match && match.slice(1).every(part => Number.isSafeInteger(Number(part))) ? match.slice(1).join('.') : null;
}
export function compareVersions(left, right) {
  const a = stableVersion(left), b = stableVersion(right);
  if (!a || !b) throw new Error('稳定版本号无效。');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

function assetUrl(tag, name) { return `${github}/releases/download/${encodeURIComponent(tag)}/${name}`; }
function validAssetUrl(value, tag, name) { return value === assetUrl(tag, name); }
function validCdn(value) {
  let url; try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    url.hostname === 'release-assets.githubusercontent.com' && /^\/github-production-release-asset\/[0-9]+\/[a-f0-9-]+$/.test(url.pathname);
}
function timestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null; }
function safeRelease(value) {
  if (!value || !stableVersion(value.tag) || value.version !== stableVersion(value.tag) ||
      !validAssetUrl(value.installerUrl, value.tag, UPDATE_INSTALLER) ||
      !validAssetUrl(value.checksumsUrl, value.tag, 'SHA256SUMS') ||
      (value.digest !== null && !/^[a-f0-9]{64}$/.test(value.digest))) return null;
  return { tag: value.tag, version: value.version, installerUrl: value.installerUrl, checksumsUrl: value.checksumsUrl, digest: value.digest };
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新目录无效。');
  if (process.platform !== 'win32') return;
  const literal = `'${path.replaceAll("'", "''")}'`;
  const script = `$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl(${literal},$acl)`;
  await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10000 });
}

// No Hub address, device credential, executable argument, or caller-selected URL is accepted here.
export function createConnectorUpdater({ root, fetchImpl = fetch, now = Date.now, secureFile = privateFile, secureDirectory = privateDirectory,
  checkTimeoutMs = 15000, downloadTimeoutMs = 180000, maxInstallerBytes = 250 * 1024 * 1024 } = {}) {
  root = resolve(root);
  const local = resolve(root, '.local'), directory = resolve(local, 'updates');
  const statePath = resolve(local, 'connector-updates.json'), prefsPath = resolve(local, 'connector-update-preferences.json');
  const lockPath = resolve(local, 'connector-update.lock');
  const iso = () => new Date(now()).toISOString();
  let prepared = false;
  async function prepare() {
    // Reject junctions/symlinks before changing ACLs or writing an executable.
    await realpath(root);
    for (const path of [local, directory]) {
      try { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('更新目录无效。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (!prepared) await secureDirectory(path);
      if ((await realpath(path)) !== path) throw new Error('更新目录无效。');
    }
    prepared = true;
  }
  async function json(path, missing) {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error(); return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return missing; throw new Error('更新设置无法读取，请重试。'); }
  }
  async function save(path, value) {
    await prepare();
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await secureFile(temporary); await rename(temporary, path); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async function load() {
    const raw = await json(statePath, {}), prefs = await json(prefsPath, { automatic: true });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !prefs || typeof prefs.automatic !== 'boolean') throw new Error('更新设置无效，请重试。');
    const packageValue = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    // Development/prerelease builds must never be replaced by a stable installer automatically.
    const currentVersion = typeof packageValue.version === 'string' ? packageValue.version.slice(0, 80) : 'unknown';
    return { currentVersion, automatic: prefs.automatic, release: safeRelease(raw.release), status: ['idle','checking','current','available','error','downloading','ready'].includes(raw.status) ? raw.status : 'idle',
      lastAttemptAt: timestamp(raw.lastAttemptAt), lastCheckedAt: timestamp(raw.lastCheckedAt), error: typeof raw.error === 'string' ? raw.error.slice(0, 240) : null };
  }
  function publicState(value) {
    const latestVersion = value.release?.version || null;
    const available = !!latestVersion && !!stableVersion(value.currentVersion) && compareVersions(latestVersion, value.currentVersion) > 0;
    let status = value.status;
    if (['current','available','ready'].includes(status) && !available) status = 'current';
    if (['checking','downloading'].includes(status) && now() - Date.parse(value.lastAttemptAt) > downloadTimeoutMs + 60000) status = 'error';
    return { currentVersion: value.currentVersion, latestVersion, available, automatic: value.automatic, status,
      lastAttemptAt: value.lastAttemptAt, lastCheckedAt: value.lastCheckedAt, error: status === 'error' ? value.error || '上次更新操作未完成，请重试。' : null,
      source: 'github', releaseUrl: value.release ? `${github}/releases/tag/${encodeURIComponent(value.release.tag)}` : null };
  }
  async function persist(value) {
    const { release, status, lastAttemptAt, lastCheckedAt, error } = value;
    await save(statePath, { version: 1, release, status, lastAttemptAt, lastCheckedAt, error });
  }
  async function state() { return { update: publicState(await load()) }; }
  async function preferences(automatic) {
    if (typeof automatic !== 'boolean') throw new Error('自动检查更新设置无效。');
    await save(prefsPath, { version: 1, automatic });
    return state();
  }
  async function acquire() {
    await prepare();
    for (let attempt = 0; attempt < 2; attempt++) {
      try { const file = await open(lockPath, 'wx', 0o600); try { await file.writeFile(JSON.stringify({ pid: process.pid, id: randomUUID() })); await secureFile(lockPath); } catch (error) { await file.close(); await unlink(lockPath).catch(() => {}); throw error; } finally { await file.close().catch(() => {}); } return true; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const lock = await json(lockPath, null);
        if (!Number.isSafeInteger(lock?.pid) || lock.pid < 1) return false;
        let alive = true; try { process.kill(lock.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; }
        if (alive) return false;
        await unlink(lockPath).catch(() => {});
      }
    }
    return false;
  }
  async function run(kind, operation) {
    const key = `${root}:${kind}`;
    if (flights.has(key)) return flights.get(key);
    const promise = (async () => {
      if (!await acquire()) { if (kind === 'check') return state(); throw new Error('已有更新操作正在进行，请稍后重试。'); }
      try { return await operation(); } finally { await unlink(lockPath).catch(() => {}); }
    })();
    flights.set(key, promise);
    try { return await promise; } finally { if (flights.get(key) === promise) flights.delete(key); }
  }
  async function request(url, signal, accept, tag, name) {
    for (let redirects = 0; redirects <= 4; redirects++) {
      const response = await fetchImpl(url, { signal, redirect: 'manual', headers: { Accept: accept, 'User-Agent': 'CodexMobileConnector-Updater' } });
      if (response.url && response.url !== url) throw new Error('更新下载跳转无效。');
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        const next = location && new URL(location, url).href;
        if (!next || !(validAssetUrl(next, tag, name) || validCdn(next))) throw new Error('更新下载跳转无效。');
        await response.body?.cancel().catch(() => {}); url = next; continue;
      }
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 更新服务暂时限制访问，请稍后重试。' : `更新服务请求失败（HTTP ${response.status}），请重试。`); }
      return response;
    }
    throw new Error('更新下载跳转过多，请重试。');
  }
  async function bytes(response, limit) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => {}); throw new Error('更新响应过大。'); }
    const chunks = []; let total = 0;
    if (!response.body) throw new Error('更新响应为空。');
    for await (const chunk of response.body) { total += chunk.length; if (total > limit) throw new Error('更新响应过大。'); chunks.push(Buffer.from(chunk)); }
    return Buffer.concat(chunks);
  }
  async function checksum(release, signal) {
    if (release.digest) return release.digest;
    const response = await request(release.checksumsUrl, signal, 'application/octet-stream', release.tag, 'SHA256SUMS');
    const contents = (await bytes(response, 16384)).toString('utf8');
    const matches = contents.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *]CodexMobileConnector-Setup\.exe$/.exec(line)).filter(Boolean);
    if (matches.length !== 1) throw new Error('官方安装包校验信息无效，请重试。');
    return matches[0][1].toLowerCase();
  }
  async function metadata(signal) {
    const response = await fetchImpl(UPDATE_API, { signal, redirect: 'manual', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'CodexMobileConnector-Updater' } });
    if (response.url && response.url !== UPDATE_API) throw new Error('更新服务地址无效。');
    if (response.status === 403 || response.status === 429) {
      await response.body?.cancel().catch(() => {});
      // GitHub's own stable-latest redirect is an anonymous fallback; no HTML or executable links are scraped.
      const redirect = await fetchImpl(`${github}/releases/latest`, { signal, redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'CodexMobileConnector-Updater' } });
      const location = redirect.headers.get('location');
      const target = location && new URL(location, github).href;
      const prefix = `${github}/releases/tag/`;
      await redirect.body?.cancel().catch(() => {});
      if (![301,302,303,307,308].includes(redirect.status) || !target?.startsWith(prefix)) throw new Error('GitHub 更新服务暂时限制访问，请稍后重试。');
      const tag = target.slice(prefix.length);
      if (!stableVersion(tag) || target !== prefix + encodeURIComponent(tag)) throw new Error('官方稳定版本信息无效。');
      const release = { tag, version: stableVersion(tag), installerUrl: assetUrl(tag, UPDATE_INSTALLER), checksumsUrl: assetUrl(tag, 'SHA256SUMS'), digest: null };
      release.digest = await checksum(release, signal);
      return release;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(`更新服务请求失败（HTTP ${response.status}），请重试。`); }
    let value; try { value = JSON.parse((await bytes(response, 1024 * 1024)).toString('utf8')); } catch { throw new Error('官方版本信息无效。'); }
    const tag = value.tag_name, version = stableVersion(tag);
    if (!version || value.draft !== false || value.prerelease !== false || !timestamp(value.published_at) || Date.parse(value.published_at) > now() + 60000) throw new Error('官方稳定版本信息无效。');
    if (!Array.isArray(value.assets)) throw new Error('官方安装包信息无效。');
    const installers = value.assets.filter(asset => asset.name === UPDATE_INSTALLER);
    const sums = value.assets.filter(asset => asset.name === 'SHA256SUMS');
    if (installers.length !== 1 || !validAssetUrl(installers[0].browser_download_url, tag, UPDATE_INSTALLER) ||
        !Number.isSafeInteger(installers[0].size) || installers[0].size <= 0 || installers[0].size > maxInstallerBytes) throw new Error('官方安装包信息无效。');
    const digest = /^sha256:([a-f0-9]{64})$/i.exec(installers[0].digest || '')?.[1].toLowerCase() || null;
    if (!digest && (sums.length !== 1 || !validAssetUrl(sums[0].browser_download_url, tag, 'SHA256SUMS'))) throw new Error('官方安装包缺少 SHA256 校验信息。');
    return { tag, version, installerUrl: assetUrl(tag, UPDATE_INSTALLER), checksumsUrl: assetUrl(tag, 'SHA256SUMS'), digest };
  }
  function friendly(error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return '更新请求已取消或超时，请重试。';
    // Never echo provider bodies, URL query strings, tokens, or filesystem errors to the UI.
    return /^([官方更新上已有]|GitHub)/.test(error?.message || '') ? error.message.slice(0, 240) : '无法连接官方更新服务，请检查网络后重试。';
  }
  async function refresh(value, signal) {
    value = { ...value, status: 'checking', lastAttemptAt: iso(), error: null };
    await persist(value);
    try { value.release = await metadata(signal); value.lastCheckedAt = iso(); value.status = stableVersion(value.currentVersion) && compareVersions(value.release.version, value.currentVersion) > 0 ? 'available' : 'current'; }
    catch (error) { value.status = 'error'; value.error = friendly(error); }
    await persist(value); return value;
  }
  async function check({ manual = true, signal } = {}) {
    if (typeof manual !== 'boolean') throw new Error('更新检查请求无效。');
    return run('check', async () => {
      let value = await load();
      const interval = value.status === 'error' ? retryDelay : day;
      const age = now() - Date.parse(value.lastAttemptAt);
      if (!manual && (!value.automatic || Number.isFinite(age) && age >= 0 && age < interval)) return { update: publicState(value) };
      value = await refresh(value, signal ? AbortSignal.any([signal, AbortSignal.timeout(checkTimeoutMs)]) : AbortSignal.timeout(checkTimeoutMs));
      value.automatic = (await load()).automatic;
      return { update: publicState(value) };
    });
  }
  async function download({ signal } = {}) {
    return run('download', async () => {
      let value = await load();
      const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(downloadTimeoutMs)]) : AbortSignal.timeout(downloadTimeoutMs);
      // Revalidate stable release metadata on every user-requested upgrade, including cached downloads.
      value = await refresh(value, AbortSignal.any([combined, AbortSignal.timeout(checkTimeoutMs)]));
      if (value.status === 'error') return { update: publicState(value) };
      if (!publicState(value).available) throw new Error('当前没有可安装的稳定更新。');
      const release = value.release;
      const final = resolve(directory, `CodexMobileConnector-Setup-v${release.version}.exe`);
      const temporary = resolve(directory, `${basename(final)}.${randomUUID()}.part`);
      let file;
      try {
        value.status = 'downloading'; await persist(value);
        const digest = await checksum(release, combined);
        const response = await request(release.installerUrl, combined, 'application/octet-stream', release.tag, UPDATE_INSTALLER);
        const size = Number(response.headers.get('content-length'));
        if (Number.isFinite(size) && size > maxInstallerBytes) { await response.body?.cancel().catch(() => {}); throw new Error('更新安装包过大。'); }
        file = await open(temporary, 'wx', 0o600); await secureFile(temporary);
        const hash = createHash('sha256'); let total = 0, first = Buffer.alloc(0);
        if (!response.body) throw new Error('更新安装包为空。');
        for await (const chunk of response.body) {
          if (combined.aborted) throw combined.reason;
          total += chunk.length; if (total > maxInstallerBytes) throw new Error('更新安装包过大。');
          if (first.length < 2) first = Buffer.concat([first, Buffer.from(chunk)]).subarray(0, 2);
          hash.update(chunk); await file.writeFile(chunk);
        }
        combined.throwIfAborted();
        if (!total || first.toString('ascii') !== 'MZ' || (Number.isFinite(size) && size > 0 && total !== size) || hash.digest('hex') !== digest) throw new Error('官方安装包 SHA256 校验失败，请重试。');
        await file.sync(); await file.close(); file = null;
        await rename(temporary, final);
        value.status = 'ready'; value.error = null; await persist(value); value.automatic = (await load()).automatic;
        return { update: publicState(value), installerVerified: true, installerPath: final, installerVersion: release.version, installerSha256: digest };
      } catch (error) { value.status = 'error'; value.error = friendly(error); await persist(value); return { update: publicState(value) }; }
      finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    });
  }
  return { state, preferences, check, download };
}
