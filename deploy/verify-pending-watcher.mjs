import { mkdtemp, mkdir, cp, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { launchConnectorLoginWatcher } from '../scripts/connector-login.mjs';
import { launchWindowsBridge } from '../scripts/windows-launch.mjs';
if(process.platform!=='win32') throw Error('Windows is required.');
const source=fileURLToPath(new URL('..',import.meta.url));
const root=await mkdtemp(resolve(tmpdir(),'codex-pending-watcher-'));
await mkdir(resolve(root,'.local')); await mkdir(resolve(root,'runtime')); await mkdir(resolve(root,'empty-codex-home'));
for(const directory of ['scripts','src','hub','deploy']) await cp(resolve(source,directory),resolve(root,directory),{recursive:true});
await cp(process.execPath,resolve(root,'runtime/node.exe'));
await writeFile(resolve(root,'package.json'),'{"type":"module"}');
await writeFile(resolve(root,'installed.json'),JSON.stringify({version:1,root}));
await writeFile(resolve(root,'.local/hub-connector.json'),JSON.stringify({version:1,hubOrigin:'https://fixture.invalid',deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'f'.repeat(43),bridgePort:54389}));
const nodePath=resolve(root,'runtime/node.exe');
await writeFile(resolve(root,'.local/connector-login.json'),JSON.stringify({version:1,nodePath,bootstrap:true}));
const start=()=>launchConnectorLoginWatcher({root,launch:options=>launchWindowsBridge({...options,nodePath,env:{CODEX_HOME:resolve(root,'empty-codex-home')}})});
const literal=value=>"'"+value.replaceAll("'","''")+"'";
const processes=()=>{
  const script=`@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ceq ${literal(nodePath)} -and $_.CommandLine.Contains(${literal(resolve(root,'scripts/connector-login.mjs'))})} | Select-Object ProcessId,ParentProcessId) | ConvertTo-Json -Compress`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);const data=result.stdout.trim()?JSON.parse(result.stdout):[];return Array.isArray(data)?data:[data];
};
let evidence;
try {
  const first=await start(); await new Promise(r=>setTimeout(r,2500));
  const second=await start(); await new Promise(r=>setTimeout(r,2500));
  assert.equal(processes().length,1,'Owned mutex must allow only one persistent watcher.');
  await new Promise(r=>setTimeout(r,10000));
  assert.equal(processes().length,1,'Pending watcher must remain alive without the GUI.');
  await assert.rejects(access(resolve(root,'.local/runtime.json')),{code:'ENOENT'});
  const stdout=await readFile(resolve(root,'.local/connector-login.stdout.log'),'utf8');
  const stderr=await readFile(resolve(root,'.local/connector-login.stderr.log'),'utf8');
  assert.match(stdout,/等待 Codex/); assert.equal(stderr.trim(),'');
  evidence={root,firstWrapperPid:first.pid,secondWrapperPid:second.pid,independentWatcherAlive:true,duplicateWatcherPrevented:true,noConversationCreated:true,missingOrdinaryConversation:'waiting and retrying',startupRegistrations:'not modified',livePairing:'not modified'};
} finally {
  const cleanup=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',resolve(root,'deploy/uninstall-connector.ps1'),'-Root',root],{windowsHide:true,encoding:'utf8',timeout:30000});
  assert.equal(cleanup.status,0,cleanup.stderr);
  assert.equal(processes().length,0,'Uninstall must stop this installation\'s pending watcher.');
}
await writeFile(resolve(source,'docs/verification/pending-watcher-evidence.json'),JSON.stringify({...evidence,ownedWatcherStoppedByUninstall:true},null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
