import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const [setup,oldSetup]=process.argv.slice(2,4).map(path=>resolve(path));
const output=resolve(process.argv[4]||'work/verification/desktop-v020');
const run=(file,args)=>spawnSync(file,args,{windowsHide:true,encoding:'utf8',timeout:120000});
const fixture=await mkdtemp(join(tmpdir(),'codex-language-upgrade-'));
const evidence={surface:'Actual v0.1.9 Setup upgraded by actual v0.2.0 Setup',realInstallationModified:false,cases:{}};
await mkdir(output,{recursive:true});
try {
 for(const scenario of ['rollback','interruption']){
  const root=join(fixture,scenario);assert.equal(run(oldSetup,['--install-root',root,'--install']).status,0);
  await mkdir(join(root,'.local'),{recursive:true});const pref=join(root,'.local/desktop-language.json');await writeFile(pref,JSON.stringify({language:'en'}));const previous=await readFile(join(root,'CodexMobileConnector.exe'));
  const failed=run(setup,['--install-root',root,'--install','--language','zh-CN',scenario==='rollback'?'--qa-upgrade-language-fail':'--qa-upgrade-language-abort']);assert.equal(failed.status,1);
  if(scenario==='rollback'){
   assert.deepEqual(await readFile(join(root,'CodexMobileConnector.exe')),previous);assert.deepEqual(JSON.parse(await readFile(pref,'utf8')),{language:'en'});
   assert.equal(run(setup,['--install-root',root,'--install','--language','zh-CN']).status,0);assert.deepEqual(JSON.parse(await readFile(pref,'utf8')),{language:'zh-CN'});
   evidence.cases.rollback={failureAfterPreferenceWriteRestoresPriorBytes:true,successfulSelectedChoicePersistedBeforeGuiRelaunch:true};
  }else{
   assert.deepEqual(JSON.parse(await readFile(pref,'utf8')),{language:'zh-CN'});await access(root+'.upgrade-journal.json');
   assert.equal(run(setup,['--install-root',root,'--install','--language','en']).status,0);assert.deepEqual(JSON.parse(await readFile(pref,'utf8')),{language:'en'});await assert.rejects(access(root+'.upgrade-journal.json'));
   evidence.cases.interruption={interruptedAfterPreferenceWrite:true,recoveryAndNewChoicePersisted:true};
  }
  const removed=run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(root,'deploy/uninstall-connector.ps1'),'-Root',root]);assert.equal(removed.status,0,removed.stderr);assert.equal(JSON.parse(await readFile(pref,'utf8')).language,scenario==='rollback'?'zh-CN':'en');
 }
 evidence.passed=true;evidence.uninstallRetainsPreference=true;await writeFile(join(output,'language-upgrade-evidence.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{await rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:300});}
