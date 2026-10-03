import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createConnectorUpdater, stableVersion, compareVersions, UPDATE_API, UPDATE_INSTALLER } from '../scripts/connector-updates.mjs';

const github = 'https://github.com/GengsengGhou/codex-mobile-bridge';
const instant = Date.parse('2026-10-03T00:00:00Z');
const installer = Buffer.from('MZsynthetic-installer-not-executable');
const sha = createHash('sha256').update(installer).digest('hex');
function release(tag = 'v1.1.0', extra = {}) {
  return { tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-02T00:00:00Z',
    assets: [{ name: UPDATE_INSTALLER, size: installer.length, digest: `sha256:${sha}`, browser_download_url: `${github}/releases/download/${tag}/${UPDATE_INSTALLER}` },
      { name: 'SHA256SUMS', browser_download_url: `${github}/releases/download/${tag}/SHA256SUMS` }], ...extra };
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'connector-updates-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: options.version || '1.0.0' }));
  let clock = instant, calls = [];
  const defaultFetch = async (url, init) => { calls.push({ url, init }); return url === UPDATE_API ? Response.json(release()) : new Response(installer); };
  const settings = { root, now: () => clock, fetchImpl: defaultFetch,
    secureFile: async () => {}, secureDirectory: path => mkdir(path, { recursive: true, mode: 0o700 }), ...options };
  const updater = createConnectorUpdater(settings);
  return { root, updater, calls, settings, setClock: value => { clock = value; } };
}

test('stable semver comparison accepts exact published tags and excludes development identifiers', () => {
  assert.equal(stableVersion('v1.2.10'), '1.2.10'); assert.equal(compareVersions('1.2.10','1.2.9'),1);
  assert.equal(compareVersions('v1.0.0','1.0.0'),0); assert.equal(compareVersions('1.0.0','2.0.0'),-1);
  for (const version of ['1.0','01.0.0','v1.0.0-beta.1','1.0.0+dev','main','v1.0.0/path','1.0.9007199254740992']) assert.equal(stableVersion(version), null);
});

test('checks are anonymous official requests and persist independent of pairing and startup preferences', async t => {
  const f = await fixture(t);
  await mkdir(join(f.root, '.local'));
  const original = JSON.stringify({ hubOrigin:'https://private-hub.invalid', deviceToken:'fixture-private-token', language:'en', paused:true, autoStart:false });
  await writeFile(join(f.root,'.local/hub-connector.json'), original);
  const result = await f.updater.check({ manual:false });
  assert.equal(result.update.currentVersion,'1.0.0'); assert.equal(result.update.latestVersion,'1.1.0');
  assert.equal(result.update.available,true); assert.equal(result.update.status,'available'); assert.equal(result.update.automatic,true);
  assert.equal(result.update.lastCheckedAt,new Date(instant).toISOString());
  assert.equal(await readFile(join(f.root,'.local/hub-connector.json'),'utf8'),original);
  assert.equal(f.calls.length,1); assert.equal(f.calls[0].url,UPDATE_API);
  assert.equal(f.calls[0].init.redirect,'manual'); assert.equal('Authorization' in f.calls[0].init.headers,false);
  assert.doesNotMatch(JSON.stringify(result),/fixture-private-token|private-hub/);
  const restarted = createConnectorUpdater(f.settings);
  assert.deepEqual(await restarted.state(),result);
});

test('automatic checks respect persisted switch and daily attempt schedule; manual checks bypass both', async t => {
  const f = await fixture(t);
  await f.updater.preferences(false); await f.updater.check({manual:false}); assert.equal(f.calls.length,0);
  await f.updater.check(); assert.equal(f.calls.length,1);
  await f.updater.preferences(true); await f.updater.check({manual:false}); assert.equal(f.calls.length,1);
  f.setClock(instant+86400000); await f.updater.check({manual:false}); assert.equal(f.calls.length,2);
  await assert.rejects(f.updater.preferences('true'),/设置无效/);
});

test('network failures retain successful evidence, report error and use one-hour automatic backoff', async t => {
  let failing = false, requests = 0;
  const f = await fixture(t,{fetchImpl:async()=>{requests++;if(failing)throw Error('secret-query-url-token');return Response.json(release());}});
  await f.updater.check(); failing=true;
  let result = await f.updater.check();
  assert.equal(result.update.status,'error'); assert.equal(result.update.latestVersion,'1.1.0'); assert.ok(result.update.error);
  assert.doesNotMatch(JSON.stringify(result),/secret-query/);
  await f.updater.check({manual:false}); assert.equal(requests,2);
  f.setClock(instant+3600000); await f.updater.check({manual:false}); assert.equal(requests,3);
  await f.updater.check(); assert.equal(requests,4);
});

test('rate-limit fallback uses stable official latest redirect and same-tag full checksum only', async t => {
  const urls=[];
  const f=await fixture(t,{fetchImpl:async url=>{
    urls.push(url);
    if(url===UPDATE_API)return new Response('',{status:403});
    if(url===`${github}/releases/latest`)return new Response(null,{status:302,headers:{location:`${github}/releases/tag/v1.1.0`}});
    if(url===`${github}/releases/download/v1.1.0/SHA256SUMS`)return new Response(`${sha}  ${UPDATE_INSTALLER}\n`);
    throw Error('unexpected');
  }});
  const result=await f.updater.check(); assert.equal(result.update.status,'available');assert.equal(result.update.latestVersion,'1.1.0');assert.equal(urls.length,3);
});

test('rate-limit without verifiable fallback stays an error, including redirected foreign repositories', async t => {
  for(const location of [null,`${github}/releases/tag/v1.1.0-beta.1`,'https://github.com/attacker/repo/releases/tag/v9.0.0',`${github}/releases/tag/v1.1.0?token=secret`]){
    const f=await fixture(t,{fetchImpl:async url=>url===UPDATE_API?new Response('',{status:429}):new Response(null,{status:location?302:403,headers:location?{location}:{}})});
    const result=await f.updater.check();assert.equal(result.update.status,'error');assert.equal(result.update.latestVersion,null);assert.equal(result.update.available,false);
    assert.doesNotMatch(JSON.stringify(result),/token=secret|attacker/);
  }
});

test('malformed, draft, prerelease, future and unofficial metadata cannot authorize an installer', async t => {
  const variants = [release('v2.0.0',{draft:true}),release('v2.0.0',{prerelease:true}),release('v2.0.0-beta'),release('v2.0.0',{published_at:null}),release('v2.0.0',{published_at:'2099-01-01T00:00:00Z'}),
    release('v2.0.0',{assets:[{name:UPDATE_INSTALLER,size:3,digest:`sha256:${sha}`,browser_download_url:'https://evil.invalid/setup.exe'}]})];
  for(const metadata of variants){const f=await fixture(t,{fetchImpl:async()=>Response.json(metadata)});const result=await f.updater.download();assert.equal(result.update.status,'error');assert.equal(result.installerVerified,undefined);}
});

test('no downgrade, equal-version upgrade or development-build replacement is offered', async t => {
  for(const version of ['1.1.0','2.0.0','1.0.0-dev','1.0.0+local']){
    const f=await fixture(t,{version});const result=await f.updater.check();assert.equal(result.update.available,false);assert.equal(result.update.status,'current');
    await assert.rejects(f.updater.download(),/没有可安装/);
  }
});

test('in-flight checks deduplicate across updater objects and preserve preference changes during network wait', async t => {
  let releaseFetch, startedResolve, requests=0;
  const started=new Promise(r=>{startedResolve=r;});
  const f=await fixture(t,{fetchImpl:async()=>{requests++;startedResolve();await new Promise(r=>{releaseFetch=r;});return Response.json(release());}});
  const first=f.updater.check(); await started;
  const second=createConnectorUpdater(f.settings).check();
  await f.updater.preferences(false);releaseFetch();
  const [one,two]=await Promise.all([first,second]); assert.equal(requests,1);assert.deepEqual(one,two);assert.equal(one.update.automatic,false);
});

test('another live process operation lock suppresses duplicate automatic check', async t => {
  const f=await fixture(t);await mkdir(join(f.root,'.local'));await writeFile(join(f.root,'.local/connector-update.lock'),JSON.stringify({pid:process.pid}));
  const result=await f.updater.check({manual:false});assert.equal(result.update.status,'idle');assert.equal(f.calls.length,0);
  await assert.rejects(f.updater.download(),/已有更新操作/);
});

test('timeouts and cancellation report retryable errors and do not leave operation locks', async t => {
  let expiredAtFetch=false;
  const f=await fixture(t,{checkTimeoutMs:20,
    // Under full-suite load the timeout can expire while the attempt is persisted.
    // Make that ordering deterministic; fetch must reject an already-aborted signal.
    secureFile:async path=>{if(path.includes('connector-updates.json'))await new Promise(resolve=>setTimeout(resolve,60));},
    fetchImpl:async(url,{signal})=>{
      expiredAtFetch=signal.aborted;signal.throwIfAborted();
      return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
    }});
  const keepAlive=setInterval(()=>{},10);t.after(()=>clearInterval(keepAlive));
  const result=await f.updater.check();assert.equal(result.update.status,'error');assert.match(result.update.error,/超时/);
  assert.equal(expiredAtFetch,true);
  assert.equal((await readdir(join(f.root,'.local'))).includes('connector-update.lock'),false);
  const abort=new AbortController();abort.abort();
  const g=await fixture(t,{fetchImpl:async(url,{signal})=>{signal.throwIfAborted();return Response.json(release());}});
  const cancelled=await g.updater.check({signal:abort.signal});assert.equal(cancelled.update.status,'error');assert.match(cancelled.update.error,/取消/);
});

test('verified download streams to private temporary file, atomically publishes and only returns whitelisted metadata', async t => {
  const secured=[];
  const f=await fixture(t,{secureFile:async path=>{secured.push(path);}});
  const result=await f.updater.download();assert.equal(result.installerVerified,true);assert.equal(result.installerVersion,'1.1.0');assert.equal(result.installerSha256,sha);
  assert.equal(result.installerPath,resolve(f.root,'.local/updates/CodexMobileConnector-Setup-v1.1.0.exe'));
  assert.deepEqual(await readFile(result.installerPath),installer);assert.equal(result.update.status,'ready');
  assert.ok(secured.some(path=>path.endsWith('.part')));assert.deepEqual(await readdir(join(f.root,'.local/updates')),['CodexMobileConnector-Setup-v1.1.0.exe']);
  assert.deepEqual(Object.keys(result).sort(),['installerPath','installerSha256','installerVerified','installerVersion','update']);
});

test('cancellation raised while a fetch is pending rejects its listener and releases the operation lock', async t => {
  const abort=new AbortController();let abortedAtFetch;
  const f=await fixture(t,{fetchImpl:async(url,{signal})=>{
    abortedAtFetch=signal.aborted;signal.throwIfAborted();
    return new Promise((_,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      setTimeout(()=>abort.abort(),5);
    });
  }});
  const result=await f.updater.check({signal:abort.signal});
  assert.equal(abortedAtFetch,false);assert.equal(result.update.status,'error');assert.match(result.update.error,/取消/);
  assert.equal((await readdir(join(f.root,'.local'))).includes('connector-update.lock'),false);
});

test('same-version SHA256SUMS authorizes missing API digest; unverified and duplicate manifests fail', async t => {
  for(const manifest of [`${sha}  ${UPDATE_INSTALLER}\n`,`short  ${UPDATE_INSTALLER}`,`${sha}  ${UPDATE_INSTALLER}\n${sha}  ${UPDATE_INSTALLER}\n`]){
    const value=release();value.assets[0].digest=null;
    const f=await fixture(t,{fetchImpl:async url=>url===UPDATE_API?Response.json(value):url.endsWith('SHA256SUMS')?new Response(manifest):new Response(installer)});
    const result=await f.updater.download();assert.equal(result.installerVerified,manifest.split('\n').length===2?true:undefined);
  }
});

test('bad hashes, incomplete and oversized streams leave no executable or partial file', async t => {
  const variants=[new Response(Buffer.from('MZwrong')),new Response(installer,{headers:{'content-length':String(installer.length+1)}}),new Response(Buffer.alloc(65)),new Response(installer,{headers:{'content-length':'1000'}})];
  for(const download of variants){
    const f=await fixture(t,{maxInstallerBytes:64,fetchImpl:async url=>url===UPDATE_API?Response.json(release()):download});
    const result=await f.updater.download();assert.equal(result.installerVerified,undefined);assert.equal(result.update.status,'error');
    assert.deepEqual(await readdir(join(f.root,'.local/updates')),[]);
  }
});

test('installer redirects stay on GitHub release asset CDN; Hub/foreign/http/credential destinations fail', async t => {
  const destinations=['https://private-hub.invalid/setup.exe','http://release-assets.githubusercontent.com/github-production-release-asset/123/abc','https://user:secret@release-assets.githubusercontent.com/github-production-release-asset/123/abc','https://release-assets.githubusercontent.com/other/abc'];
  for(const location of destinations){const requests=[];const f=await fixture(t,{fetchImpl:async url=>{requests.push(url);return url===UPDATE_API?Response.json(release()):new Response(null,{status:302,headers:{location}});}});
    const result=await f.updater.download();assert.equal(result.installerVerified,undefined);assert.equal(result.update.status,'error');assert.equal(requests.length,2);assert.deepEqual(await readdir(join(f.root,'.local/updates')),[]);
  }
  const cdn='https://release-assets.githubusercontent.com/github-production-release-asset/123/abcdef12-1234-1234-1234-abcdefabcdef?signature=opaque';
  const f=await fixture(t,{fetchImpl:async url=>url===UPDATE_API?Response.json(release()):url===cdn?new Response(installer):new Response(null,{status:302,headers:{location:cdn}})});
  assert.equal((await f.updater.download()).installerVerified,true);
});

test('symlink/junction update directories fail before any installer is written', async t => {
  const f=await fixture(t);await mkdir(join(f.root,'.local'));const outside=await mkdtemp(join(tmpdir(),'connector-update-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  await symlink(outside,join(f.root,'.local/updates'),process.platform==='win32'?'junction':'dir');
  await assert.rejects(f.updater.download(),/目录无效/);assert.deepEqual(await readdir(outside),[]);
});

test('interrupted download cleans partial bytes and never returns a previously verified file on retry failure', async t => {
  const abort = new AbortController(); let interrupted = false;
  const f=await fixture(t,{fetchImpl:async url=>{
    if(url===UPDATE_API)return Response.json(release());
    if(!interrupted)return new Response(installer);
    let chunks=0;
    return new Response(new ReadableStream({pull(controller){if(chunks++===0)controller.enqueue(Buffer.from('MZpartial'));else{abort.abort();controller.close();}}},{highWaterMark:0}));
  }});
  const first=await f.updater.download();assert.equal(first.installerVerified,true);
  interrupted=true;
  const failed=await f.updater.download({signal:abort.signal});assert.equal(failed.installerPath,undefined);assert.equal(failed.installerVerified,undefined);assert.equal(failed.update.status,'error');assert.match(failed.update.error,/取消/);
  assert.deepEqual(await readFile(first.installerPath),installer);
  assert.deepEqual(await readdir(join(f.root,'.local/updates')),['CodexMobileConnector-Setup-v1.1.0.exe']);
});

test('malformed preferences and private-state JSON fail without touching pairing files', async t => {
  const f=await fixture(t);await mkdir(join(f.root,'.local'));const pairing='private-fixture-credentials';await writeFile(join(f.root,'.local/hub-connector.json'),pairing);
  await writeFile(join(f.root,'.local/connector-update-preferences.json'),'null');
  await assert.rejects(f.updater.check(),/更新设置无效/);
  assert.equal(await readFile(join(f.root,'.local/hub-connector.json'),'utf8'),pairing);assert.equal(f.calls.length,0);
});
