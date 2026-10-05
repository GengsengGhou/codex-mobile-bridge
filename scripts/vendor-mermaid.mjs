import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'node_modules/mermaid');
const target = resolve(root, 'public/vendor/mermaid');
const packageJson = JSON.parse(await readFile(resolve(source, 'package.json'), 'utf8'));
const esbuildPackage = JSON.parse(await readFile(resolve(root, 'node_modules/esbuild/package.json'), 'utf8'));
if (packageJson.version !== '12.1.0' || esbuildPackage.version !== '0.28.2') {
  throw new Error('Mermaid and esbuild versions differ from the pinned vendor inputs');
}

await mkdir(target, { recursive: true });
const result = await build({
  stdin: {
    contents: "export { default } from 'mermaid';\n",
    resolveDir: root,
    sourcefile: 'mermaid-entry.mjs',
    loader: 'js'
  },
  absWorkingDir: root,
  bundle: true,
  minify: true,
  treeShaking: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  legalComments: 'inline',
  outfile: resolve(target, 'mermaid.mjs'),
  metafile: true,
  write: false,
  logLevel: 'warning',
  plugins: [{
    name: 'keep-mermaid-and-cytoscape-styles-out-of-the-live-document',
    setup(buildApi) {
      buildApi.onLoad({ filter: /[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.mjs$/ }, async args => {
        const sourceText = await readFile(args.path, 'utf8');
        const styleInsertion = 'const style1 = document.createElement("style");\n  style1.innerHTML = rules;\n  svg.insertBefore(style1, firstChild);';
        const serializerAnchor = 'let code2 = root.select(enclosingDivID_selector).node().innerHTML;';
        const styleMatches = sourceText.split(styleInsertion).length - 1;
        const serializerMatches = sourceText.split(serializerAnchor).length - 1;
        if (styleMatches !== 1 || serializerMatches !== 1) {
          throw new Error(`Expected one Mermaid style insertion and serializer anchor, found ${styleMatches} and ${serializerMatches}`);
        }
        const inertStyleInsertion = 'svg.__codexMermaidRules = rules;';
        const serializedRules = `${serializerAnchor}\n    const codexRules = svg.__codexMermaidRules ?? "";\n    const codexStyleText = codexRules.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");\n    code2 = code2.replace(/(<svg\\b[^>]*>)/, "$1<desc data-mermaid-css=\\\"true\\\">" + codexStyleText + "</desc>");`;
        const transformed = sourceText
          .replace(styleInsertion, inertStyleInsertion)
          .replace(serializerAnchor, serializedRules);
        return {
          // Preserve rules for the returned SVG without creating a style element in the CSP-governed DOM.
          contents: transformed,
          loader: 'js'
        };
      });
      buildApi.onLoad({ filter: /[\\/]cytoscape[\\/]dist[\\/]cytoscape\.esm\.mjs$/ }, async args => {
        const sourceText = await readFile(args.path, 'utf8');
        const insertion = `    if (!stylesheetAlreadyExists) {
      var stylesheet = document.createElement('style');
      stylesheet.id = stylesheetId;
      stylesheet.textContent = '.' + className + ' { position: relative; }';
      head.insertBefore(stylesheet, head.children[0]); // first so lowest priority
    }`;
        const matches = sourceText.split(insertion).length - 1;
        if (matches !== 1) throw new Error(`Expected one Cytoscape container stylesheet insertion, found ${matches}`);
        return {
          // The host stylesheet supplies this same fixed container rule under strict CSP.
          contents: sourceText.replace(insertion, ''),
          loader: 'js'
        };
      });
    }
  }]
});

if (result.outputFiles.length !== 1 || Object.keys(result.metafile.outputs).length !== 1) {
  throw new Error('Mermaid bundle must produce exactly one browser module');
}
const bundle = Buffer.from(result.outputFiles[0].contents);
const sourceText = bundle.toString('utf8');
assert.match(sourceText, /export\s*\{[^}]*\bas\s+default\s*[},]/s, 'browser module must expose Mermaid as its default export');
assert.equal((sourceText.match(/__codexMermaidRules/g) ?? []).length, 2, 'bundle must store and serialize Mermaid rules exactly once');
assert.match(sourceText, /data-mermaid-css/, 'bundle must place generated styles in a non-rendering SVG description carrier');
assert.doesNotMatch(sourceText, /document\.createElement\(["']style["']\)/, 'Mermaid core must not insert inline style elements into the live document');
assert.doesNotMatch(sourceText, /document\.createElement\(['"]style['"]\)/, 'Cytoscape must not insert inline style elements into the live document');
if (/\bimport\s*\(/.test(sourceText) || /\bimport\s*(?:[^'";]*?\sfrom\s*)?['"](?:https?:)?\/\//.test(sourceText)) {
  throw new Error('Mermaid bundle contains a dynamic or external module import');
}
await writeFile(resolve(target, 'mermaid.mjs'), bundle);
await copyFile(resolve(source, 'LICENSE'), resolve(target, 'LICENSE'));

const assets = ['mermaid.mjs', 'LICENSE'];
const sha256 = {};
for (const name of assets) {
  const bytes = await readFile(resolve(target, name));
  sha256[name] = createHash('sha256').update(bytes).digest('hex');
}
await writeFile(resolve(target, 'manifest.json'), `${JSON.stringify({
  version: packageJson.version,
  bundler: esbuildPackage.version,
  assets,
  sha256
}, null, 2)}\n`);
console.log(`Bundled Mermaid ${packageJson.version} with esbuild ${esbuildPackage.version} (${(bundle.length / 1024 / 1024).toFixed(2)} MiB).`);
