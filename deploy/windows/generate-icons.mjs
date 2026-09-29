// Optional maintainer helper. Run with @resvg/resvg-js available outside the app.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
const require = createRequire(process.env.ICON_RENDERER_ROOT + '/package.json');
const { Resvg } = require('@resvg/resvg-js');
const destination = fileURLToPath(new URL('./icons/', import.meta.url));
await mkdir(destination, { recursive: true });
if (!process.argv.includes('--brand-only')) for (const name of ['smartphone','monitor','settings','plug','unplug','external-link','link','download','chevron-down','arrow-left','check','circle-alert','clipboard-paste']) {
  const source = (await readFile(process.env.ICON_RENDERER_ROOT + '/node_modules/lucide-static/icons/' + name + '.svg','utf8')).replace('stroke="currentColor"', 'stroke="#253333"');
  await writeFile(destination + name + '.svg', source);
  await writeFile(destination + name + '.png', new Resvg(source, { fitTo: { mode: 'width', value: 48 } }).render().asPng());
}
if (!process.argv.includes('--brand-only')) await writeFile(destination + 'LICENSE', await readFile(process.env.ICON_RENDERER_ROOT + '/node_modules/lucide-static/LICENSE'));
const phone = new JSDOM(await readFile(destination + 'smartphone.svg','utf8'), { contentType: 'image/svg+xml' });
const glyph = phone.window.document.documentElement.innerHTML;
const brand = '<!-- Smartphone glyph: lucide-static ISC license, see LICENSE. -->\n<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" rx="6" fill="#146447" stroke="#b1d4bf" stroke-width="1.5"/><g transform="translate(4 4)" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+glyph+'</g></svg>\n';
phone.window.close();
await writeFile(destination + 'connector.svg', brand);
const sizes = [16,20,24,32,48,64,256];
const images = sizes.map(size => new Resvg(brand, { fitTo: { mode: 'width', value: size } }).render().asPng());
const directory = Buffer.alloc(6 + 16*sizes.length);directory.writeUInt16LE(1,2);directory.writeUInt16LE(sizes.length,4);
let offset = directory.length;
for (let i=0;i<sizes.length;i++) {
  const entry=6+16*i;directory[entry]=directory[entry+1]=sizes[i]===256?0:sizes[i];directory.writeUInt16LE(1,entry+4);directory.writeUInt16LE(32,entry+6);directory.writeUInt32LE(images[i].length,entry+8);directory.writeUInt32LE(offset,entry+12);offset+=images[i].length;
}
await writeFile(destination + 'connector.ico', Buffer.concat([directory,...images]));
const previewIndex=process.argv.indexOf('--preview-output');
if (previewIndex>=0) {
  let cells='';for(let row=0;row<2;row++)for(let i=0;i<6;i++){const x=i*90,y=row*100,size=sizes[i];cells+='<rect x="'+x+'" y="'+y+'" width="90" height="100" fill="'+(row?'#171717':'#fff')+'"/><image x="'+(x+(90-size)/2)+'" y="'+(y+12)+'" width="'+size+'" height="'+size+'" href="data:image/png;base64,'+images[i].toString('base64')+'"/><text x="'+(x+45)+'" y="'+(y+91)+'" text-anchor="middle" font-family="sans-serif" font-size="12" fill="'+(row?'#fff':'#171717')+'">'+size+' px</text>';}
  await writeFile(process.argv[previewIndex+1],new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="540" height="200">'+cells+'</svg>').render().asPng());
}
