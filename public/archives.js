export function createArchivesPanel({ document: doc, window: win, api, onRestored = () => {} }) {
  const make = (tag, className, text) => { const el = doc.createElement(tag); if (className) el.className = className; if (text) el.textContent = text; return el; };
  const css = make('link'); css.rel = 'stylesheet'; css.href = './archives.css'; doc.head.append(css);
  const open = make('button', 'text-button', '归档会话'); open.type = 'button'; open.id = 'archivesButton';
  doc.querySelector('.drawer-foot').append(open);
  const panel = make('dialog', 'archives-panel'); panel.id = 'archivesPanel'; panel.setAttribute('aria-labelledby', 'archivesTitle');
  const heading = make('div', 'archives-heading'), title = make('h2', '', '归档会话'); title.id = 'archivesTitle';
  const close = make('button', '', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭归档会话');
  heading.append(title, close);
  const feedback = make('p', 'archives-feedback'); feedback.setAttribute('role', 'status');
  const list = make('div', 'archives-list');
  const footer = make('div', 'archives-footer'), refresh = make('button', '', '刷新'), more = make('button', '', '加载更多');
  refresh.type = more.type = 'button'; footer.append(refresh, more); panel.append(heading, feedback, list, footer); doc.body.append(panel);
  let generation = 0, loading = false, cursor = null, rows = new Map(), action = null, restoring = false, notice = '';
  const uncertain = new Set();
  function controls() { refresh.disabled = loading || restoring; more.hidden = !cursor; more.disabled = loading || restoring; }
  function render() {
    list.replaceChildren();
    for (const thread of rows.values()) {
      const row = make('article', 'archive-row'); row.dataset.threadId = thread.id;
      const copy = make('div', 'archive-copy'); copy.append(make('strong', '', thread.title), make('span', '', thread.cwd)); row.append(copy);
      if (!thread.canRestore) row.append(make('span', 'archive-readonly', '当前范围只读'));
      else if (uncertain.has(thread.id)) row.append(make('span', 'archive-readonly', '结果待核对，请刷新列表'));
      else {
        const button = make('button', '', action === thread.id ? '确认恢复' : '恢复'); button.type = 'button'; button.disabled = restoring;
        button.addEventListener('click', () => {
          if (action !== thread.id) { action = thread.id; feedback.textContent = `恢复“${thread.title}”到会话列表？`; render(); return; }
          void restore(thread);
        }); row.append(button);
      }
      list.append(row);
    }
    controls();
  }
  async function load(append = false) {
    if (loading || restoring) return;
    const token = ++generation, next = append ? cursor : null;
    loading = true; action = null; feedback.textContent = '正在读取归档会话…'; controls();
    try {
      const result = await api(`/api/archives${next ? `?cursor=${encodeURIComponent(next)}` : ''}`);
      if (token !== generation || !panel.open) return;
      if (!append) { rows = new Map(); uncertain.clear(); }
      for (const thread of result.threads) rows.set(thread.id, thread);
      cursor = result.nextCursor && result.nextCursor !== next ? result.nextCursor : null;
      feedback.textContent = notice || (rows.size ? '恢复后可在会话列表继续。' : '没有已归档会话。'); notice = '';
      render();
    } catch (error) { if (token === generation && panel.open) feedback.textContent = error.message || '无法读取归档会话，请重试。'; }
    finally { if (token === generation) { loading = false; controls(); } }
  }
  async function restore(thread) {
    if (restoring || uncertain.has(thread.id)) return;
    restoring = true; uncertain.add(thread.id); feedback.textContent = `正在恢复“${thread.title}”…`; render();
    try {
      const result = await api(`/api/archives/${encodeURIComponent(thread.id)}/restore`, { method: 'POST' });
      if (result.accepted !== true || result.threadId !== thread.id || result.archived !== false) throw new Error('恢复结果尚未确认');
      rows.delete(thread.id); uncertain.delete(thread.id); action = null;
      notice = `“${thread.title}”已恢复。`;
      feedback.textContent = notice;
      try { await onRestored(); } catch { feedback.textContent = '已恢复，会话列表暂未刷新，请稍后刷新。'; }
    } catch (error) {
      // Do not retry a mutation, including after a service restart or lost response.
      feedback.textContent = `恢复尚未确认：${error.message || '连接中断'}。请刷新归档和会话列表核对；不会自动重试。`;
    } finally { restoring = false; render(); }
  }
  function hide() { generation++; loading = false; if (panel.open) panel.close(); controls(); }
  open.addEventListener('click', () => { if (!panel.open) panel.showModal(); void load(); });
  close.addEventListener('click', hide);
  panel.addEventListener('cancel', () => { generation++; loading = false; });
  refresh.addEventListener('click', () => void load()); more.addEventListener('click', () => void load(true));
  return { close: hide };
}
