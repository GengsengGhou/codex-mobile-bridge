import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('actual native scheduling methods use bounded elapsed deadlines and recover from wall jumps', { skip: process.platform !== 'win32' }, async t => {
  const source = await readFile(new URL('../deploy/windows/WebViewConnector.cs', import.meta.url), 'utf8');
  function method(name) {
    const start = source.indexOf(`    ${name}`); assert(start >= 0);
    let depth = 0, end = source.indexOf('{', start);
    for (let i = end; i < source.length; i++) { if (source[i] === '{') depth++; else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1); }
    throw Error('method not closed');
  }
  const methods = ['void SetUpdateDelay(', 'bool UpdateDue(', 'void ScheduleUpdate('].map(method).join('\n');
  const root = await mkdtemp(join(tmpdir(), 'connector-native-update-schedule-'));t.after(() => rm(root, { recursive: true, force: true }));
  const harness = `using System;using System.Collections.Generic;using System.Diagnostics;using System.Globalization;
class ScheduleHarness {
bool updateAutomatic=true;DateTime nextUpdateCheck;readonly Stopwatch updateClock=Stopwatch.StartNew();double updateDueMs,updateClockSample;DateTime updateWallSample=DateTime.UtcNow;
void RecordUpdateSchedule(string status){}
${methods}
static void Check(bool ok,string name){if(!ok)throw new Exception(name);Console.WriteLine("PASS "+name);}
static void Main(){var s=new ScheduleHarness();
s.SetUpdateDelay(86400000);Check(!s.UpdateDue(),"daily delay does not run early");
s.updateWallSample=DateTime.UtcNow.AddYears(-2);Check(s.UpdateDue(),"forward wall correction runs soon");
s.SetUpdateDelay(3600000);s.updateWallSample=DateTime.UtcNow.AddYears(2);Check(s.UpdateDue(),"backward wall correction runs soon");
s.SetUpdateDelay(3600000);s.updateDueMs=s.updateClock.Elapsed.TotalMilliseconds-1;Check(s.UpdateDue(),"elapsed deadline becomes due");
s.ScheduleUpdate(new Dictionary<string,object>{{"automatic",false},{"nextCheckDelayMs",0}});Check(!s.UpdateDue()&&s.nextUpdateCheck==DateTime.MaxValue,"disabled automatic remains disabled");
s.ScheduleUpdate(new Dictionary<string,object>{{"automatic",true},{"status","error"},{"lastAttemptAt","2099-01-01"},{"nextCheckDelayMs",0}});Check(s.UpdateDue(),"future persisted date cannot override backend due-now");
s.ScheduleUpdate(new Dictionary<string,object>{{"automatic",true},{"nextCheckDelayMs",double.MaxValue}});Check(s.updateDueMs-s.updateClock.Elapsed.TotalMilliseconds<=86400000,"oversized delay clamped without datetime overflow");
s.ScheduleUpdate(new Dictionary<string,object>{{"automatic",true},{"nextCheckDelayMs","not-a-duration"}});Check(s.UpdateDue(),"malformed delay retries soon");
s.ScheduleUpdate(new Dictionary<string,object>{{"automatic",true},{"nextCheckDelayMs",86400000}},true);Check(s.UpdateDue(),"enabling automatic checks promptly");
}}
`;
  const input = join(root, 'ScheduleHarness.cs'), output = join(root, 'ScheduleHarness.exe');await writeFile(input, harness);
  const compiler = join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${output}`, input], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(build.status, 0, build.stdout + build.stderr);
  const run = spawnSync(output, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });assert.equal(run.status, 0, run.stdout + run.stderr);assert.equal(run.stdout.match(/PASS /g)?.length, 9);
});
