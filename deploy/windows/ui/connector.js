'use strict';
(() => {
  let language = 'zh-CN';
  const dictionary = window.desktopTranslations;
  const t = text => language === 'en' ? dictionary[text] || text : text;
  function diagnostic(text) { if (!text) return ''; const entries=Object.entries(dictionary);for(const [zh,en] of entries)if(text===(language==='en'?zh:en))return language==='en'?en:zh;for(const [zh,en] of entries.filter(([zh])=>zh.includes('。')||zh.endsWith('：')).sort((a,b)=>(language==='en'?b[0].length-a[0].length:b[1].length-a[1].length))){const from=language==='en'?zh:en,to=language==='en'?en:zh;text=text.replaceAll(from,to);}return text; }
  const staticText = [], staticAttributes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const node = walker.currentNode, value = node.textContent.trim(); if (!node.parentElement.closest('input,option,#computerValue,#serverValue,#feedback,#installDirectory,#webviewVersion,#versionLabel') && dictionary[value]) staticText.push({node,value,prefix:node.textContent.slice(0,node.textContent.indexOf(value)),suffix:node.textContent.slice(node.textContent.indexOf(value)+value.length)}); }
  for (const element of document.querySelectorAll('[title],[aria-label]')) for (const attr of ['title','aria-label']) { const value = element.getAttribute(attr); if(dictionary[value]) staticAttributes.push({element,attr,value}); }
  function applyLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN'; document.documentElement.lang = language; for(const item of staticText)item.node.textContent=item.prefix+t(item.value)+item.suffix;for(const item of staticAttributes)item.element.setAttribute(item.attr,t(item.value));document.getElementById('language').value=language;render(); }
  const $ = id => document.getElementById(id);
  const native = window.chrome?.webview;
  const requests = new Map();
  let requestId = 0, status = null, settingsVisible = false, changingServer = false;
  let actionBusy = false, nativeBusy = false, mutationPending = 0, busyReason = '', statusError = '', actionError = '', warning = '', viewBeforeSettings = 'pairing';
  let serverTouched = false, nameTouched = false, defaultsApplied = false;
  let update = null, updateBusy = false, updateError = '';
  function updateDiagnostic(text) { return diagnostic(text)?.replace(/更新服务请求失败（HTTP (\d+)），请重试。/g,(_,code)=>language==='en'?`The update service returned HTTP ${code}. Try again.`:`更新服务请求失败（HTTP ${code}），请重试。`); }
  function renderUpdate() {
    $('currentVersion').textContent = update?.currentVersion ? 'v'+update.currentVersion : $('versionLabel').textContent;
    $('latestVersion').textContent = update?.latestVersion ? 'v'+update.latestVersion : '—';
    $('lastUpdateCheck').textContent = update?.lastCheckedAt ? new Date(update.lastCheckedAt).toLocaleString(language) : '—';
    $('automaticUpdates').checked = update?.automatic !== false;
    $('automaticUpdates').disabled = updateBusy;
    $('checkUpdate').disabled = updateBusy;
    $('downloadUpdate').hidden = !update?.available;
    $('updateNotice').hidden = !update?.available;
    $('downloadUpdate').disabled = updateBusy || actionBusy;
    $('updateMessage').textContent = updateDiagnostic(updateError || update?.error) || t(updateBusy ? '正在检查或下载更新…' : update?.available ? '发现新版本，可下载并升级。' : update?.status === 'current' ? '已是最新版本。' : '启动时及每天自动检查更新。');
  }
  async function updateAction(action,payload={}) { if(updateBusy)return; updateBusy=true;updateError='';renderUpdate();try{const result=await command(action,payload);if(result.update)update=result.update;}catch(error){updateError=error.message;}finally{updateBusy=false;renderUpdate();} }

  function command(action, payload = {}) {
    if (!native) return Promise.reject(new Error(t('请从 Windows 连接器打开此页面。')));
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      native.postMessage({ id, action, payload });
    });
  }
  function feedback(text, kind = 'error') {
    $('feedback').textContent = text || '';
    $('feedback').dataset.kind = kind;
    $('feedback').hidden = !text;
  }
  function description() {
    if (statusError) return t('连接状态读取失败');
    if (!status) return t('正在检查连接');
    if (status.paused) return t('连接已断开');
    if (warning) return t('已配对，启动未完成');
    if (status.state === 'stopping') return t('断开尚未确认');
    if (status.hubConnected && status.bridgeConnected) return t('已连接');
    if (status.hubState === 'connecting') return t('正在连接服务器');
    return t('等待连接');
  }
  function render() {
    renderUpdate();
    const paired = status?.paired === true;
    const pairing = !paired || changingServer;
    $('pairingView').hidden = settingsVisible || !pairing;
    $('connectionView').hidden = settingsVisible || pairing;
    $('settingsView').hidden = !settingsVisible;
    $('pairingHeading').textContent = changingServer ? t('更换服务器') : t('配对这台电脑');
    $('cancelPairing').hidden = !paired;
    $('pairButton').disabled = actionBusy;
    $('pairProgress').hidden = !actionBusy;
    $('pairProgress').textContent = busyReason === 'initialize' ? t('正在准备连接…') : t('正在配对…');
    $('openSetup').disabled = false;
    $('pasteCode').disabled = actionBusy;
    $('pasteInformation').disabled = actionBusy;
    $('connectButton').hidden = !status?.paused;
    $('disconnectButton').hidden = status?.paused === true;
    $('retryButton').hidden = status?.paused === true || (!warning && !statusError && status?.hubConnected && status?.bridgeConnected);
    $('connectButton').disabled = actionBusy;
    $('retryButton').disabled = actionBusy;
    $('autoStart').disabled = actionBusy;
    $('refreshStatus').hidden = !statusError;
    $('connectionHeading').textContent = description();
    $('connectionDescription').textContent = statusError ? '' : status?.paused ? t('已暂停自动连接') : status?.hubConnected && status?.bridgeConnected ? t('手机可通过网页访问这台电脑') : !status?.bridgeConnected ? t('等待本机 Codex 就绪') : t('等待服务器连接');
    $('stateMark').dataset.state = statusError ? 'error' : status?.hubConnected && status?.bridgeConnected ? 'online' : status?.state || 'waiting';
    $('stateIcon').src = '../icons/' + (statusError ? 'circle-alert' : status?.paused ? 'unplug' : status?.hubConnected && status?.bridgeConnected ? 'check' : 'plug') + '.svg';
    $('computerValue').textContent = status?.deviceName || '';
    $('serverValue').textContent = status?.origin || '';
    $('serverStatus').textContent = statusError ? t('读取失败') : status?.paused ? t('已断开') : status?.hubConnected ? t('已连接') : status?.hubState === 'connecting' ? t('正在连接') : t('等待连接');
    $('codexStatus').textContent = statusError ? t('读取失败') : status?.bridgeConnected ? t('已就绪') : t('未就绪');
    $('serverStatus').dataset.online = String(!statusError && !!status?.hubConnected);
    $('codexStatus').dataset.online = String(!statusError && !!status?.bridgeConnected);
    if (!actionBusy) $('autoStart').checked = status?.autoStart === true;
    $('startupSummary').textContent = t('Windows 登录后自动连接 · ') + (status?.autoStart ? t('已开启') : t('已关闭'));
    $('diagnosticState').textContent = diagnostic(statusError) || description();
    $('footerState').textContent = statusError ? t('状态读取失败') : paired ? description() : t('尚未配对');
    feedback(diagnostic(actionError || warning || statusError));
  }
  async function act(action, payload = {}) {
    const mutating = ['pair', 'connect', 'disconnect', 'autostart'].includes(action);
    if (mutating && actionBusy && action !== 'disconnect') return null;
    if (mutating) { mutationPending++; actionBusy = true; render(); }
    actionError = '';
    try { const result = await command(action, payload); return result; }
    catch (error) { actionError = error.message; render(); return null; }
    finally { if (mutating) { mutationPending--; actionBusy = nativeBusy || mutationPending > 0; render(); } }
  }
  function normalizedServer() {
    const value = $('server').value.trim();
    return value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^[a-z][a-z\d+.-]*:/i.test(value.replace(/:\d+\/?$/, '')) ? 'https://' + value : value;
  }
  $('language').addEventListener('change', async () => { const selected = $('language').value; try { const result = await command('set-language', { language: selected }); applyLanguage(result.language); } catch(error) { actionError=error.message; $('language').value=language; render(); } });
  $('server').addEventListener('input', () => { serverTouched = true; });
  $('deviceName').addEventListener('input', () => { nameTouched = true; });
  $('pairingForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (actionBusy || !$('pairingForm').reportValidity()) return;
    const result = await act('pair', { origin: normalizedServer(), name: $('deviceName').value.trim(), code: $('pairingCode').value });
    if (result?.paired && !result.superseded) {
      changingServer = false;
      $('pairingCode').value = '';
      warning = result.partialSuccess ? result.warning : '';
      render();
    }
  });
  $('openSetup').addEventListener('click', () => act('open-web', { origin: normalizedServer(), setup: true }));
  $('pasteCode').addEventListener('click', async () => {
    const result = await act('paste-code');
    if (result) { $('pairingCode').value = result.code; $('pairingCode').focus(); }
  });
  $('pasteInformation').addEventListener('click', async () => {
    const result = await act('paste-information');
    if (result) {
      $('server').value = result.origin; $('deviceName').value = result.name; $('pairingCode').value = result.code;
      serverTouched = nameTouched = true; $('pairingCode').focus();
    }
  });
  $('cancelPairing').addEventListener('click', () => { changingServer = false; render(); });
  $('settingsButton').addEventListener('click', () => {
    viewBeforeSettings = changingServer || !status?.paired ? 'pairing' : 'connection';
    settingsVisible = !settingsVisible; render();
  });
  $('backSettings').addEventListener('click', () => { settingsVisible = false; changingServer = status?.paired && viewBeforeSettings === 'pairing'; render(); });
  $('changeServer').addEventListener('click', () => { settingsVisible = false; changingServer = true; actionError = ''; render(); $('server').focus(); });
  async function connect() {
    const result = await act('connect');
    if (result?.recoveryCompleted === true && !result.paused && !result.superseded) { warning = ''; render(); }
  }
  $('connectButton').addEventListener('click', connect);
  $('retryButton').addEventListener('click', connect);
  $('disconnectButton').addEventListener('click', () => act('disconnect'));
  $('openHub').addEventListener('click', () => act('open-web', { origin: status?.origin || '', setup: false }));
  $('openCodex').addEventListener('click', () => act('open-codex'));
  $('autoStart').addEventListener('change', async () => { const enabled = $('autoStart').checked; await act('autostart', { enabled }); render(); });
  $('openFolder').addEventListener('click', () => act('open-folder'));
  $('uninstall').addEventListener('click', () => act('uninstall'));
  $('refreshStatus').addEventListener('click', () => act('status'));
  $('copyDiagnostics').addEventListener('click', async () => { const result = await act('diagnostics'); if (result) feedback(t('诊断信息已复制'), 'success'); });
  $('checkUpdate').addEventListener('click', () => updateAction('check-update',{manual:true}));
  $('updateNotice').addEventListener('click', () => { viewBeforeSettings=changingServer||!status?.paired?'pairing':'connection';settingsVisible=true;render();$('checkUpdate').focus(); });
  $('downloadUpdate').addEventListener('click', () => updateAction('download-update'));
  $('automaticUpdates').addEventListener('change', () => updateAction('update-preferences',{automatic:$('automaticUpdates').checked}));
  native?.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'result') {
      const request = requests.get(data.id); if (!request) return;
      requests.delete(data.id); data.ok ? request.resolve(data.result) : request.reject(new Error(data.error));
    } else if (data.type === 'status') {
      if (data.status) status = data.status;
      statusError = data.error || '';
      if (!defaultsApplied && status) {
        if (!serverTouched && status.origin) $('server').value = status.origin;
        if (!nameTouched && status.deviceName) $('deviceName').value = status.deviceName;
        defaultsApplied = true;
      }
      if (data.warning !== undefined) warning = data.warning || '';
      render();
    } else if (data.type === 'update') { if(data.update)update=data.update; updateError=data.error||'';renderUpdate(); }
    else if (data.type === 'busy') { nativeBusy = data.value; busyReason=data.reason; actionBusy = nativeBusy || mutationPending > 0; render(); }
  });
  command('ready').then(info => {
    applyLanguage(info.language);
    if (!nameTouched && !$('deviceName').value) $('deviceName').value = info.deviceName;
    $('installDirectory').textContent = info.root;
    $('webviewVersion').textContent = info.webviewVersion;
    $('versionLabel').textContent = 'v' + info.version;
    renderUpdate();
  }).catch(error => { actionError = error.message; render(); });
})();
