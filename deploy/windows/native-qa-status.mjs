// Isolated synthetic commands: no registry, credentials, network or controllers.
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const command = JSON.parse(input);
const file = name => new URL('./' + name, import.meta.url);
let state = readFileSync(file('state.txt'), 'utf8').trim();
const saved = existsSync(file('fixture.json')) ? JSON.parse(readFileSync(file('fixture.json'), 'utf8')) : {};
appendFileSync(file('requests.jsonl'), JSON.stringify({ action: command.action, reason: command.reason, enabled: command.enabled, startedAt: Date.now() }) + '\n');
const answer = result => console.log(JSON.stringify({ ok: true, ...result }));
if (command.action === 'initialize') { if(state==='slow-initialize')await new Promise(resolve=>setTimeout(resolve,8000));answer({ paused: state === 'paused' }); }
else if (command.action === 'validate-pairing') {
  const ticket = JSON.parse(command.information);
  if (ticket.type !== 'codex-mobile-pairing' || !/^[A-Za-z0-9_-]{43}$/.test(ticket.code)) answer({ ok: false, error: '配对信息无效。' });
  else answer({ origin: ticket.server, name: ticket.name, expiresAt: ticket.expiresAt });
} else if (command.action === 'pair') {
  if (state === 'pair-failure') answer({ ok: false, error: '配对码已失效，请重新生成。' });
  else {
    if (state.startsWith('slow')) await new Promise(resolve => setTimeout(resolve, 5000));
    writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, paired: true, origin: command.origin, deviceName: command.name, attempt: 0 }));
    answer({ paired: true, paused: false, partialSuccess: state === 'partial-flow', recoveryCompleted: state !== 'partial-flow', ...(state === 'partial-flow' ? { warning: '设备已配对，但后台启动未完成，请重试连接。' } : {}) });
  }
} else if (command.action === 'connect') {
  if (state === 'partial-flow') {
    const attempt = (saved.attempt || 0) + 1;
    writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, attempt }));
    if (attempt === 1) answer({ ok: false, error: '后台暂时无法启动，请重试。' });
    else if (attempt === 2) answer({ paired: true, paused: true, recoveryCompleted: false });
    else answer({ paired: true, paused: false, recoveryCompleted: true });
  } else { writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, paused: false })); answer({ paired: true, paused: false, recoveryCompleted: true }); }
} else if (command.action === 'disconnect' || command.action === 'quit') {
  writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, paused: true }));
  answer({ paused: true, disconnectVerified: true });
} else if (command.action === 'autostart') {
  if (state === 'settings-failure' && !saved.settingsAttempt) {
    await new Promise(resolve => setTimeout(resolve, 4500));
    writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, settingsAttempt: 1 }));
    answer({ ok: false, error: '无法保存登录启动设置，请重试。' });
  } else { writeFileSync(file('fixture.json'), JSON.stringify({ ...saved, autoStart: command.enabled, settingsAttempt: (saved.settingsAttempt || 0) + 1 })); answer({ autoStart: command.enabled }); }
} else if (command.action === 'status') {
  if (state.startsWith('slow')) await new Promise(resolve => setTimeout(resolve, 8000));
  if (state === 'error') answer({ ok: false, error: '服务器暂时无法连接，请稍后重试。' });
  else {
    const unpaired = ['unpaired', 'slow-unpaired', 'slow-initialize', 'partial-flow'].includes(state) && !saved.paired;
    const paused = saved.paused ?? state === 'paused';
    const online = ['online', 'settings-failure', 'hub-only'].includes(state);
    answer({ paired: !unpaired, paused, autoStart: saved.autoStart ?? true, state: paused ? 'paused' : online ? 'online' : state === 'connecting' ? 'connecting' : 'waiting', hubState: paused ? 'paused' : online ? 'online' : state === 'connecting' ? 'connecting' : 'waiting', hubConnected: !paused && online, origin: saved.origin || 'https://preview.example', deviceId: 'synthetic-device', deviceName: saved.deviceName || '工作电脑 · Studio', bridgeConnected: online && state !== 'hub-only', pauseScope: paused ? 'persistent' : 'none' });
  }
} else answer({ ok: false, error: 'Synthetic fixture rejected action.' });
