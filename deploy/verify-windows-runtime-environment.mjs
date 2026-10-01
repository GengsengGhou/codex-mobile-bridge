import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';

if (process.platform !== 'win32') throw Error('Windows verification required');
const setup=resolve(process.argv[2] || 'dist/CodexMobileConnector-Setup.exe');
const oldSetup=resolve(process.argv[3] || 'work/verification/desktop-v020/v019-Setup.exe');
const output=resolve(process.argv[4] || 'work/verification/desktop-v020/runtime-environment-regression.json');
const names=['CODEX_THREAD_ID','BRIDGE_ENABLE_SEND','BRIDGE_SEND_THREAD_ID','BRIDGE_SEND_SCOPE','BRIDGE_PORT'];
const clean={...process.env};for(const name of names)delete clean[name];
const run=(file,args,env=clean)=>spawnSync(file,args,{env,windowsHide:true,encoding:'utf8',timeout:120000});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fixture=await mkdtemp(join(tmpdir(),'codex-runtime-environment-'));
const root=join(fixture,'app'),local=join(root,'.local');
const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
const saved={callerThreadId:process.env.CODEX_THREAD_ID,enableSend:false,allowedSendThreadId:process.env.CODEX_THREAD_ID,sendScope:'single',port};
assert.match(saved.callerThreadId,/^[0-9a-f-]{36}$/i);
const bytes=Buffer.from(JSON.stringify(saved,null,2)+'\n');
const polluted={...clean,CODEX_THREAD_ID:'22222222-2222-4222-8222-222222222222',BRIDGE_ENABLE_SEND:'1',BRIDGE_SEND_THREAD_ID:'33333333-3333-4333-8333-333333333333',BRIDGE_SEND_SCOPE:'all-local',BRIDGE_PORT:String(port===65535?65534:port+1)};
const node=join(root,'runtime/node.exe');
let passed=false;
try {
  assert.equal(run(oldSetup,['--install-root',root,'--install']).status,0,'Old isolated install failed');
  await mkdir(local,{recursive:true});await writeFile(join(local,'runtime.json'),bytes);
  const oldStart=run(node,[join(root,'scripts/start.mjs')]);assert.equal(oldStart.status,0,'Old real bridge readiness failed');
  assert.equal(hash(await readFile(join(local,'runtime.json'))),hash(bytes),'Fixture baseline changed');
  const upgrade=run(setup,['--install-root',root,'--install'],polluted);assert.equal(upgrade.status,0,'Polluted-environment upgrade failed');
  assert.equal(hash(await readFile(join(local,'runtime.json'))),hash(bytes),'Installed runtime identity/permissions changed');
  const rootResponse=await fetch(`http://127.0.0.1:${port}/`);assert.equal(rootResponse.ok,true);assert.match(await rootResponse.text(),/<title>Codex Mobile Bridge<\/title>/);
  const evidence={at:new Date().toISOString(),passed:true,realOldBridgeStarted:true,actualInstallerUpgradeExit:upgrade.status,pollutedOverrides:names,runtimeExactBytesPreserved:true,englishRootReady:true,setupSha256:hash(await readFile(setup)),originalReleaseSha256:hash(await readFile(oldSetup))};
  await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));passed=true;
} finally {
  const uninstall=join(root,'deploy/uninstall-connector.ps1');
  try {await readFile(uninstall);const cleanup=run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',uninstall,'-Root',root]);assert.equal(cleanup.status,0,'Isolated fixture uninstall failed');}finally{await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
}
assert.equal(passed,true);
