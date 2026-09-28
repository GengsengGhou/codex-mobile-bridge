import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guiCommand as realGuiCommand } from '../scripts/connector-gui.mjs';
import { pairConnector } from '../scripts/setup-connector.mjs';
const control = { read: async()=>({paused:false,autoStart:false}), resume:async()=>({paused:false,revision:'fixture'}), mayRun:async()=>true };
const guiCommand = (command,deps={}) => realGuiCommand(command,{control,...deps});

test('first GUI pairing registers deferred login and starts persistent watcher before Codex exists', async () => {
  const calls=[];
  const paired=await guiCommand({ action:'pair', origin:'https://example.com', code:'x'.repeat(43), name:'PC' }, {
    read:async()=>null, choosePort:async()=>4321,
    pair:async opts=>{ calls.push('pair'); assert.equal(opts.bridgePort,4321); return {deviceId:'fixture'}; },
    registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,true);calls.push('register');},watch:async()=>calls.push('watcher')
  });
  assert.equal(paired.state,'waiting'); assert.deepEqual(calls,['pair','register','watcher']);
  await guiCommand({action:'connect'}, {read:async()=>({bridgePort:4321}),registerDeferred:async opts=>{assert.equal(opts.allowBootstrap,undefined);calls.push('register');},watch:async()=>calls.push('watcher')});
  assert.deepEqual(calls,['pair','register','watcher','register','watcher']);
});
test('failed login registration does not launch an unmanaged watcher',async()=>{
  let launched=false;
  await assert.rejects(guiCommand({action:'connect'},{read:async()=>({bridgePort:4321}),registerDeferred:async()=>{throw Error('Registration failed');},watch:async()=>{launched=true;}}),/Registration failed/);
  assert.equal(launched,false);
});
test('replacement requires deliberate choice and rejected fixture pairing preserves previous credentials',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-gui-fixture-'));
  const configPath=join(dir,'pair.json'); const original=JSON.stringify({version:1,hubOrigin:'https://old.example',bridgePort:4321,deviceId:'old',deviceToken:'secret-fixture'});
  await writeFile(configPath,original);
  const server=createServer((req,res)=>{res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Pairing code expired'}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    await assert.rejects(guiCommand({action:'pair',origin:'https://new.example'},{configPath}),/已有设备配对/);
    let stopped=false;
    await assert.rejects(guiCommand({action:'pair',replace:true,origin:`http://127.0.0.1:${server.address().port}`,code:'x'.repeat(43),name:'Fixture'},{configPath,pair:opts=>pairConnector({...opts,allowInsecureLocal:true}),stopPrevious:async()=>{stopped=true;}}),/expired/);
    assert.equal(await readFile(configPath,'utf8'),original); assert.equal(stopped,false);
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('successful fixture pairing writes credentials privately and status never returns token',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'codex-gui-success-')); const configPath=join(dir,'pair.json');
  const token='t'.repeat(43), id='11111111-1111-4111-8111-111111111111';
  const server=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({deviceId:id,deviceToken:token}));});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  try {
    const result=await guiCommand({action:'pair',origin:`http://127.0.0.1:${server.address().port}`,code:'c'.repeat(43),name:'Fixture'}, {configPath,choosePort:async()=>4321,pair:opts=>pairConnector({...opts,allowInsecureLocal:true}),registerDeferred:async()=>{},watch:async()=>{}});
    assert.equal(result.deviceId,id); assert.equal(JSON.stringify(result).includes(token),false);
    assert.equal(JSON.parse(await readFile(configPath,'utf8')).deviceToken,token);
    const status=await guiCommand({action:'status'},{configPath,probe:async()=>null}); assert.equal(status.deviceId,id); assert.equal(status.bridgeConnected,false); assert.equal(status.state,'waiting'); assert.equal(JSON.stringify(status).includes(token),false);
  } finally {await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
