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
