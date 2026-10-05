import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createMermaidRenderer, mermaidSourceIssue, sanitizeMermaidSvg, MERMAID_LIMITS } from '../public/mermaid.js';
import { appendMarkdown, parseMarkdown } from '../public/markdown.js';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text x="10" y="20">研究计划</text></svg>';
const SOURCE = 'mindmap\n  root((研究计划))\n    数据准备';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) { for (let at = 0; at < 100; at++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Mermaid did not settle'); }
function fixture(t) {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
  t.after(() => dom.window.close());
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN' });
  const created = [], revoked = [];
  dom.window.URL.createObjectURL = blob => { const url = `blob:fixture/${created.length}`; created.push({ url, blob }); return url; };
  dom.window.URL.revokeObjectURL = url => revoked.push(url);
  return { dom, doc: dom.window.document, created, revoked };
}
function block(doc, parent = doc.body) { const node = doc.createElement('div'); node.innerHTML = '<div>mermaid</div><pre><code></code></pre>'; node.querySelector('code').textContent = SOURCE; parent.append(node); return node; }

test('bounded supported sources reject configuration, resources and oversized input', () => {
  for (const source of [SOURCE, 'mindmap\n root((Plan))\n  Style guide\n  Click here', 'flowchart LR\n A --> B', 'graph TD\n A --> B', 'sequenceDiagram\n A->>B: hello']) assert.equal(mermaidSourceIssue(source), null);
  for (const source of ['mindmap\n%%{init: {}}%%', 'flowchart LR\n click A "https://example.com"', 'mindmap\n root(<img src=x>)', 'mindmap\n root(&lt;script&gt;)', 'mindmap\n root(javascript:alert)', 'mindmap\n themeCSS: x']) assert.equal(mermaidSourceIssue(source), 'unsafe', source);
  for (const source of ['x'.repeat(MERMAID_LIMITS.source + 1), 'mindmap\n' + 'x'.repeat(513), 'mindmap\n' + ' a\n'.repeat(128), 'flowchart LR\n' + 'A-->B;'.repeat(81)]) assert.equal(mermaidSourceIssue(source), 'limit');
  assert.equal(mermaidSourceIssue('pie\n "x": 1'), 'unsupported');
});

test('SVG sanitizer keeps inert Chinese geometry and rejects active content, references and bounds', t => {
  const { doc } = fixture(t), clean = sanitizeMermaidSvg(SVG, doc);
  assert.equal(clean.width, 200); assert.equal(clean.height, 100); assert.match(clean.svg, /研究计划/);
  const mindmap = SVG.replace('<text x="10" y="20">研究计划</text>', '<g class="mindmap-node"><circle r="40"/><g class="label"><text>Root</text></g></g><g class="mindmap-node"><rect/><g class="label"><text>Child</text></g></g>');
  const fixed = new doc.defaultView.DOMParser().parseFromString(sanitizeMermaidSvg(mindmap, doc).svg, 'image/svg+xml');
  assert.equal(fixed.querySelectorAll('text')[0].style.textAnchor, 'middle'); assert.equal(fixed.querySelectorAll('text')[1].style.textAnchor, '');
  for (const source of [SVG.replace('<text', '<script').replace('</text>', '</script>'), SVG.replace('<text', '<foreignObject').replace('</text>', '</foreignObject>'), SVG.replace('<text', '<text onclick="alert(1)"'), SVG.replace('<text', '<text href="https://evil.test"'), SVG.replace('<text', '<text style="fill:url(https://evil.test/x)"'), SVG.replace('200 100', '13000 100'), SVG.replace('200 100', '3000 3000'), '<!DOCTYPE svg>' + SVG, SVG.replace('http://www.w3.org/2000/svg', 'http://evil.test'), '<svg/>']) assert.throws(() => sanitizeMermaidSvg(source, doc));
});

test('Markdown leaves ordinary code alone and retains incomplete or over-budget Mermaid source', t => {
  const { doc } = fixture(t), root = doc.createElement('div');
  appendMarkdown(root, '```js\nmindmap\n```', doc); assert.equal(root.querySelector('.markdown-mermaid'), null);
  assert.equal(parseMarkdown('```mermaid\nmindmap')[0].incomplete, true);
  appendMarkdown(root, '```mermaid\nmindmap', doc); assert.equal(root.querySelector('.markdown-mermaid').dataset.diagramState, 'fallback');
  const many = doc.createElement('div'); appendMarkdown(many, Array.from({ length: 5 }, () => '```mermaid\n' + SOURCE + '\n```').join('\n\n'), doc);
  assert.equal(many.querySelectorAll('.markdown-mermaid').length, 5); assert.equal(many.querySelectorAll('[data-diagram-state="fallback"]').length, 1);
  assert.equal(many.querySelectorAll('code')[4].textContent, SOURCE);
});

test('loader stays lazy for detached or folded diagrams and serializes visible rendering', async t => {
  const { doc } = fixture(t); let loads = 0, active = 0, peak = 0, calls = 0;
  const renderer = createMermaidRenderer({ load: async () => { loads++; return { initialize() {}, async render() { active++; peak = Math.max(peak, active); calls++; await new Promise(resolve => setTimeout(resolve, 10)); active--; return { svg: SVG, bindFunctions() { assert.fail('Interactive callback bound'); } }; } }; } });
  const detached = block(doc); detached.remove(); renderer.enhance(detached, SOURCE, doc);
  const folded = doc.createElement('details'); doc.body.append(folded); const hidden = block(doc, folded); renderer.enhance(hidden, SOURCE, doc);
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(loads, 0);
  folded.open = true; const other = block(doc); renderer.enhance(other, SOURCE, doc);
  await until(() => other.dataset.diagramState === 'ready' && hidden.dataset.diagramState === 'ready');
  assert.equal(loads, 1); assert.equal(calls, 2); assert.equal(peak, 1); assert.equal(detached.querySelector('img'), null);
});

test('async completion preserves source choice, cleans detached URLs and restores pageshow images', async t => {
  const { doc, dom, created, revoked } = fixture(t), waiting = deferred();
  const renderer = createMermaidRenderer({ load: () => waiting.promise });
  const node = block(doc); renderer.enhance(node, SOURCE, doc);
  node.querySelector('summary').click(); node.querySelector('summary').click();
  waiting.resolve({ initialize() {}, async render() { return { svg: SVG }; } });
  await until(() => node.dataset.diagramState === 'ready'); assert.equal(node.querySelector('details').open, true);
  dom.window.dispatchEvent(new dom.window.Event('pagehide')); assert.equal(node.querySelector('img'), null); assert.equal(revoked.length, 1);
  dom.window.dispatchEvent(new dom.window.Event('pageshow')); await until(() => node.dataset.diagramState === 'ready'); assert.equal(created.length, 2);
  node.remove(); await until(() => revoked.length === 2);
});

test('failed async hidden render stays folded and succeeds only after reopening', async t => {
  const { doc } = fixture(t), pending = deferred(); let calls = 0;
  const renderer = createMermaidRenderer({ load: async () => ({ initialize() {}, render() { calls++; return calls === 1 ? pending.promise : Promise.resolve({ svg: SVG }); } }) });
  const folded = doc.createElement('details'); folded.open = true; doc.body.append(folded); const node = block(doc, folded); renderer.enhance(node, SOURCE, doc);
  await until(() => calls === 1); folded.open = false; node.querySelector('details').open = false; pending.reject(new Error('fixture failure'));
  await until(() => node.dataset.diagramState === 'pending'); assert.equal(folded.open, false); assert.equal(node.querySelector('details').open, false);
  folded.open = true; await until(() => node.dataset.diagramState === 'ready'); assert.equal(calls, 2);
});
