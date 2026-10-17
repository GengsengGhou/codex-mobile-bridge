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
  function applyLanguage(value) { language = value === 'en' ? 'en' : 'zh-CN'; document.documentElement.lang = language; for(const item of staticText)item.node.textContent=item.prefix+t(item.value)+item.suffix;for(const item of staticAttributes)item.element.setAttribute(item.attr,t(item.value));document.getElementById('language').value=language;render();renderCollaboration(); }
  const $ = id => document.getElementById(id);
  const native = window.chrome?.webview;
  const requests = new Map();
  let requestId = 0, status = null, settingsVisible = false, changingServer = false;
  let actionBusy = false, nativeBusy = false, mutationPending = 0, busyReason = '', statusError = '', actionError = '', warning = '', viewBeforeSettings = 'pairing';
  let serverTouched = false, nameTouched = false, defaultsApplied = false;
  let pairingTarget = null, importedPairingOrigin = null, pairingFlow = 0, pairingSourceMismatch = null;
  let update = null, updateBusy = false, nativeUpdateBusy = false, updateError = '';
  let collaboration = null, collaborationDirty = false, collaborationBusy = false, collaborationError = '', collaborationMessage = '';
  let collaborationDraft = { controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] };
  let collaborationGeneration = 0, collaborationRequest = 0;
  let collaborationSaving = false, resetResult = null;
  const binding = state => typeof state?.hubOrigin === 'string' && state.hubOrigin && typeof state?.deviceId === 'string' && state.deviceId ? { hubOrigin: state.hubOrigin, deviceId: state.deviceId } : null;
  const statusBinding = state => binding({ hubOrigin: state?.origin, deviceId: state?.deviceId });
  const bindingsDiffer = (a, b) => !!a && !!b && (a.hubOrigin !== b.hubOrigin || a.deviceId !== b.deviceId);
  function invalidateCollaboration() {
    collaborationGeneration++; collaborationRequest++; collaboration = null; collaborationDirty = false; collaborationBusy = false;
    collaborationDraft = { controlEnabled: false, receiveEnabled: false, allowedDeviceIds: [], allowedProjectRoots: [] };
    collaborationError = ''; collaborationMessage = t('配对身份已改变，请重新选择电脑协作权限后保存。');
    renderCollaboration();
    if (settingsVisible) refreshCollaboration({ preserveDraft: false });
  }
  function updateDiagnostic(text) { return diagnostic(text)?.replace(/更新服务请求失败（HTTP (\d+)），请重试。/g,(_,code)=>language==='en'?`The update service returned HTTP ${code}. Try again.`:`更新服务请求失败（HTTP ${code}），请重试。`); }
  function renderUpdate() {
    const updating = updateBusy || nativeUpdateBusy;
    $('currentVersion').textContent = update?.currentVersion ? 'v'+update.currentVersion : $('versionLabel').textContent;
    $('latestVersion').textContent = update?.latestVersion ? 'v'+update.latestVersion : '—';
    $('lastUpdateCheck').textContent = update?.lastCheckedAt ? new Date(update.lastCheckedAt).toLocaleString(language) : '—';
    $('automaticUpdates').checked = update?.automatic !== false;
    $('automaticUpdates').disabled = updating;
    $('checkUpdate').disabled = updating;
    $('downloadUpdate').hidden = !update?.available;
    $('updateNotice').hidden = !update?.available;
    $('downloadUpdate').disabled = updating || actionBusy;
    $('updateMessage').textContent = updating ? t('正在检查或下载更新…') : updateDiagnostic(updateError || update?.error) || t(update?.available ? '发现新版本，可下载并升级。' : update?.status === 'current' ? '已是最新版本。' : '启动时及每天自动检查更新。');
  }
  function renderCollaboration() {
    const state = collaboration;
    const busy = collaborationBusy || actionBusy;
    const paired = !!state && state.paired === true;
    const canGrant = paired && state.featureAvailable !== false && state.registration?.status !== 'recovering';
    const revokingOnly = paired && (state.controlEnabled && !collaborationDraft.controlEnabled || state.receiveEnabled && !collaborationDraft.receiveEnabled
      || collaborationDraft.allowedDeviceIds.length < (state.allowedDeviceIds || []).length
      || collaborationDraft.allowedProjectRoots.length < (state.allowedProjectRoots || []).length)
      && (!collaborationDraft.controlEnabled || state.controlEnabled === true)
      && (!collaborationDraft.receiveEnabled || state.receiveEnabled === true)
      && collaborationDraft.allowedDeviceIds.every(id => (state.allowedDeviceIds || []).includes(id))
      && collaborationDraft.allowedProjectRoots.every(path => (state.allowedProjectRoots || []).includes(path));
    const canSave = canGrant || revokingOnly;
    $('controlEnabled').checked = collaborationDraft.controlEnabled;
    $('receiveEnabled').checked = collaborationDraft.receiveEnabled;
    $('controlEnabled').disabled = busy || !paired || !canGrant && !(state.controlEnabled || collaborationDraft.controlEnabled);
    $('receiveEnabled').disabled = busy || !paired || !canGrant && !(state.receiveEnabled || collaborationDraft.receiveEnabled);
    $('saveCollaboration').disabled = busy || !canSave;
    $('collaborationDevices').closest('.collaboration-group').hidden = !collaborationDraft.receiveEnabled;
    $('collaborationProjects').closest('.collaboration-group').hidden = !collaborationDraft.receiveEnabled;
    $('collaborationSummary').textContent = !state ? t('正在读取电脑协作设置…')
      : state.paired !== true ? t('需要先配对这台电脑，才能设置电脑协作。')
      : collaborationError ? diagnostic(collaborationError)
      : state.registration?.status === 'recovering' ? t('已配对；协作注册正在恢复，请稍后刷新。')
      : state.registration?.status === 'error' ? diagnostic(state.registration?.message || state.error) || t('电脑协作当前不可用，请检查配对状态后重试。')
      : state.featureAvailable === false ? diagnostic(state.error) || t('电脑协作当前不可用，请检查配对状态后重试。')
      : state.error ? diagnostic(state.error)
      : state.registration?.status === 'registered' || state.registration?.status === 'ready' ? t(state.registration?.restartCodexRequired ? '协作连接已修复。请完全退出并重新打开 Codex，配对和授权已保留。' : '电脑协作配置已注册。Codex 工具连接状态尚未验证；若显示 Transport closed，请复制诊断信息。')
      : diagnostic(state.registration?.message) || '';
    const drawOptions = (container, items, key, selected, emptyText) => {
      container.replaceChildren();
      if (!Array.isArray(items) || items.length === 0) {
        const empty = document.createElement('div'); empty.className = 'collaboration-empty'; empty.textContent = t(emptyText); container.append(empty); return;
      }
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || !item.id) continue;
        if (key === 'allowedDeviceIds' && status?.deviceId && item.id === status.deviceId) continue;
        const selection = key === 'allowedProjectRoots' ? item.cwd : item.id;
        if (typeof selection !== 'string' || !selection) continue;
        const label = document.createElement('label'); label.className = 'collaboration-option';
        const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id;
        input.checked = selected.includes(selection); input.disabled = busy || !canGrant;
        input.addEventListener('change', () => {
          const current = new Set(collaborationDraft[key]);
          input.checked ? current.add(selection) : current.delete(selection);
          collaborationDraft[key] = [...current]; collaborationDirty = true; collaborationMessage = ''; renderCollaboration();
        });
        const text = document.createElement('span'); text.textContent = item.name || item.cwd || item.id;
        if (key === 'allowedDeviceIds') {
          const detail = document.createElement('small'); detail.textContent = t(item.online === true ? '已在线' : '离线'); text.append(detail);
        }
        label.append(input, text); container.append(label);
      }
    };
    drawOptions($('collaborationDevices'), state?.devices, 'allowedDeviceIds', collaborationDraft.allowedDeviceIds, '目前没有可用的同账号电脑。');
    drawOptions($('collaborationProjects'), state?.projects, 'allowedProjectRoots', collaborationDraft.allowedProjectRoots, '没有可授权的本机项目。');
    $('collaborationMessage').textContent = diagnostic(collaborationError || collaborationMessage) || '';
    $('collaborationMessage').dataset.kind = collaborationError ? 'error' : collaborationMessage ? 'success' : '';
  }
  function acceptCollaborationState(result, { preserveDraft = collaborationDirty } = {}) {
    const received = result?.collaboration || result;
    if (!received || typeof received !== 'object') throw new Error(t('电脑协作设置无法读取，请重试。'));
    if (status?.paired === false && received.paired !== false || bindingsDiffer(binding(received), statusBinding(status))) throw new Error(t('配对身份已改变，请重新选择电脑协作权限后保存。'));
    const next = { ...received };
    const sameBinding = collaboration && collaboration.deviceId === next.deviceId && collaboration.hubOrigin === next.hubOrigin;
    if (sameBinding) {
      if (next.projectsAvailable === false) next.projects = collaboration.projects;
      if (next.devicesAvailable === false) next.devices = collaboration.devices;
    }
    if (collaboration && (collaboration.deviceId !== next.deviceId || collaboration.hubOrigin !== next.hubOrigin || next.requiresAuthorization && !collaboration.requiresAuthorization)) {
      preserveDraft = false;
      collaborationMessage = '';
    }
    collaboration = next;
    if (!preserveDraft) {
      collaborationDraft = {
        controlEnabled: next.controlEnabled === true,
        receiveEnabled: next.receiveEnabled === true,
        allowedDeviceIds: Array.isArray(next.allowedDeviceIds) ? [...next.allowedDeviceIds] : [],
        allowedProjectRoots: Array.isArray(next.allowedProjectRoots) ? [...next.allowedProjectRoots] : []
      };
      collaborationDirty = false;
    }
    const before = collaborationDraft.allowedDeviceIds.length + collaborationDraft.allowedProjectRoots.length;
    if (next.devicesAvailable === true) collaborationDraft.allowedDeviceIds = collaborationDraft.allowedDeviceIds.filter(id => next.devices.some(device => device.id === id));
    if (next.projectsAvailable === true) collaborationDraft.allowedProjectRoots = collaborationDraft.allowedProjectRoots.filter(path => next.projects.some(project => project.cwd === path));
    if (before !== collaborationDraft.allowedDeviceIds.length + collaborationDraft.allowedProjectRoots.length) {
      collaborationDirty = true;
      collaborationError = t('所选电脑或项目已改变，请刷新后重新选择。');
    }
    renderCollaboration();
  }
  async function refreshCollaboration({ preserveDraft = collaborationDirty } = {}) {
    const generation = collaborationGeneration, request = ++collaborationRequest;
    collaborationBusy = !collaboration; collaborationError = ''; renderCollaboration();
    try { const result = await command('get-collaboration-state'); if (generation === collaborationGeneration && request === collaborationRequest) acceptCollaborationState(result, { preserveDraft }); }
    catch (error) { if (generation === collaborationGeneration && request === collaborationRequest) collaborationError = error.message; }
    finally { if (generation === collaborationGeneration && request === collaborationRequest) { collaborationBusy = false; renderCollaboration(); } }
  }
  async function saveCollaboration() {
    if (collaborationBusy || actionBusy || !collaboration || status?.paired === false || bindingsDiffer(binding(collaboration), statusBinding(status))) return;
    const generation = collaborationGeneration, request = ++collaborationRequest, expected = binding(collaboration);
    const deviceIds = new Set((collaboration?.devices || []).filter(device => device?.id && device.id !== status?.deviceId).map(device => device.id));
    const projectRoots = new Set((collaboration?.projects || []).filter(project => project?.cwd).map(project => project.cwd));
    const needsFreshAllowlist = collaborationDraft.receiveEnabled && (!collaboration.receiveEnabled
      || collaborationDraft.allowedDeviceIds.some(id => !(collaboration.allowedDeviceIds || []).includes(id))
      || collaborationDraft.allowedProjectRoots.some(path => !(collaboration.allowedProjectRoots || []).includes(path)));
    if (needsFreshAllowlist && (!collaborationDraft.allowedDeviceIds.some(id => deviceIds.has(id)) || !collaborationDraft.allowedProjectRoots.some(path => projectRoots.has(path)))) {
      collaborationError = ''; collaborationMessage = t('启用接收前，请至少选择一台电脑和一个本机项目。'); renderCollaboration(); return;
    }
    collaborationBusy = true; collaborationSaving = true; collaborationError = ''; collaborationMessage = ''; render();
    let saved = false;
    try {
      const result = await command('save-collaboration', {
        controlEnabled: collaborationDraft.controlEnabled,
        receiveEnabled: collaborationDraft.receiveEnabled,
        allowedDeviceIds: [...collaborationDraft.allowedDeviceIds],
        allowedProjectRoots: [...collaborationDraft.allowedProjectRoots],
        ...(expected ? { expectedHubOrigin: expected.hubOrigin, expectedDeviceId: expected.deviceId } : {})
      });
      if (generation !== collaborationGeneration || request !== collaborationRequest) return;
      acceptCollaborationState(result, { preserveDraft: false });
      collaborationMessage = t('电脑协作设置已保存。'); saved = true;
    } catch (error) { if (generation === collaborationGeneration && request === collaborationRequest) collaborationError = error.message; }
    finally { collaborationSaving = false; if (generation === collaborationGeneration && request === collaborationRequest) collaborationBusy = false; render(); }
    if (saved) await refreshCollaboration({ preserveDraft: collaborationDirty });
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
  const certificateDateCodes = new Set(['CERT_NOT_YET_VALID', 'CERT_HAS_EXPIRED']);
  function certificateDateFailure(state) {
    return state?.networkError?.category === 'TLS_DATE'
      && Array.isArray(state.networkError.codes)
      && state.networkError.codes.some(code => certificateDateCodes.has(code));
  }
  function certificateDateGuidanceVisible() {
    return !!status && !statusError && !status.paused && !warning && status.state !== 'stopping'
      && !status.lastError && status.hubConnected !== true && certificateDateFailure(status);
  }
  const certificateDateGuidance = '服务器证书有效日期校验失败。请先在 Windows“设置 → 时间和语言 → 日期和时间”中开启自动设置时间并点击“立即同步”。若日期和时间已正确但仍失败，请联系服务器管理员检查证书。';
  function clockCompatibilityGuidance(state = status) {
    const codes = state?.networkError?.codes;
    if (state?.networkError?.category !== 'CLOCK' || !Array.isArray(codes)) return '';
    if (codes.includes('CLOCK_UNSUPPORTED')) return t('服务器尚未支持时钟兼容连接。请由管理员更新 Hub，或恢复正确系统时间后连接。');
    if (codes.some(code => ['CLOCK_AUTH_FAILED', 'CLOCK_BUSY'].includes(code))) return t('无法验证服务器时间。请检查当前配对、服务器升级和网络连接。');
    if (codes.some(code => ['CLOCK_CERTIFICATE_INVALID', 'CLOCK_VALIDATION_UNAVAILABLE'].includes(code))) return t('服务器证书未通过可信时间校验。请联系服务器管理员检查证书与域名。');
    return '';
  }
  function connectionMessage() {
    if (statusError) return '';
    if (status?.paused) return t('已暂停自动连接');
    if (warning || status?.state === 'stopping') return '';
    if (status?.hubConnected && status?.bridgeConnected) return t('手机可通过网页访问这台电脑');
    if (status?.lastError) return diagnostic(status.lastError);
    if (clockCompatibilityGuidance()) return clockCompatibilityGuidance();
    if (certificateDateGuidanceVisible()) return t(certificateDateGuidance);
    return !status?.bridgeConnected ? t('等待本机 Codex 就绪') : t('等待服务器连接');
  }
  function render() {
    renderUpdate();
    renderCollaboration();
    $('resetCollaborationPairing').disabled = actionBusy || collaborationSaving;
    $('resetOutcome').hidden = !resetResult;
    $('resetOutcome').dataset.kind = resetResult?.completed === true && resetResult?.partialFailure !== true ? 'success' : 'error';
    $('resetMessage').textContent = !resetResult ? '' : t(resetResult.completed === true && resetResult.partialFailure !== true ? '本机配对与电脑协作已重置。请重新配对并明确选择授权。' : '重置未完全完成。已保留无法安全处理的内容；请复制诊断信息并检查 Codex 设置后重试。');
    $('resetRegistrationNotice').hidden = resetResult?.registrationPreserved !== true;
    $('openPreviousDevices').hidden = !pairingOrigin(resetResult?.previousHubOrigin || '');
    $('openPreviousDevices').disabled = actionBusy;
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
    $('connectionDescription').textContent = connectionMessage();
    $('stateMark').dataset.state = statusError ? 'error' : status?.hubConnected && status?.bridgeConnected ? 'online' : status?.state || 'waiting';
    $('stateIcon').src = '../icons/' + (statusError ? 'circle-alert' : status?.paused ? 'unplug' : status?.hubConnected && status?.bridgeConnected ? 'check' : 'plug') + '.svg';
    $('computerValue').textContent = status?.deviceName || '';
    $('serverValue').textContent = status?.origin || '';
    const clockVerified = status?.clockCompatible === true && status?.hubConnected === true && status?.paused !== true && !statusError;
    $('serverStatus').textContent = statusError ? t('读取失败') : status?.paused ? t('已断开') : status?.hubConnected ? t(clockVerified ? '已连接 · 时钟兼容已验证' : '已连接') : status?.hubState === 'connecting' ? t('正在连接服务器') : t('等待连接');
    $('codexStatus').textContent = statusError ? t('读取失败') : status?.bridgeConnected ? t('已就绪') : t('未就绪');
    $('serverStatus').dataset.online = String(!statusError && !!status?.hubConnected);
    $('codexStatus').dataset.online = String(!statusError && !!status?.bridgeConnected);
    if (!actionBusy) $('autoStart').checked = status?.autoStart === true;
    $('startupSummary').textContent = t('Windows 登录后自动连接 · ') + (status?.autoStart ? t('已开启') : t('已关闭'));
    $('diagnosticState').textContent = diagnostic(statusError) || (status?.lastError && !status?.paused && !(status?.hubConnected && status?.bridgeConnected) && !warning && status?.state !== 'stopping' ? diagnostic(status.lastError) : '') || clockCompatibilityGuidance() || (certificateDateGuidanceVisible() ? t(certificateDateGuidance) : '') || description();
    $('footerState').textContent = statusError ? t('状态读取失败') : paired ? description() : t('尚未配对');
    feedback(pairingSourceMismatch ? t('配对信息来自 {source}，与当前选择的服务器 {target} 不一致。请在目标服务器重新生成配对信息。').replace('{source}', () => pairingSourceMismatch.source).replace('{target}', () => pairingSourceMismatch.target) : diagnostic(actionError || warning || statusError));
  }
  async function act(action, payload = {}) {
    const mutating = ['pair', 'connect', 'disconnect', 'autostart', 'reset-collaboration-pairing'].includes(action);
    if (mutating && actionBusy && action !== 'disconnect') return null;
    if (mutating) { mutationPending++; actionBusy = true; render(); }
    actionError = '';
    pairingSourceMismatch = null;
    try { const result = await command(action, payload); return result; }
    catch (error) { actionError = error.message; render(); return null; }
    finally { if (mutating) { mutationPending--; actionBusy = nativeBusy || mutationPending > 0; render(); } }
  }
  function normalizedServer() {
    const value = $('server').value.trim();
    return value && !/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^[a-z][a-z\d+.-]*:/i.test(value.replace(/:\d+\/?$/, '')) ? 'https://' + value : value;
  }
  function pairingOrigin(value) {
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null; }
    catch { return null; }
  }
  $('language').addEventListener('change', async () => { const selected = $('language').value; try { const result = await command('set-language', { language: selected }); applyLanguage(result.language); } catch(error) { actionError=error.message; $('language').value=language; render(); } });
  $('server').addEventListener('input', () => {
    serverTouched = true; pairingTarget = pairingOrigin(normalizedServer());
    pairingSourceMismatch = null;
    if (importedPairingOrigin && importedPairingOrigin !== pairingTarget) { $('pairingCode').value = ''; importedPairingOrigin = null; }
  });
  $('deviceName').addEventListener('input', () => { nameTouched = true; });
  $('pairingForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (actionBusy || !$('pairingForm').reportValidity()) return;
    const result = await act('pair', { origin: normalizedServer(), name: $('deviceName').value.trim(), code: $('pairingCode').value });
    if (result?.paired && !result.superseded) {
      changingServer = false;
      pairingTarget = importedPairingOrigin = null; pairingFlow++;
      $('pairingCode').value = '';
      warning = result.partialSuccess ? result.warning : '';
      render();
    }
  });
  $('openSetup').addEventListener('click', () => { pairingTarget = pairingOrigin(normalizedServer()); act('open-web', { origin: normalizedServer(), setup: true }); });
  $('pasteCode').addEventListener('click', async () => {
    const result = await act('paste-code');
    if (result) { $('pairingCode').value = result.code; importedPairingOrigin = null; $('pairingCode').focus(); }
  });
  $('pasteInformation').addEventListener('click', async () => {
    const flow = pairingFlow;
    const result = await act('paste-information');
    if (result && flow === pairingFlow) {
      if (pairingTarget && pairingOrigin(result.origin) !== pairingTarget) {
        $('pairingCode').value = ''; importedPairingOrigin = null;
        pairingSourceMismatch = { source: result.origin, target: pairingTarget };
        render(); return;
      }
      $('server').value = result.origin; $('deviceName').value = result.name; $('pairingCode').value = result.code;
      importedPairingOrigin = pairingOrigin(result.origin);
      serverTouched = nameTouched = true; $('pairingCode').focus();
    }
  });
  $('cancelPairing').addEventListener('click', () => { changingServer = false; pairingTarget = importedPairingOrigin = pairingSourceMismatch = null; pairingFlow++; render(); });
  $('settingsButton').addEventListener('click', () => {
    viewBeforeSettings = changingServer || !status?.paired ? 'pairing' : 'connection';
    settingsVisible = !settingsVisible; render(); if (settingsVisible) refreshCollaboration();
  });
  $('backSettings').addEventListener('click', () => { settingsVisible = false; changingServer = status?.paired && viewBeforeSettings === 'pairing'; render(); });
  $('changeServer').addEventListener('click', () => { settingsVisible = false; changingServer = true; pairingTarget = importedPairingOrigin = pairingSourceMismatch = null; pairingFlow++; actionError = ''; render(); $('server').focus(); });
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
  $('resetCollaborationPairing').addEventListener('click', async () => {
    if (actionBusy || collaborationSaving) return;
    const expected = statusBinding(status);
    const validExpected = expected && pairingOrigin(expected.hubOrigin) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.deviceId);
    const result = await act('reset-collaboration-pairing', { confirm: true, ...(validExpected ? { expectedHubOrigin: expected.hubOrigin, expectedDeviceId: expected.deviceId } : {}) });
    if (!result?.reset || result.cancelled || result.superseded) return;
    resetResult = result.reset;
    if (resetResult.pairingCleared === true) { status = { paired: false, paused: true, autoStart: status?.autoStart === true }; statusError = ''; warning = ''; }
    changingServer = false; pairingTarget = importedPairingOrigin = pairingSourceMismatch = null; pairingFlow++; $('pairingCode').value = '';
    if (resetResult.completed === true && resetResult.partialFailure !== true) settingsVisible = false;
    invalidateCollaboration(); render();
  });
  $('openPreviousDevices').addEventListener('click', () => { if (pairingOrigin(resetResult?.previousHubOrigin || '')) act('open-device-management', { origin: resetResult.previousHubOrigin }); });
  $('refreshStatus').addEventListener('click', () => act('status'));
  $('copyDiagnostics').addEventListener('click', async () => { const result = await act('diagnostics'); if (result) feedback(t('诊断信息已复制'), 'success'); });
  $('checkUpdate').addEventListener('click', () => updateAction('check-update',{manual:true}));
  $('updateNotice').addEventListener('click', () => { viewBeforeSettings=changingServer||!status?.paired?'pairing':'connection';settingsVisible=true;render();$('checkUpdate').focus(); });
  $('downloadUpdate').addEventListener('click', () => updateAction('download-update'));
  $('automaticUpdates').addEventListener('change', () => updateAction('update-preferences',{automatic:$('automaticUpdates').checked}));
  $('controlEnabled').addEventListener('change', () => { collaborationDraft.controlEnabled = $('controlEnabled').checked; collaborationDirty = true; collaborationMessage = ''; renderCollaboration(); });
  $('receiveEnabled').addEventListener('change', () => { collaborationDraft.receiveEnabled = $('receiveEnabled').checked; collaborationDirty = true; collaborationMessage = ''; renderCollaboration(); });
  $('saveCollaboration').addEventListener('click', saveCollaboration);
  native?.addEventListener('message', event => {
    const data = event.data;
    if (data.type === 'result') {
      const request = requests.get(data.id); if (!request) return;
      requests.delete(data.id); data.ok ? request.resolve(data.result) : request.reject(new Error(data.error));
    } else if (data.type === 'status') {
      const previousBinding = statusBinding(status);
      if (data.status) status = data.status;
      if (data.status && (status.paired === false && (collaboration || previousBinding) || bindingsDiffer(previousBinding, statusBinding(status)) || bindingsDiffer(binding(collaboration), statusBinding(status)))) invalidateCollaboration();
      statusError = data.error || '';
      if (!defaultsApplied && status) {
        if (!serverTouched && status.origin) $('server').value = status.origin;
        if (!nameTouched && status.deviceName) $('deviceName').value = status.deviceName;
        defaultsApplied = true;
      }
      if (data.warning !== undefined) warning = data.warning || '';
      render();
    } else if (data.type === 'update') { if(data.update)update=data.update; if(typeof data.checking==='boolean')nativeUpdateBusy=data.checking;updateError=data.error||'';renderUpdate(); }
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
