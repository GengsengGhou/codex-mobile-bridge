export function createRecoveryPanel({ document: doc, api }) {
  const make = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
  const css = make('link'); css.rel = 'stylesheet'; css.href = './recovery.css'; doc.head.append(css);
  const open = make('button', 'text-button', '运行与恢复'); open.type = 'button'; open.id = 'recoveryButton'; doc.querySelector('.drawer-foot').append(open);
  const panel = make('dialog', 'recovery-panel'); panel.id = 'recoveryPanel'; panel.setAttribute('aria-labelledby', 'recoveryTitle');
  const heading = make('div', 'recovery-heading'), title = make('h2', '', '运行与恢复'); title.id = 'recoveryTitle';
  const close = make('button', '', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭运行与恢复'); heading.append(title, close);
  const feedback = make('p', 'recovery-feedback'); feedback.setAttribute('role', 'status');
  const status = make('dl', 'recovery-status');
  const toggles = {};
  const settings = make('div', 'recovery-settings');
  for (const [key, labelText, help] of [
    ['autoStart', 'Windows 登录后启动桥接', '仅当前 Windows 用户登录后启动。'],
    ['autoRestart', '桥接退出后自动恢复', '需由守护进程运行。仅恢复桥接进程；不会启动或重启 Codex，也不会重试聊天消息。']
  ]) {
    const row = make('label', 'recovery-setting'), input = make('input'); input.type = 'checkbox'; input.id = `recovery-${key}`;
    const copy = make('span', 'recovery-copy'); copy.append(make('strong', '', labelText), make('span', '', help)); row.append(input, copy); settings.append(row); toggles[key] = input;
    input.addEventListener('change', () => void save(key, input.checked));
  }
  const conditions = make('p', 'recovery-feedback', '使用时需已登录 Windows、电脑保持唤醒，且 Codex 桌面端正在运行。不支持登录前启动或唤醒电脑。');
  const refresh = make('button', '', '刷新状态'); refresh.type = 'button'; panel.append(heading, feedback, status, settings, conditions, refresh); doc.body.append(panel);
  let snapshot = null, busy = false, generation = 0;
  const bounded = value => String(value ?? '').slice(0, 600);
  function validate(value) {
    if (!value || typeof value.supported !== 'boolean' || typeof value.autoStart !== 'boolean' || typeof value.autoRestart !== 'boolean' || typeof value.supervisorRunning !== 'boolean' || typeof value.state !== 'string') throw new Error('运行状态返回不完整');
    return value;
  }
  function render() {
    for (const [key, input] of Object.entries(toggles)) { input.disabled = busy || !snapshot?.supported; input.checked = snapshot ? snapshot[key] : false; input.indeterminate = !snapshot; }
    refresh.disabled = busy;
    status.replaceChildren();
    if (!snapshot) { status.append(make('dt', '', '运行状态'), make('dd', '', '尚未确认')); return; }
    const states = { running: '运行中', waiting: '等待恢复', stopped: '已停止', error: '运行异常', unmanaged: '未由守护进程管理' };
    const entries = [
      ['平台', snapshot.supported ? '支持 Windows 登录启动' : '当前平台不支持恢复设置'],
      ['守护进程', snapshot.supervisorRunning ? '运行中' : '未运行'],
      ['桥接状态', states[snapshot.state] || bounded(snapshot.state)],
      ['恢复次数', Number.isSafeInteger(snapshot.restartCount) ? String(snapshot.restartCount) : '未知'],
      ['最近恢复', snapshot.lastRestartAt ? bounded(snapshot.lastRestartAt) : '无记录']
    ];
    if (snapshot.restartRequired) entries.push(['设置生效', '需要重新启动桥接守护进程']);
    if (snapshot.lastError) entries.push(['最近错误', bounded(snapshot.lastError)]);
    for (const [label, value] of entries) status.append(make('dt', '', label), make('dd', '', value));
  }
  async function load() {
    if (busy) return;
    const token = generation; busy = true; snapshot = null; feedback.textContent = '正在读取运行状态…'; render();
    try {
      const result = validate(await api('/api/recovery'));
      if (token === generation && panel.open) { snapshot = result; feedback.textContent = result.supported ? '' : '当前平台只可查看状态。'; }
    } catch (error) { if (token === generation && panel.open) feedback.textContent = `无法确认运行状态：${bounded(error.message || '连接中断')}。请刷新状态。`; }
    finally {
      busy = false;
      if (token === generation) render();
      else if (panel.open) void load();
    }
  }
  async function save(key, value) {
    if (busy || !snapshot?.supported) { render(); return; }
    busy = true; snapshot = null; feedback.textContent = '正在保存设置…'; render();
    try {
      snapshot = validate(await api('/api/recovery', { method: 'PUT', body: JSON.stringify({ [key]: value }) }));
      feedback.textContent = '设置已保存。';
    } catch (error) {
      feedback.textContent = '保存结果尚未确认，正在核对当前设置…';
      // A lost response may follow a successful mutation. Reconcile without repeating PUT.
      try {
        snapshot = validate(await api('/api/recovery'));
        feedback.textContent = snapshot[key] === value
          ? '已核对，设置已生效。'
          : `设置未生效：${bounded(error.message || '连接中断')}。已核对当前设置，可重新操作。`;
      }
      catch { snapshot = null; feedback.textContent = `保存结果尚未确认：${bounded(error.message || '连接中断')}。请刷新状态后再操作。`; }
    } finally { busy = false; render(); }
  }
  function invalidate() { generation++; snapshot = null; render(); }
  function hide() { invalidate(); if (panel.open) panel.close(); }
  open.addEventListener('click', () => { if (!panel.open) { panel.showModal(); generation++; } render(); if (!busy) void load(); });
  close.addEventListener('click', hide); panel.addEventListener('cancel', invalidate);
  refresh.addEventListener('click', () => void load()); render();
  return { close: hide };
}
