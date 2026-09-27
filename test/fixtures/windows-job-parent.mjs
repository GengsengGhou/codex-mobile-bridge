import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launchWindowsBridge } from '../../scripts/windows-launch.mjs';

const root = process.argv[2];
const launch = await launchWindowsBridge({
  root,
  nodePath: process.execPath,
  serverPath: resolve(root, 'proof-server.mjs'),
  env: {}
});
writeFileSync(resolve(root, '.local/launch.json'), JSON.stringify(launch));
setInterval(() => {}, 1000);
