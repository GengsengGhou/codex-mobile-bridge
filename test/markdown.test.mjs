import test from 'node:test';
import assert from 'node:assert/strict';
import { appendMarkdown, parseMarkdown, safeHref } from '../public/markdown.js';
import { JSDOM } from 'jsdom';

test('renders a task creation directive readably while preserving code examples', () => {
  const directive = '::created-thread{threadId="00000000-0000-7000-8000-000000000001"}';
  assert.equal(parseMarkdown('完成\n' + directive)[1].children[0].text, '已创建新任务');
  assert.equal(parseMarkdown('```\n' + directive + '\n```')[0].text, directive);
  assert.equal(parseMarkdown('示例：' + directive)[0].children[0].text, '示例：' + directive);
});

test('parses headings, paragraphs, emphasis, and inline code', () => {
  const blocks = parseMarkdown('# Heading\n\nA **bold** word and `code`.');
  assert.equal(blocks[0].type, 'heading');
  assert.equal(blocks[0].level, 1);
  assert.deepEqual(blocks[0].children, [{ type: 'text', text: 'Heading' }]);
  assert.equal(blocks[1].type, 'paragraph');
  assert.deepEqual(blocks[1].children, [
    { type: 'text', text: 'A ' },
    { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
    { type: 'text', text: ' word and ' },
    { type: 'code', text: 'code' },
    { type: 'text', text: '.' },
  ]);
});

test('parses unordered and ordered lists and fenced code', () => {
  const blocks = parseMarkdown('- first\n- **second**\n\n1. alpha\n2. beta\n\n```js\nconsole.log("ok")\n```');
  assert.deepEqual(blocks[0], {
    type: 'list', ordered: false, items: [
      [{ type: 'text', text: 'first' }],
      [{ type: 'strong', children: [{ type: 'text', text: 'second' }] }],
    ],
  });
  assert.equal(blocks[1].ordered, true);
  assert.deepEqual(blocks[2], { type: 'codeBlock', language: 'js', text: 'console.log("ok")' });
});

test('parses tables and valid http links', () => {
  const blocks = parseMarkdown('| Name | Link |\n| --- | --- |\n| Codex | [docs](https://example.com/docs) |');
  assert.equal(blocks[0].type, 'table');
  assert.equal(blocks[0].headers.length, 2);
  assert.equal(blocks[0].rows.length, 1);
  assert.deepEqual(blocks[0].rows[0][1], [{
    type: 'link', href: 'https://example.com/docs', children: [{ type: 'text', text: 'docs' }],
  }]);
  assert.equal(safeHref('http://example.com'), 'http://example.com/');
  assert.equal(safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
});

test('dangerous links and raw HTML remain inert text', () => {
  const blocks = parseMarkdown('[run](javascript:alert(1))\n\n<img src=x onerror=alert(1)>');
  assert.equal(blocks[0].type, 'paragraph');
  assert.ok(blocks[0].children.every(node => node.type === 'text'));
  assert.equal(blocks[1].children[0].text, '<img src=x onerror=alert(1)>');
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', '//example.com/path', 'https://user:pass@example.com']) {
    assert.equal(safeHref(url), null);
  }
});

test('local Markdown references become file actions with normalized paths and line suffixes', () => {
  const blocks = parseMarkdown('[win](<C:\\work tree\\guide.md:12>) [unix](/tmp/guide.md#L8-L10) ![chart](./out.png)');
  const nodes = blocks[0].children.filter(node => node.type === 'file');
  assert.deepEqual(nodes.map(({ path, line, image }) => ({ path, line, image })), [
    { path: 'C:/work tree/guide.md', line: ':12', image: false },
    { path: '/tmp/guide.md', line: ':8', image: false },
    { path: './out.png', line: '', image: true },
  ]);
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  const root = dom.window.document.querySelector('#root');
  appendMarkdown(root, '[win](<C:\\work tree\\guide.md:12>) [site](https://example.com/a.md) [run](javascript:alert(1))', dom.window.document);
  assert.equal(root.querySelectorAll('button[data-local-file]').length, 1);
  assert.equal(root.querySelector('button[data-local-file]').dataset.localFile, 'C:/work tree/guide.md');
  assert.equal(root.querySelectorAll('a[href^="https:"]').length, 1);
  assert.equal(root.querySelectorAll('a[href^="javascript:"]').length, 0);
  dom.window.close();
});

test('network and executable references do not become local file actions', () => {
  const blocks = parseMarkdown('[site](https://example.com/a.md) [run](javascript:alert(1)) [scheme](file:///C:/secret.txt)');
  assert.equal(blocks[0].children.filter(node => node.type === 'file').length, 0);
  assert.equal(blocks[0].children.filter(node => node.type === 'link').length, 1);
  assert.ok(blocks[0].children.some(node => node.type === 'text' && node.text.includes('javascript:')));
});

test('native entity-wrapped attachment links preview both actual absolute paths', () => {
  const paths = [
    'E:/project/mobile-uploads/dcc03481-0b6a-4c2e-bb03-4323469d20bc/Screenshot_20260929_091208_com.huawei.browser.jpg',
    'E:/project/mobile-uploads/10449405-cd08-4473-82dd-9044404319a6/Screenshot_20260929_091218_com.huawei.browser.jpg',
  ];
  const source = paths.map(path => `[${path.split('/').at(-1)}](&lt;${path}&gt;)`).join('\n');
  const { dom, root } = renderArtifact(source);
  assert.deepEqual([...root.querySelectorAll('button[data-local-file]')].map(button => button.dataset.localFile), paths);
  assert.doesNotMatch(root.textContent, /&lt;|&gt;|mobile-uploads/);
  dom.window.close();
});

test('only native destination wrapper syntax decodes one ampersand layer and preserves filename characters', () => {
  const { dom, root } = renderArtifact(String.raw`[native](&lt;E:/project/中文/O'Brien "quoted" &amp; friends (v2).pdf:12&gt;) [raw](<E:/project/literal &amp; (v3).pdf>) [encoded literal](&lt;E:/project/literal &amp;amp; name.pdf&gt;)`);
  assert.deepEqual([...root.querySelectorAll('[data-local-file]')].map(button => button.dataset.localFile), [
    'E:/project/中文/O\'Brien "quoted" & friends (v2).pdf',
    'E:/project/literal &amp; (v3).pdf',
    'E:/project/literal &amp; name.pdf',
  ]);
  assert.equal(root.querySelector('[data-local-file]').dataset.line, '12');
  dom.window.close();
});

test('unsafe and malformed entity-wrapped destinations stay inert without decoding other HTML or code', () => {
  for (const destination of [
    '&lt;javascript:alert(1)&gt;', '&lt;file:///C:/secret.txt&gt;',
    '&lt;https://user:pass@example.com/secret.pdf&gt;', '&lt;//server/share/file.pdf&gt;',
    String.raw`&lt;\\server\share\file.pdf&gt;`, '&lt;E:/file.pdf', '&lt;&gt;',
    '&lt;javascript&#58;alert(1)&gt;', '&lt;file&colon;///C:/secret.txt&gt;',
    '&lt;&#47;&#47;server/share/file.pdf&gt;',
    '&#60;javascript:alert(1)&#62;', '&amp;lt;E:/file.pdf&amp;gt;',
  ]) {
    const source = `[attachment](${destination})`;
    const { dom, root } = renderArtifact(source);
    assert.equal(root.querySelectorAll('button[data-local-file],a').length, 0, destination);
    assert.equal(root.textContent, source);
    dom.window.close();
  }
  const literal = '&lt;img src=x onerror=alert(1)&gt; &amp; `![example](&lt;E:/example.png&gt;)`';
  const { dom, root } = renderArtifact(literal);
  assert.equal(root.querySelectorAll('img,[data-local-file]').length, 0);
  assert.match(root.textContent, /^&lt;img.*&gt; &amp;/);
  assert.equal(root.querySelector('code').textContent, '![example](&lt;E:/example.png&gt;)');
  dom.window.close();
});

const artifactPath = 'E:/example_report_project/示例 组合汇报/区域统计分析_260928/output/区域统计分析_背景与方法_v2_260929.pdf';
const artifactCitation = `:codex-file-citation{path="${artifactPath}" purpose="output"}`;
const artifactFollowup = ':codex-followup[精简为20分钟版]{prompt="将示例汇报整理为20分钟组会版本，保留主要图表与分析步骤。"}';

function renderArtifact(source, options = {}) {
  const dom = new JSDOM('<div id="root"></div>');
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  const root = dom.window.document.querySelector('#root');
  appendMarkdown(root, source, dom.window.document, options);
  return { dom, root };
}

test('real transcript artifact directives render scoped file previews and explicit suggestions', () => {
  const { dom, root } = renderArtifact(`PDF预览： ${artifactCitation}\n\n- ${artifactFollowup}\n- :codex-followup[补充论文图]{prompt="补充论文图。"}\n- :codex-followup[导出PDF]{prompt="导出PDF。"}`, { allowFollowups: true });
  const file = root.querySelector('button[data-local-file]');
  assert.equal(file.dataset.localFile, artifactPath);
  assert.equal(file.textContent, artifactPath.split('/').at(-1));
  assert.equal(root.querySelectorAll('button[data-codex-followup]').length, 3);
  const followup = root.querySelector('button[data-codex-followup]');
  assert.equal(followup.type, 'button');
  assert.equal(followup.textContent, '精简为20分钟版');
  assert.match(followup.getAttribute('aria-label'), /精简为20分钟版/);
  assert.match(followup.dataset.codexFollowup, /20分钟组会/);
  assert.equal(followup.disabled, false);
  followup.click();
  assert.equal(root.querySelectorAll('form,input,textarea').length, 0);
  assert.doesNotMatch(root.textContent, /codex-|purpose=|path=|prompt=|E:\//);
  dom.window.close();
});

test('followups are inert by default for read-only rendering', () => {
  const { dom, root } = renderArtifact(artifactFollowup);
  const suggestion = root.querySelector('button.markdown-followup');
  assert.equal(suggestion.disabled, true);
  assert.equal(suggestion.hasAttribute('data-codex-followup'), false);
  assert.equal(suggestion.textContent, '精简为20分钟版');
  dom.window.close();
});

test('directive values preserve Unicode, apostrophes, escaped quotes and backslashes as text', () => {
  const source = String.raw`:codex-file-citation{path="C:\\work\\O'Brien\\中文.pdf" purpose="output"} :codex-followup[说"你好"]{prompt="保留 O'Brien 和 \\\"引号\\\"，路径 C:\\work\\中文.pdf"}`;
  const { dom, root } = renderArtifact(source, { allowFollowups: true });
  assert.equal(root.querySelector('[data-local-file]').dataset.localFile, "C:/work/O'Brien/中文.pdf");
  const button = root.querySelector('[data-codex-followup]');
  assert.equal(button.textContent, '说"你好"');
  assert.equal(button.dataset.codexFollowup, String.raw`保留 O'Brien 和 \"引号\"，路径 C:\work\中文.pdf`);
  dom.window.close();
});

test('quoted, escaped, HTML and Markdown code directive examples never gain actions', () => {
  for (const source of [
    `\`${artifactCitation}\``, `\`\`${artifactFollowup}\`\``,
    `\`\`\`text\n${artifactFollowup}\n\`\`\``, `~~~~\n${artifactCitation}\n~~~~`,
    `"${artifactFollowup}"`, `'${artifactCitation}'`, `“${artifactFollowup}”`,
    `> ${artifactFollowup}`, `示例：${artifactFollowup}`, `example: ${artifactCitation}`,
    `\\${artifactFollowup}`, `<span>${artifactFollowup}</span>`, `<!-- ${artifactCitation} -->`,
    `[${artifactFollowup}](https://example.com)`, `\`${artifactFollowup}`,
  ]) {
    const { dom, root } = renderArtifact(source, { allowFollowups: true });
    assert.equal(root.querySelectorAll('[data-local-file],.markdown-followup').length, 0, source);
    assert.match(root.textContent, /:codex-/);
    assert.equal(root.querySelectorAll('span[onclick],script,img').length, 0);
    dom.window.close();
  }
});

test('malformed, unknown, unsafe and oversized directives remain readable inert text', () => {
  const sources = [
    ':codex-file-citation{path="javascript:alert(1)"}',
    ':codex-file-citation{path="file:///C:/secret.txt"}',
    ':codex-file-citation{path="https://user:pass@example.com/secret.pdf"}',
    ':codex-file-citation{path="//server/share/secret.pdf"}',
    ':codex-file-citation{path="<//server/share/secret.pdf>"}',
    String.raw`:codex-file-citation{path="\\\\server\\share\\secret.pdf"}`,
    ':codex-file-citation{path="C:/valid.pdf" path="C:/other.pdf"}',
    ':codex-file-citation{path="C:/valid.pdf" authority="all"}',
    ':codex-followup[run]{prompt="hello" autosend="true"}',
    ':codex-followup[run]{prompt=""}', ':codex-followup[]{prompt="hello"}',
    ':codex-followup[run]{prompt="missing close}',
    ':codex-unknown{path="C:/valid.pdf"}',
    `:codex-followup[run]{prompt="${'a'.repeat(9000)}"}`,
    ':codex-followup[run]{prompt="hello"prompt="other"}',
  ];
  for (const source of sources) {
    const { dom, root } = renderArtifact(source, { allowFollowups: true });
    assert.equal(root.querySelectorAll('[data-local-file],.markdown-followup,a').length, 0, source.slice(0, 150));
    assert.equal(root.textContent, source);
    dom.window.close();
  }
});

test('artifact labels and prompts do not create HTML and parsing has a per-message budget', () => {
  const source = ':codex-followup[<img src=x onerror=alert(1)>]{prompt="<script>alert(1)</script>"}';
  const { dom, root } = renderArtifact(source, { allowFollowups: true });
  assert.equal(root.querySelectorAll('img,script').length, 0);
  assert.equal(root.querySelector('.markdown-followup').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(root.querySelector('.markdown-followup').dataset.codexFollowup, '<script>alert(1)</script>');
  dom.window.close();
  const bounded = renderArtifact(Array.from({ length: 150 }, () => artifactFollowup).join('\n\n'), { allowFollowups: true });
  assert.equal(bounded.root.querySelectorAll('.markdown-followup').length, 128);
  assert.match(bounded.root.textContent, /:codex-followup/);
  bounded.dom.window.close();
});
