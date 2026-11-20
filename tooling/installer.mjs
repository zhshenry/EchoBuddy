import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
const electronDist = dirname(require('electron'));
const build = spawnSync(process.execPath, [
  require.resolve('electron-builder/out/cli/cli.js'), '--win', 'nsis', '--x64', '--publish', 'never',
  `--config.electronDist=${electronDist}`,
], { cwd: root, stdio: 'inherit', windowsHide: true });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status || 1);

const release = join(root, 'release');
const output = join(release, 'build');
const current = join(release, 'installer');
const setup = value => `EchoBuddy-Setup-${value}-x64.exe`;
const files = value => [setup(value), setup(value) + '.blockmap', 'latest.yml'];
const manifest = readFileSync(join(output, 'latest.yml'), 'utf8');
if (!manifest.includes(setup(version))) throw new Error('更新清单与本次安装包不匹配。');
for (const name of files(version)) {
  if (!statSync(join(output, name)).size) throw new Error('安装包发布产物为空 ' + name);
}

mkdirSync(current, { recursive: true });
const previous = join(current, 'latest.yml');
const oldVersion = existsSync(previous) ?
  /^version:\s*([0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?)\s*$/m.exec(readFileSync(previous, 'utf8'))?.[1] : undefined;
if (oldVersion && oldVersion !== version) {
  const archive = join(release, 'archive', oldVersion, 'installer');
  mkdirSync(archive, { recursive: true });
  for (const name of files(oldVersion)) copyFileSync(join(current, name), join(archive, name));
}
for (const name of files(version)) copyFileSync(join(output, name), join(current, name));
console.log('EchoBuddy installer and update metadata:', current);
