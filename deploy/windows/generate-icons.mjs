// Optional maintainer helper. Run with @resvg/resvg-js available outside the app.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const require = createRequire(process.env.ICON_RENDERER_ROOT + '/package.json');
const { Resvg } = require('@resvg/resvg-js');
const destination = fileURLToPath(new URL('./icons/', import.meta.url));
await mkdir(destination, { recursive: true });
for (const name of ['smartphone','monitor','settings','plug','unplug','external-link','link','download','chevron-down','arrow-left','check','circle-alert','clipboard-paste']) {
  const source = (await readFile(process.env.ICON_RENDERER_ROOT + '/node_modules/lucide-static/icons/' + name + '.svg','utf8')).replace('stroke="currentColor"', 'stroke="#253333"');
  await writeFile(destination + name + '.svg', source);
  await writeFile(destination + name + '.png', new Resvg(source, { fitTo: { mode: 'width', value: 48 } }).render().asPng());
}
await writeFile(destination + 'LICENSE', await readFile(process.env.ICON_RENDERER_ROOT + '/node_modules/lucide-static/LICENSE'));
