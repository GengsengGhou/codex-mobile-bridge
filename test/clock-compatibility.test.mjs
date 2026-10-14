import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { createClockTransport } from '../scripts/hub-clock.mjs';
import { CLOCK_PATH, clockSecretHash, clockResponseMac } from '../src/clock-protocol.mjs';
import { HubStore } from '../hub/store.mjs';
import { createHubServer } from '../hub/server.mjs';
import { startConnector } from '../hub/connector.mjs';
import { createBridgeServer } from '../src/server.mjs';
import { createCollaborationGuard } from '../src/collaboration-guard.mjs';
import { CreationStore } from '../src/creation-store.mjs';
import { DeliveryStore } from '../src/delivery-store.mjs';
import { createCollaborationExecutor } from '../scripts/collaboration-executor.mjs';
import { createCollaborationClient } from '../scripts/collaboration-client.mjs';
import { collaborationSettings } from '../scripts/collaboration-settings.mjs';
import { writePrivate } from '../scripts/collaboration-common.mjs';
import { pairConnector } from '../scripts/setup-connector.mjs';
import { serveMcp } from '../scripts/collaboration-mcp.mjs';

const execute = promisify(execFile), windows = process.platform === 'win32';
const moduleRoot=fileURLToPath(new URL('../',import.meta.url)),evidenceDirectory=process.env.CLOCK_TEST_EVIDENCE_DIRECTORY||resolve('work/clock-compatibility/tls');
const summary={total:0,passed:0,failed:0,skipped:0};
const nativeTest = (name, fn) => { summary.total++;if(!windows)summary.skipped++;return test(name, { skip: !windows, timeout: 60000 }, async t=>{try{await fn(t);summary.passed++;}catch(error){summary.failed++;records.push({case:name,passed:false,errorCode:error.code||error.name});throw error;}}); };
let scratch, fixture, helperPath, slowHelperPath, helperPidPath;
const records = [];
const certificateGenerator = String.raw`
import datetime as dt,json
from cryptography import x509
from cryptography.x509.oid import NameOID,ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
now=dt.datetime.now(dt.timezone.utc);future=now+dt.timedelta(days=730)
key=lambda:rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=lambda s:x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,s)])
rootkey=key();otherkey=key()
def root(k,n):
 return x509.CertificateBuilder().subject_name(name(n)).issuer_name(name(n)).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-dt.timedelta(days=20)).not_valid_after(future+dt.timedelta(days=100)).add_extension(x509.BasicConstraints(True,None),True).add_extension(x509.KeyUsage(False,False,False,False,False,True,True,False,False),True).sign(k,hashes.SHA256())
ca=root(rootkey,'fixture root');other=root(otherkey,'untrusted fixture root')
def leaf(kind):
 k=key();signer=otherkey if kind=='untrusted' else rootkey
 issuer='untrusted fixture root' if kind=='untrusted' else 'fixture root'
 start=now-dt.timedelta(days=10) if kind=='normal' else future-dt.timedelta(days=10)
 end=now+dt.timedelta(days=10) if kind=='normal' else future+dt.timedelta(days=10)
 if kind=='expired':end=future-dt.timedelta(days=1)
 c=x509.CertificateBuilder().subject_name(name('localhost')).issuer_name(name(issuer)).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(False,None),True).add_extension(x509.SubjectAlternativeName([x509.DNSName('wrong.invalid' if kind=='wrongname' else 'localhost')]),False).add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]),False).sign(signer,hashes.SHA256())
 return {'key':k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()).decode(),'cert':c.public_bytes(serialization.Encoding.PEM).decode()}
print(json.dumps({'now':int(now.timestamp()*1000),'futureTime':int(future.timestamp()*1000),'ca':ca.public_bytes(serialization.Encoding.PEM).decode(),**{k:leaf(k) for k in ['future','normal','wrongname','untrusted','expired']}}))
`;
before(async () => {
  if (!windows) return;
  scratch = await mkdtemp(join(tmpdir(), 'bridge-clock-tls-'));
  helperPath = process.env.CLOCK_TEST_HELPER||join(scratch, 'CertificateVerifier.exe');
  if(!process.env.CLOCK_TEST_HELPER)await execute('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['/nologo','/target:exe','/platform:x64','/optimize+','/reference:System.Web.Extensions.dll',`/out:${helperPath}`,resolve(moduleRoot,'deploy/windows/ClockCertificateVerifier.cs')], { windowsHide: true });
  slowHelperPath=join(scratch,'SlowVerifier.exe');helperPidPath=join(scratch,'helper.pid');const slowSource=join(scratch,'SlowVerifier.cs');
  await writeFile(slowSource,`using System; using System.IO; using System.Diagnostics; using System.Threading; class SlowVerifier { static void Main() { Console.In.ReadToEnd(); File.WriteAllText(@"${helperPidPath.replaceAll('"','""')}",Process.GetCurrentProcess().Id.ToString()); Thread.Sleep(30000); } }`);
  await execute('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',['/nologo','/target:exe',`/out:${slowHelperPath}`,slowSource],{windowsHide:true});
  const generatorPath=join(scratch,'generate.py');await writeFile(generatorPath,certificateGenerator);
  // Windows native integration requires an available conda command and py312
  // with cryptography. Resolve conda through PATH rather than an install path.
  const generated = await execute('powershell.exe', ['-NoProfile','-NonInteractive','-Command',`conda run -n py312 python '${generatorPath.replaceAll("'","''")}'`], { windowsHide:true, maxBuffer:1024*1024,timeout:30000 });
  fixture = JSON.parse(generated.stdout);
});
after(async () => {
  if (!windows) return;
  try { if(fixture){await mkdir(evidenceDirectory, { recursive:true });
    await writeFile(join(evidenceDirectory,'results.json'), JSON.stringify({ summary, actualHostClockChanged:false, productionStateTouched:false, certificatesAndPrivateKeysPersisted:false, actualDate:new Date(fixture.now).toISOString(),referenceDate:new Date(fixture.futureTime).toISOString(), records },null,2));}
  } finally { if(scratch)await rm(scratch,{recursive:true,force:true}); }
});
const listen = server => new Promise(done => server.listen(0,'127.0.0.1',()=>done(server.address().port)));
async function close(server) { server.closeAllConnections?.(); await new Promise(done => server.close(done)); }
async function until(fn) { const deadline=performance.now()+15000; while(!fn()) { if(performance.now()>deadline) throw new Error('fixture wait timed out'); await new Promise(done=>setTimeout(done,20)); } }
function transport(origin, values={}) { return createClockTransport({ origin,secret:'a'.repeat(43),subject:'11111111-1111-4111-8111-111111111111',ca:fixture.ca,helperPath,...values }); }
async function standalone(t, {kind='future', mutate, oldHub=false, delay=0}={}) {
  const observed={bootstrap:[],business:[],upgrades:0,sockets:new Set()}; let origin, previous;
  const server=https.createServer(fixture[kind],async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const text=Buffer.concat(chunks).toString();
    if(req.url===CLOCK_PATH) {
      observed.bootstrap.push({headers:req.headers,text});
      if(oldHub){res.writeHead(404);res.end('{}');return;}
      const value=JSON.parse(text);let reply={version:1,type:value.type,origin,subject:value.subject,nonce:value.nonce,serverTime:fixture.futureTime};
      reply.mac=clockResponseMac(clockSecretHash('a'.repeat(43)),reply);
      if(mutate)reply=mutate(reply,previous)||reply;previous=reply;
      if(delay)await new Promise(done=>setTimeout(done,delay));
      res.setHeader('content-type','application/json');res.end(JSON.stringify(reply));return;
    }
    observed.business.push({url:req.url,headers:req.headers,text});res.setHeader('content-type','application/json');res.end('{"ok":true}');
  });
  server.on('upgrade',(_req,socket)=>{observed.upgrades++;socket.destroy();});
  server.on('secureConnection',socket=>{observed.sockets.add(socket);socket.once('close',()=>observed.sockets.delete(socket));});
  origin=`https://localhost:${await listen(server)}`;
  t.after(()=>close(server));return{origin,observed,server};
}
const business = (tr,origin) => tr.fetch(origin+'/business',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(43),'content-type':'application/json'},body:'{"operation":"sensitive"}'});

nativeTest('real future TLS certificate: stock rejection, native same-socket success, credential-free bootstrap',async t=>{
  const f=await standalone(t);const tr=transport(f.origin);t.after(()=>tr.close());
  await assert.rejects(new Promise((yes,no)=>https.get(f.origin+'/business',{ca:fixture.ca},yes).on('error',no)),e=>e.code==='CERT_NOT_YET_VALID');
  assert.equal(f.observed.business.length,0);
  assert.equal((await business(tr,f.origin)).status,200);assert.equal(tr.clockCompatible(),true);
  assert.equal(f.observed.bootstrap.length,1);assert.equal(f.observed.business.length,1);
  const proof=f.observed.bootstrap[0];assert.equal(proof.headers.authorization,undefined);assert.equal(proof.headers.cookie,undefined);
  assert.equal(proof.text.includes('a'.repeat(43)),false);assert.equal(proof.text.includes(clockSecretHash('a'.repeat(43))),false);
  assert.deepEqual(Object.keys(JSON.parse(proof.text)).sort(),['mac','nonce','origin','subject','type','version']);
  records.push({case:'future certificate actual TLS and same-socket native validation',passed:true,bootstrapRequests:1,businessRequests:1,stockError:'CERT_NOT_YET_VALID',credentialLeak:false});
});

for(const kind of ['wrongname','untrusted','expired']) nativeTest(`actual TLS ${kind} rejection sends no business bearer`,async t=>{
  const f=await standalone(t,{kind});const tr=transport(f.origin);t.after(()=>tr.close());
  await assert.rejects(business(tr,f.origin));assert.equal(f.observed.business.length,0);
  records.push({case:kind,passed:true,businessRequests:0,bootstrapRequests:f.observed.bootstrap.length});
});
nativeTest('stock connector WSS certificate and helper failures send no bearer upgrade',async t=>{
  const local=http.createServer((_req,res)=>{res.setHeader('set-cookie','bridge_session='+'a'.repeat(64)+'; Path=/');res.end('fixture');});const bridgePort=await listen(local);t.after(()=>close(local));
  const cases=[];
  for(const kind of ['wrongname','untrusted','expired','helper']) {
    const f=await standalone(t,{kind:kind==='helper'?'future':kind}),tr=transport(f.origin,kind==='helper'?{helperPath:join(scratch,'missing.exe')}:{});
    const connector=startConnector({hubOrigin:f.origin,deviceId:'11111111-1111-4111-8111-111111111111',deviceToken:'a'.repeat(43),bridgePort,clockTransport:tr,reconnectMinMs:30000,reconnectMaxMs:30000});
    try{await until(()=>connector.status().networkError);assert.equal(connector.status().connected,false);assert.equal(f.observed.upgrades,0);assert.equal(f.observed.business.length,0);cases.push({kind,upgradeRequests:0,businessRequests:0});}
    finally{connector.stop();tr.close();}
  }
  records.push({case:'stock WSS validation failures',passed:true,cases});
});
nativeTest('missing native verifier rejects before any sensitive bytes',async t=>{
  const f=await standalone(t);const tr=transport(f.origin,{helperPath:join(scratch,'missing.exe')});t.after(()=>tr.close());
  await assert.rejects(business(tr,f.origin),e=>e.code==='CLOCK_VALIDATION_UNAVAILABLE');assert.equal(f.observed.business.length,0);
  records.push({case:'native helper unavailable',passed:true,businessRequests:0});
});
nativeTest('AbortSignal during actual TLS handshake releases private socket',async t=>{
  const sockets=new Set();const server=net.createServer(socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.resume();});
  const origin=`https://localhost:${await listen(server)}`,tr=transport(origin),controller=new AbortController();t.after(()=>{tr.close();for(const socket of sockets)socket.destroy();return close(server);});
  const pending=tr.fetch(origin+'/sensitive',{headers:{authorization:'Bearer '+'a'.repeat(43)},signal:controller.signal});
  const rejection=assert.rejects(pending,e=>e.name==='AbortError'||e.code==='ABORT_ERR');await until(()=>sockets.size===1);controller.abort();await rejection;await until(()=>sockets.size===0);
  records.push({case:'abort during TLS handshake',passed:true,businessRequests:0,remainingSockets:0});
});
for(const action of ['abort','close']) nativeTest(`${action} during native subprocess validation kills helper and sends zero business bytes`,async t=>{
  await rm(helperPidPath,{force:true});const f=await standalone(t),controller=new AbortController(),tr=transport(f.origin,{helperPath:slowHelperPath});t.after(()=>tr.close());
  const pending=tr.fetch(f.origin+'/sensitive',{headers:{authorization:'Bearer '+'a'.repeat(43)},signal:controller.signal});
  const rejection=assert.rejects(pending,e=>e.name==='AbortError'||e.code==='ABORT_ERR');let pid;
  const deadline=performance.now()+10000;while(!pid){try{pid=Number(await readFile(helperPidPath,'utf8'));}catch{}if(performance.now()>deadline)throw new Error('native fixture never started');if(!pid)await new Promise(done=>setTimeout(done,20));}
  if(action==='abort')controller.abort();else tr.close();await rejection;
  await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}});await until(()=>f.observed.sockets.size===0);
  assert.equal(f.observed.business.length,0);records.push({case:action+' native validation',passed:true,helperTerminated:true,remainingSockets:0,businessRequests:0});
});
nativeTest('already-aborted request and synchronous validation abort consume rejected promises',async t=>{
  const f=await standalone(t),first=new AbortController();first.abort();const tr=transport(f.origin);t.after(()=>tr.close());
  await assert.rejects(tr.fetch(f.origin+'/sensitive',{signal:first.signal}),e=>e.name==='AbortError'||e.code==='ABORT_ERR');assert.equal(f.observed.bootstrap.length,0);
  const second=new AbortController(),unhandled=[];const capture=error=>unhandled.push(error);process.on('unhandledRejection',capture);t.after(()=>process.off('unhandledRejection',capture));
  const racing=transport(f.origin,{verifyChain:()=>{second.abort();return Promise.reject(new Error('fixture validation rejection after abort'));}});t.after(()=>racing.close());
  await assert.rejects(racing.fetch(f.origin+'/sensitive',{signal:second.signal}),e=>e.name==='AbortError'||e.code==='ABORT_ERR');
  await new Promise(done=>setTimeout(done,30));assert.equal(unhandled.length,0);assert.equal(f.observed.business.length,0);
  records.push({case:'already aborted and validation abort rejection race',passed:true,unhandledRejections:0,businessRequests:0});
});
for(const field of ['mac','nonce','subject','origin','type']) nativeTest(`HTTPS proof tampered ${field} rejected before business`,async t=>{
  const f=await standalone(t,{mutate:reply=>{const value={...reply,[field]:field==='type'?'pairing':'bad'};if(field!=='mac')value.mac=clockResponseMac(clockSecretHash('a'.repeat(43)),value);return value;}});const tr=transport(f.origin);t.after(()=>tr.close());
  await assert.rejects(business(tr,f.origin),e=>e.code==='CLOCK_AUTH_FAILED');assert.equal(f.observed.business.length,0);
  records.push({case:'tampered '+field,passed:true,businessRequests:0});
});
nativeTest('real delayed bootstrap exceeding RTT limit sends no business',async t=>{
  const f=await standalone(t,{delay:150});const tr=transport(f.origin,{maxRttMs:50});t.after(()=>tr.close());
  await assert.rejects(business(tr,f.origin),e=>e.code==='CLOCK_AUTH_FAILED');assert.equal(f.observed.business.length,0);
  records.push({case:'RTT timeout',passed:true,businessRequests:0});
});
nativeTest('proof replay, wall-clock jumps and fresh transport require new nonce-bound proof',async t=>{
  let replay=false;const f=await standalone(t,{mutate:(reply,previous)=>replay&&previous?previous:reply});let wall=Date.now();
  const tr=transport(f.origin,{wallNow:()=>wall});t.after(()=>tr.close());
  await business(tr,f.origin);assert.equal(f.observed.bootstrap.length,1);
  wall+=86400000;assert.equal(tr.clockCompatible(),false);replay=true;
  await assert.rejects(business(tr,f.origin),e=>e.code==='CLOCK_AUTH_FAILED');assert.equal(f.observed.business.length,1);
  replay=false;const second=transport(f.origin);t.after(()=>second.close());await business(second,f.origin);
  assert.equal(f.observed.bootstrap.length,3);const nonces=f.observed.bootstrap.map(p=>JSON.parse(p.text).nonce);assert.equal(new Set(nonces).size,3);
  records.push({case:'replay/jump/fresh transport',passed:true,uniqueNonces:3,businessRequests:2});
});
nativeTest('monotonic proof expiry refreshes on a real second TLS connection',async t=>{
  const f=await standalone(t);let offset=0;const tr=transport(f.origin,{monoNow:()=>performance.now()+offset,wallNow:()=>Date.now()+offset,proofMaxAgeMs:1000});t.after(()=>tr.close());
  await business(tr,f.origin);offset=2000;assert.equal(tr.clockCompatible(),false);await business(tr,f.origin);
  assert.equal(f.observed.bootstrap.length,2);assert.equal(f.observed.business.length,2);
  records.push({case:'monotonic expiry refresh',passed:true,bootstrapRequests:2});
});
for(const kind of ['normal','future']) nativeTest(`old Hub 404 clock endpoint with ${kind} certificate`,async t=>{
  const f=await standalone(t,{kind,oldHub:true});const tr=transport(f.origin);t.after(()=>tr.close());
  if(kind==='normal'){assert.equal((await business(tr,f.origin)).status,200);assert.equal(f.observed.bootstrap.length,0);assert.equal(f.observed.business.length,1);}
  else{await assert.rejects(business(tr,f.origin),e=>e.code==='CLOCK_UNSUPPORTED');assert.equal(f.observed.business.length,0);}
  records.push({case:'old Hub '+kind,passed:true,businessRequests:f.observed.business.length});
});

function desktop(root,label) {
  const project={projectId:randomUUID(),label,path:join(root,'project'),hostId:'local',isGitRepository:false};const first=randomUUID(),threads=new Map([[first,{id:first,title:label,kind:'codex',hostId:'local',cwd:project.path,projectId:project.projectId,status:'idle',archived:false}]]);const counts={creates:0,sends:0};
  const bridge={callerThreadId:first,capabilities:async()=>['list_threads','read_thread','create_thread','list_projects','send_message_to_thread'],projects:async()=>[project],list:async()=>({threads:[...threads.values()]}),read:async id=>({thread:{...threads.get(id)},turns:[{role:'assistant',text:'Fixture only'}]}),readMetadata:async id=>({thread:{...threads.get(id)}}),create:async(args,{beforeDispatch})=>{await beforeDispatch();counts.creates++;const id=randomUUID();threads.set(id,{...threads.get(first),id,title:args.title||args.prompt});return{threadId:id,hostId:'local'};},send:async()=>{counts.sends++;}};
  const control={snapshot:async id=>({threadId:id,currentTurnId:null,pendingRequests:[]})};return{bridge,control,project,first,counts};
}
async function dual(t) {
  const root=await mkdtemp(join(scratch,'dual-')),store=new HubStore({now:()=>fixture.futureTime});
  const owner=store.createUser({name:'clock-owner',salt:'fixture',hash:'fixture',role:'admin',initialAdmin:true});let hub;const requests=[],fault={dropNext:false};
  // The HTTPS fixture delivers actual decrypted requests/upgrades to the stock Hub handlers.
  const server=https.createServer(fixture.future,(req,res)=>{requests.push({path:req.url,method:req.method});if(fault.dropNext&&req.method==='POST'&&req.url.startsWith('/api/hub/collaboration/devices/')){fault.dropNext=false;res.end=()=>{req.socket.destroy();return res;};}hub.emit('request',req,res);});
  const origin=`https://localhost:${await listen(server)}`;hub=createHubServer({store,publicOrigin:origin});await listen(hub);
  server.on('upgrade',(req,socket,head)=>{requests.push({path:req.url,method:'UPGRADE'});hub.emit('upgrade',req,socket,head);});
  const endpoints=[];
  t.after(async()=>{for(const e of endpoints){e.connector?.stop();e.tr.close();}hub.relay.close();await Promise.all(endpoints.map(e=>close(e.server)));await close(server);await close(hub);store.close();});
  for(const name of ['A','B']) {
    const localRoot=join(root,name);await mkdir(join(localRoot,'project'),{recursive:true});const d=desktop(localRoot,name);
    const local=createBridgeServer({bridge:d.bridge,control:d.control,enableSend:true,sendScope:'all-local',creationStore:new CreationStore({path:join(localRoot,'.local/creations.json')}),deliveryStore:new DeliveryStore({path:join(localRoot,'.local/deliveries.json')}),collaborationGuard:createCollaborationGuard({root:localRoot})});
    const config={version:1,...store.consumePairing(store.pairing(owner.id,name).pairingCode),hubOrigin:origin,bridgePort:await listen(local)};
    await writePrivate(join(localRoot,'.local/hub-connector.json'),config);const tr=transport(origin,{secret:config.deviceToken,subject:config.deviceId});
    const connector=startConnector({...config,clockTransport:tr,collaborationExecutor:createCollaborationExecutor({root:localRoot,config})});endpoints.push({root:localRoot,config,tr,connector,server:local,...d});
  }
  const [A,B]=endpoints;
  for(const [local,other] of [[A,B],[B,A]])await writePrivate(join(local.root,'.local/computer-collaboration.json'),{version:1,hubOrigin:origin,deviceId:local.config.deviceId,controlEnabled:true,receiveEnabled:true,requiresAuthorization:false,allowedDeviceIds:[other.config.deviceId],allowedProjectRoots:[local.project.path]});
  await until(()=>endpoints.every(e=>e.connector.status().connected));return{root,origin,hub,server,store,owner,A,B,requests,fault};
}
nativeTest('future certificate real Hub + bilateral WSS + stock collaboration, settings, pairing and MCP',async t=>{
  const f=await dual(t),{A,B}=f;const clientA=createCollaborationClient({root:A.root,fetchImpl:A.tr.fetch}),clientB=createCollaborationClient({root:B.root,fetchImpl:B.tr.fetch});
  assert.equal(A.connector.status().clockCompatible,true);assert.equal(B.connector.status().clockCompatible,true);
  assert.deepEqual((await clientA.devices()).devices.map(d=>d.id),[B.config.deviceId]);assert.deepEqual((await clientB.devices()).devices.map(d=>d.id),[A.config.deviceId]);
  for(const [client,target] of [[clientA,B],[clientB,A]]) {
    const operation={operation:'create',operationId:randomUUID(),projectId:target.project.projectId,prompt:'Isolated TLS fixture'};
    const created=await client.call(target.config.deviceId,operation);assert.equal(created.state,'created');await client.call(target.config.deviceId,operation);assert.equal(target.counts.creates,1);
    const send={operation:'send',operationId:randomUUID(),threadId:created.receipt.threadId,prompt:'Fixture continuation'};
    assert.equal((await client.call(target.config.deviceId,send)).state,'accepted');await client.call(target.config.deviceId,send);assert.equal(target.counts.sends,1);
  }
  const lost={operation:'send',operationId:randomUUID(),threadId:B.first,prompt:'Accepted then TLS response lost'};f.fault.dropNext=true;
  const unknown=await clientA.call(B.config.deviceId,lost);assert.equal(unknown.state,'unknown');assert.equal(B.counts.sends,2);
  assert.equal((await clientA.call(B.config.deviceId,lost)).state,'accepted');assert.equal(B.counts.sends,2);
  const settings=await collaborationSettings({action:'read'},{root:A.root,fetchImpl:A.tr.fetch,bridge:async()=>({projects:[A.project]})});assert.equal(settings.collaboration.devicesAvailable,true);
  const code=f.store.pairing(f.owner.id,'fresh TLS pairing').pairingCode;const pairing=transport(f.origin,{type:'pairing',subject:undefined,secret:code});t.after(()=>pairing.close());
  const paired=await pairConnector({origin:f.origin,pairingCode:code,configPath:join(f.root,'paired','.local/hub-connector.json'),fetchImpl:pairing.fetch});assert.ok(paired.deviceId);
  const input=new PassThrough(),output=new PassThrough(),lines=createInterface({input:output}),pending=new Map();let id=0;
  lines.on('line',line=>{const message=JSON.parse(line);pending.get(message.id)?.(message);});serveMcp({root:A.root,input,output,fetchImpl:A.tr.fetch});
  t.after(()=>{input.end();lines.close();output.destroy();});
  const rpc=(method,params)=>new Promise((done,reject)=>{const next=++id,timer=setTimeout(()=>reject(new Error('MCP fixture timeout')),10000);pending.set(next,message=>{clearTimeout(timer);pending.delete(next);done(message);});input.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  assert.ok((await rpc('initialize',{})).result);assert.equal((await rpc('tools/list',{})).result.tools.length,12);
  const response=await rpc('tools/call',{name:'collaboration_projects',arguments:{deviceId:B.config.deviceId}});assert.equal(JSON.parse(response.result.content[0].text).projects[0].projectId,B.project.projectId);
  // Exercise the default production hubClockTransport path in an unmodified CLI,
  // with Node's supported extra trust root and the normal shipped helper location.
  const payload=join(f.root,'stock-mcp');await mkdir(join(payload,'runtime'),{recursive:true});
  await cp(join(moduleRoot,'scripts'),join(payload,'scripts'),{recursive:true});await cp(join(moduleRoot,'src'),join(payload,'src'),{recursive:true});
  await copyFile(join(moduleRoot,'package.json'),join(payload,'package.json'));await copyFile(helperPath,join(payload,'runtime/CertificateVerifier.exe'));
  await cp(join(moduleRoot,'node_modules/@iarna/toml'),join(payload,'node_modules/@iarna/toml'),{recursive:true});
  await cp(join(A.root,'.local'),join(payload,'.local'),{recursive:true});
  const caPath=join(payload,'fixture-ca.pem');await writeFile(caPath,fixture.ca);
  const child=spawn(process.execPath,[join(payload,'scripts/collaboration-mcp.mjs')],{windowsHide:true,env:{...process.env,NODE_EXTRA_CA_CERTS:caPath,NODE_OPTIONS:'',NODE_PATH:''},stdio:['pipe','pipe','pipe']});
  const exited=new Promise(done=>child.once('close',done));child.stderr.resume();const childLines=createInterface({input:child.stdout}),childPending=new Map();let childId=0;
  childLines.on('line',line=>{const message=JSON.parse(line);childPending.get(message.id)?.(message);});
  t.after(async()=>{child.kill();childLines.close();await exited;});
  const stockRpc=(method,params)=>new Promise((done,reject)=>{const next=++childId,timer=setTimeout(()=>reject(new Error('stock MCP timeout')),15000);childPending.set(next,message=>{clearTimeout(timer);childPending.delete(next);done(message);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  assert.ok((await stockRpc('initialize',{})).result);assert.equal((await stockRpc('tools/list',{})).result.tools.length,12);
  const stockResult=await stockRpc('tools/call',{name:'collaboration_projects',arguments:{deviceId:B.config.deviceId}});assert.equal(stockResult.result.isError,undefined);assert.equal(JSON.parse(stockResult.result.content[0].text).projects[0].projectId,B.project.projectId);
  child.stdin.end();assert.equal(await exited,0);
  const beforeRevoke=f.requests.length;f.store.revokeDevice(f.owner.id,A.config.deviceId);
  const revoked=transport(f.origin,{subject:A.config.deviceId,secret:A.config.deviceToken});t.after(()=>revoked.close());
  await assert.rejects(revoked.fetch(f.origin+'/api/hub/collaboration/devices',{headers:{authorization:'Bearer '+A.config.deviceToken}}),e=>e.code==='CLOCK_AUTH_FAILED');
  assert.equal(f.requests.slice(beforeRevoke).filter(r=>r.path!==CLOCK_PATH).length,0);
  records.push({case:'real Hub bilateral future TLS WSS/collaboration/settings/pairing/stock MCP',passed:true,wssConnections:2,creates:A.counts.creates+B.counts.creates,sends:A.counts.sends+B.counts.sends,deduplicated:true,lostResponseUnknownThenReceipt:true,stockMcpDefaultTransport:true,realPhysicalClockChange:false});
});
