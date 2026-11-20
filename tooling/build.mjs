import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const programFiles = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)';
const vswhere = join(programFiles, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
const sdkRoot = join(programFiles, 'Windows Kits', '10');
if (!existsSync(vswhere) || !existsSync(join(sdkRoot, 'Include'))) {
  throw new Error('构建 Windows 写入助手需要 Visual Studio C++ x64 工具和 Windows SDK。');
}
const installation = execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
  'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
if (!installation) throw new Error('未找到 Visual Studio 的 C++ x64 构建工具。');
const vcVersion = readFileSync(join(installation, 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt'), 'utf8').trim();
const vc = join(installation, 'VC/Tools/MSVC', vcVersion);
const sdk = readdirSync(join(sdkRoot, 'Include')).filter(version =>
  existsSync(join(sdkRoot, 'Include', version, 'um/Windows.h')) &&
  existsSync(join(sdkRoot, 'Lib', version, 'um/x64/uiautomationcore.lib'))
).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
if (!sdk) throw new Error('Windows SDK 缺少 x64 UI Automation 库。');

const nativeOut = join(root, 'dist-native');
const compiler = join(vc, 'bin/Hostx64/x64');
mkdirSync(nativeOut, { recursive: true });
const native = spawnSync(join(compiler, 'cl.exe'), [
  '/nologo', '/O2', '/EHsc', '/MT', '/W4', '/std:c++17', '/utf-8',
  '/DUNICODE', '/D_UNICODE', `/Fo${join(nativeOut, 'echo-input.obj')}`,
  `/Fe${join(nativeOut, 'echo-input.exe')}`, join(root, 'native/windows-input/main.cpp'),
  '/link', 'User32.lib', 'Ole32.lib', 'OleAut32.lib', 'UIAutomationCore.lib', 'Uuid.lib',
], {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: {
    ...process.env,
    PATH: [compiler, process.env.PATH].join(';'),
    INCLUDE: [join(vc, 'include'), ...['ucrt', 'shared', 'um', 'winrt'].map(dir => join(sdkRoot, 'Include', sdk, dir))].join(';'),
    LIB: [join(vc, 'lib/x64'), ...['ucrt', 'um'].map(dir => join(sdkRoot, 'Lib', sdk, dir, 'x64'))].join(';'),
  },
});
if (native.error) throw native.error;
if (native.status !== 0) process.exit(native.status || 1);

await build({
  absWorkingDir: root,
  entryPoints: { main: 'electron/main.ts', preload: 'electron/preload.ts', 'speech-worker': 'electron/speech/speech-worker.ts' },
  outdir: 'dist-electron', outExtension: { '.js': '.cjs' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node24',
  external: ['electron', 'electron-updater', 'sherpa-onnx-node'],
  logLevel: 'info',
});
