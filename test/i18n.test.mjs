import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createI18n, LANGUAGE_KEY } from '../public/i18n.js';

function page(locale = 'en-US', markup = '<select data-language-selector><option value="zh-CN">中文</option><option value="en">EN</option></select><p data-i18n="已完成">已完成</p>') {
  const dom = new JSDOM(markup, { url: 'https://bridge.test/devices/example/' });
  Object.defineProperty(dom.window.navigator, 'language', { value: locale });
  return dom;
}
test('first launch chooses browser language; explicit preference and storage events share the origin', t => {
  for (const [locale, expected] of [['zh-TW', 'zh-CN'], ['zh-CN', 'zh-CN'], ['en-GB', 'en'], ['fr-FR', 'en']]) {
    const dom = page(locale); t.after(() => dom.window.close());
    const i18n = createI18n({ window: dom.window, document: dom.window.document });
    assert.equal(i18n.language, expected);
    i18n.setLanguage('en'); assert.equal(dom.window.localStorage.getItem(LANGUAGE_KEY), 'en');
    dom.window.dispatchEvent(new dom.window.StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'zh-CN' }));
    assert.equal(dom.window.document.querySelector('p').textContent, '已完成');
    assert.equal(dom.window.document.documentElement.lang, 'zh-CN');
  }
});
test('storage denial preserves immediate switching and only explicit interface copy changes', t => {
  const dom = page('en-US', '<p data-i18n="已完成">已完成</p><input value="我的草稿 已完成"><pre>已完成</pre>'); t.after(() => dom.window.close());
  Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('denied'); } });
  const doc = dom.window.document, i18n = createI18n({ window: dom.window, document: doc });
  assert.equal(doc.querySelector('p').textContent, 'Completed');
  i18n.setLanguage('zh-CN'); i18n.setLanguage('en');
  assert.equal(doc.querySelector('input').value, '我的草稿 已完成');
  assert.equal(doc.querySelector('pre').textContent, '已完成');
  assert.equal(i18n.t`状态 · ${i18n.t('运行中')}`, 'Status · Running');
  assert.equal(i18n.t('请求失败（404）'), 'Request failed (404)');
  assert.equal(i18n.t('external error remains verbatim'), 'external error remains verbatim');
  const oldMessage = i18n.t`请求失败（${404}）`;
  for (let index = 0; index < 2000; index++) i18n.t`请求失败（${index}）`;
  i18n.setLanguage('zh-CN');
  assert.equal(i18n.t(oldMessage), '请求失败（404）', 'retained owned copy still switches after a long session');
});
test('live copy retains text selections and disposes removed render rows after a batch', async t => {
  const dom = page('zh-CN', '<main></main>'); t.after(() => dom.window.close());
  const doc = dom.window.document, root = doc.querySelector('main'), i18n = createI18n({ window: dom.window, document: doc });
  let staleReads = 0;
  for (let index = 0; index < 100; index++) {
    const row = doc.createElement('p'); i18n.text(row, () => { staleReads++; return i18n.t('已完成'); }); root.replaceChildren(row);
  }
  const user = doc.createElement('code'); user.textContent = '已完成 const x = 1'; root.append(user);
  const originalText = user.firstChild;
  await Promise.resolve(); const reads = staleReads;
  i18n.setLanguage('en');
  assert.equal(staleReads - reads, 1, 'removed rows must not be retained and reevaluated');
  assert.equal(root.querySelector('p').textContent, 'Completed');
  assert.equal(user.firstChild, originalText);
});
