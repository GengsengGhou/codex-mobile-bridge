// Synthetic status only: no local configuration, registry, network, or controllers.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const command=JSON.parse(input);
const state=readFileSync(new URL('./state.txt',import.meta.url),'utf8').trim();
const settingsRecord=new URL('./settings-request.json',import.meta.url);
const partialRecord=new URL('./partial-request.json',import.meta.url);
if(state==='partial-flow'&&command.action!=='status'){
  const previous=existsSync(partialRecord)?JSON.parse(readFileSync(partialRecord,'utf8')):{attempt:0};
  if(command.action==='validate-pairing')console.log(JSON.stringify({ok:true,origin:'https://preview.example',name:'工作电脑 · Studio',expiresAt:'2099-01-01T00:00:00Z'}));
  else if(command.action==='pair'){writeFileSync(partialRecord,JSON.stringify({paired:true,attempt:0}));console.log(JSON.stringify({ok:true,paired:true,paused:false,partialSuccess:true,state:'partial',warning:'设备已配对，但后台启动未完成，请重试连接。'}));}
  else if(command.action==='connect'){
    if(command.reason!=='manual')throw Error('Partial recovery must be an explicit manual connect');
    writeFileSync(partialRecord,JSON.stringify({...previous,attempt:previous.attempt+1,action:command.action,reason:command.reason}));
    console.log(JSON.stringify(previous.attempt===0?{ok:false,error:'后台暂时无法启动，请重试。'}:previous.attempt===1?{ok:true,paired:true,paused:true,state:'paused',recoveryCompleted:false}:{ok:true,paired:true,paused:false,state:'connecting',recoveryCompleted:true}));
  }else throw Error('Partial recovery fixture forbids disconnect or other actions');
  process.exit();
}
if(command.action==='autostart'&&state==='settings-failure'){
  const previous=existsSync(settingsRecord)?JSON.parse(readFileSync(settingsRecord,'utf8')):null;
  writeFileSync(settingsRecord,JSON.stringify({enabled:command.enabled,attempt:(previous?.attempt||0)+1}));
  if(!previous){await new Promise(resolve=>setTimeout(resolve,3500));console.log(JSON.stringify({ok:false,error:'无法保存登录启动设置，请重试。'}));}
  else console.log(JSON.stringify({ok:true,autoStart:command.enabled}));
  process.exit();
}
if(command.action!=='status')throw Error('Native QA only allows synthetic status or autostart');
const settings=existsSync(settingsRecord)?JSON.parse(readFileSync(settingsRecord,'utf8')):null;
if(state==='partial-flow'){const partial=existsSync(partialRecord)?JSON.parse(readFileSync(partialRecord,'utf8')):null;console.log(JSON.stringify({ok:true,paired:!!partial?.paired,paused:false,autoStart:true,state:'waiting',origin:'https://preview.example',deviceName:'工作电脑 · Studio',bridgeConnected:false}));process.exit();}
if(state==='error'){console.log(JSON.stringify({ok:false,error:'服务器暂时无法连接，请稍后重试。'}));process.exit();}
console.log(JSON.stringify({ok:true,paired:state!=='unpaired',paused:state==='paused',autoStart:settings?.attempt>1?settings.enabled:true,state:state==='settings-failure'?'online':state,origin:'https://preview.example',deviceId:'synthetic-device',deviceName:'工作电脑 · Studio',bridgeConnected:state==='online'}));
