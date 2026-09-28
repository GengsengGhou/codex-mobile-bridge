import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../public/vendor/katex/manifest.json', import.meta.url), 'utf8'));
if (!Array.isArray(manifest.assets) || manifest.assets.length > 64 || manifest.assets.some(name => !/^(?:katex\.mjs|katex\.min\.css|LICENSE|fonts\/KaTeX_[A-Za-z0-9-]+\.woff2)$/.test(name))) throw new Error('Invalid math asset manifest');
export const mathAssets = new Set(manifest.assets.map(name => `/vendor/katex/${name}`));
export const publicAssets = new Set(['/', '/app.js', '/connection.js', '/markdown.js', '/presentation.js', '/thread-cache.js', '/sidebar-order.js', '/conversation-state.js', '/thread-context.js', '/thread-context.css', '/agent-viewer.js', '/agent-viewer.css', '/files.js', '/uploads.js', '/archives.js', '/archives.css', '/recovery.js', '/recovery.css', '/access.js', '/access.css', '/style.css', ...mathAssets]);
export function assetContentType(file) {
  if (file.endsWith('.woff2')) return 'font/woff2';
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('LICENSE')) return 'text/plain; charset=utf-8';
  return 'text/html; charset=utf-8';
}
export const appCsp = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
