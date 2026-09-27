import { mkdir, readFile, readdir, copyFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
const source = resolve(root, 'node_modules/katex'), target = resolve(root, 'public/vendor/katex');
await mkdir(resolve(target, 'fonts'), { recursive: true });
const version = JSON.parse(await readFile(resolve(source, 'package.json'))).version;
await copyFile(resolve(source, 'dist/katex.mjs'), resolve(target, 'katex.mjs'));
await copyFile(resolve(source, 'LICENSE'), resolve(target, 'LICENSE'));
let css = await readFile(resolve(source, 'dist/katex.min.css'), 'utf8');
// Modern supported browsers use woff2; package only those local font assets.
css = css.replace(/src:url\(([^)]+\.woff2)\) format\("woff2"\),url\([^)]+\) format\("woff"\),url\([^)]+\) format\("truetype"\)/g, 'src:url($1) format("woff2")');
if (/\.(woff|ttf)["')]/.test(css)) throw new Error('Unrecognized KaTeX font declarations');
await writeFile(resolve(target, 'katex.min.css'), css);
const fonts = (await readdir(resolve(source, 'dist/fonts'))).filter(file => file.endsWith('.woff2')).sort();
for (const name of fonts) await copyFile(resolve(source, 'dist/fonts', name), resolve(target, 'fonts', name));
await writeFile(resolve(target, 'manifest.json'), JSON.stringify({ version, assets: ['katex.mjs', 'katex.min.css', 'LICENSE', ...fonts.map(name => `fonts/${name}`)] }, null, 2) + '\n');
console.log(`Bundled KaTeX ${version}, ${fonts.length} woff2 fonts and license.`);
