import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync(new URL('../public/vendor/katex/manifest.json', import.meta.url), 'utf8'));
if (!Array.isArray(manifest.assets) || manifest.assets.length > 64 || manifest.assets.some(name => !/^(?:katex\.mjs|katex\.min\.css|LICENSE|fonts\/KaTeX_[A-Za-z0-9-]+\.woff2)$/.test(name))) throw new Error('Invalid math asset manifest');
export const mathAssets = new Set(manifest.assets.map(name => `/vendor/katex/${name}`));
const mermaidManifest = JSON.parse(readFileSync(new URL('../public/vendor/mermaid/manifest.json', import.meta.url), 'utf8'));
const mermaidNames = new Set(['mermaid.mjs', 'LICENSE']);
if (mermaidManifest.version !== '12.1.0' || mermaidManifest.bundler !== '0.28.2' || !Array.isArray(mermaidManifest.assets) || mermaidManifest.assets.length !== mermaidNames.size || new Set(mermaidManifest.assets).size !== mermaidNames.size || mermaidManifest.assets.some(name => !mermaidNames.has(name)) || !mermaidManifest.sha256 || Object.keys(mermaidManifest.sha256).length !== mermaidNames.size) throw new Error('Invalid Mermaid asset manifest');
for (const name of mermaidManifest.assets) {
  if (!/^[a-f0-9]{64}$/.test(mermaidManifest.sha256[name] ?? '')) throw new Error('Invalid Mermaid asset hash');
  const bytes = readFileSync(new URL(`../public/vendor/mermaid/${name}`, import.meta.url));
  if (createHash('sha256').update(bytes).digest('hex') !== mermaidManifest.sha256[name]) throw new Error('Mermaid asset hash mismatch');
}
export const mermaidAssets = new Set(mermaidManifest.assets.map(name => `/vendor/mermaid/${name}`));
export const publicAssets = new Set(['/', '/favicon.svg', '/favicon.png', '/app.js', '/i18n.js', '/i18n-messages.js', '/connection.js', '/markdown.js', '/mermaid.js', '/presentation.js', '/thread-cache.js', '/sidebar-order.js', '/conversation-state.js', '/thread-context.js', '/thread-context.css', '/agent-viewer.js', '/agent-viewer.css', '/files.js', '/uploads.js', '/archives.js', '/archives.css', '/recovery.js', '/recovery.css', '/access.js', '/access.css', '/style.css', ...mathAssets, ...mermaidAssets]);
export function assetContentType(file) {
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('LICENSE')) return 'text/plain; charset=utf-8';
  return 'text/html; charset=utf-8';
}
export const appCsp = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
