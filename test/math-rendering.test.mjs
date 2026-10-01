import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { parseMarkdown, parseInline, appendMarkdown } from '../public/markdown.js';

function render(source) {
  const dom = new JSDOM('<main></main>');
  Object.defineProperty(dom.window.navigator, 'language', { value: 'zh-CN', configurable: true }); /* Existing Chinese-copy fixture. */
  const root = dom.window.document.querySelector('main');
  appendMarkdown(root, source, dom.window.document);
  return { root, close: () => dom.window.close() };
}
test('all four delimiters render accessible math including multiline aligned equations and matrices', () => {
  const source = String.raw`Inline $E=mc^2$ and \(\frac{a_i}{b^2}\).

$$
\begin{aligned}
f(x)&=\int_0^1 x^2\,dx\\
&=\frac{1}{3}
\end{aligned}
$$

\[
\begin{pmatrix}1&2\\3&4\end{pmatrix}
\]
After.`;
  const view = render(source);
  assert.equal(view.root.querySelectorAll('.katex').length, 4);
  assert.equal(view.root.querySelectorAll('math').length, 4);
  assert.equal(view.root.querySelectorAll('.katex-html[aria-hidden="true"]').length, 4);
  assert.equal(view.root.querySelectorAll('.markdown-math-display').length, 2);
  assert.equal(view.root.querySelectorAll('.markdown-math-fallback').length, 0);
  assert.ok(view.root.textContent.endsWith('After.')); view.close();
});
test('math source is protected from emphasis and pipe splitting in headings, lists, links and tables', () => {
  const source = String.raw`# Result $a_{__i}=b^{**}$
- Inline \(a_i\) and **bold $x^2$**

| Formula | Meaning |
| --- | --- |
| $|x|+\left\| y\right\|$ | norm |
| \(\begin{matrix}a&b\\c&d\end{matrix}\) | matrix |`;
  const blocks = parseMarkdown(source);
  assert.equal(blocks[0].children.find(node => node.type === 'math').text, 'a_{__i}=b^{**}');
  assert.equal(blocks[2].headers.length, 2);
  assert.deepEqual(blocks[2].rows.map(row => row.length), [2, 2]);
  assert.equal(blocks[2].rows[0][0][0].text, String.raw`|x|+\left\| y\right\|`);
  const view = render(String.raw`# Heading $x^2$
- **Bold $x_i$**
[Equation $y$](https://example.com)

| $x$ | Text |
| --- | --- |
| $|x|$ | norm |`);
  assert.equal(view.root.querySelectorAll('.katex').length, 5);
  assert.equal(view.root.querySelector('tbody tr').children.length, 2); view.close();
});
test('currency, escaped/unmatched delimiters and code stay readable and are not rendered as math', () => {
  const source = String.raw`Costs $5 and $10; $25.50 USD, then $20. Escaped \$x\$, \\(x\\) and \[unclosed.

Code: \`$x^2$\`.

\`\`\`latex
$$x^2$$
\(y\)
\`\`\``.replaceAll('\\`', '`');
  const view = render(source);
  assert.equal(view.root.querySelectorAll('.katex').length, 0);
  assert.ok(view.root.textContent.includes('Costs $5 and $10'));
  assert.ok(view.root.textContent.includes('$x$'));
  assert.equal(view.root.querySelector('pre code').textContent, '$$x^2$$\n\\(y\\)');
  const inline = parseInline(String.raw`\$x\$ and \\(literal\\) and $a\\$`);
  assert.equal(inline.filter(node => node.type === 'math').length, 1);
  assert.equal(inline.find(node => node.type === 'math').text, String.raw`a\\`); view.close();
  const fenced = render('$$ unmatched\n\n```latex\n$$ inside code $$\n```');
  assert.equal(fenced.root.querySelectorAll('.katex').length, 0);
  assert.equal(fenced.root.querySelector('pre code').textContent, '$$ inside code $$'); fenced.close();
  const mixed = render('Costs $5 and $10; inline code `$E=mc^2$` then math $x^2$.');
  assert.equal(mixed.root.querySelectorAll('.katex').length, 1);
  assert.equal(mixed.root.querySelector('code').textContent, '$E=mc^2$');
  assert.ok(mixed.root.textContent.startsWith('Costs $5 and $10')); mixed.close();
});
test('malformed and excessive math falls back without losing adjacent content or allowing HTML', () => {
  const view = render(String.raw`Bad $\frac{1}{$ then valid $x^2$.

$$\href{javascript:alert(1)}{click}\htmlClass{evil}{x}\includegraphics{https://evil.example/a}$$

Raw <img src=x onerror=alert(1)>.

$$\def\loop{\loop}\loop$$`);
  assert.ok(view.root.querySelector('.markdown-math-fallback').textContent.startsWith('$\\frac'));
  assert.ok(view.root.querySelectorAll('.katex').length >= 1);
  assert.equal(view.root.querySelectorAll('img,script,a,[onerror],.evil').length, 0);
  assert.ok(view.root.textContent.includes('Raw <img src=x onerror=alert(1)>')); view.close();
  const many = render(Array.from({ length: 150 }, () => '$x$').join(' '));
  assert.equal(many.root.querySelectorAll('.katex').length, 128);
  assert.equal(many.root.querySelectorAll('.markdown-math-fallback').length, 22); many.close();
  const long = render('$$' + 'x'.repeat(5000) + '$$');
  assert.equal(long.root.querySelectorAll('.katex').length, 0); assert.ok(long.root.textContent.includes('x'.repeat(5000))); long.close();
});
test('bundled renderer has the matching font files and license without external font URLs', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/vendor/katex/manifest.json', import.meta.url)));
  const css = await readFile(new URL('../public/vendor/katex/katex.min.css', import.meta.url), 'utf8');
  assert.equal(manifest.version, '0.18.9');
  assert.ok(!css.includes('https://')); assert.ok(!css.includes('.ttf')); assert.ok(!/\.woff["')]/.test(css));
  for (const match of css.matchAll(/url\(([^)]+)\)/g)) assert.ok(manifest.assets.includes(match[1]));
  for (const name of manifest.assets) assert.ok((await readFile(new URL(`../public/vendor/katex/${name}`, import.meta.url))).length > 0);
  assert.match(await readFile(new URL('../public/vendor/katex/LICENSE', import.meta.url), 'utf8'), /MIT License/);
});
