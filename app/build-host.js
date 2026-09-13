// 截图功能独立宿主构建脚本（node build-host.js）
// esbuild 打包 app/main.ts + 提取的全部模块；electron/koffi 等依赖借道 Xiyue 的 node_modules
const { execFileSync } = require('child_process');
const { existsSync, mkdirSync } = require('fs');
const { join } = require('path');

const HERE = __dirname; // screenshot/app
const ROOT = join(HERE, '..'); // screenshot/
const XIYUE_MODULES = 'F:/Work/Create/Assa/Xiyue/node_modules';
const esbuild = join(XIYUE_MODULES, 'esbuild', 'bin', 'esbuild');

if (!existsSync(esbuild)) {
  console.error('esbuild not found in Xiyue node_modules:', esbuild);
  process.exit(1);
}
const outdir = join(HERE, 'dist');
if (!existsSync(outdir)) mkdirSync(outdir, { recursive: true });

const args = [
  join(HERE, 'main.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--external:electron',
  '--external:koffi',
  '--external:tesseract.js',
  `--outfile=${join(outdir, 'main.js')}`,
  
  '--log-level=warning',
];

execFileSync(process.execPath, [esbuild, ...args], { stdio: 'inherit', cwd: ROOT });
console.log('host built ->', join(outdir, 'main.js'));
