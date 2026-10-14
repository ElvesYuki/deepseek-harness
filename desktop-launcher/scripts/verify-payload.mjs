/** Refuse cross-platform packaging or missing offline startup resources. */
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { toolPaths } from '../src/platform.mjs';
const root = resolve(import.meta.dirname, '../.cache/payload');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const expected = process.argv[2] || process.platform;
if (expected !== process.platform || manifest.platform !== expected || manifest.arch !== process.arch
  || !((expected === 'darwin' && process.arch === 'arm64') || (expected === 'win32' && process.arch === 'x64'))) {
  throw new Error('Build on the matching host: macOS arm64 or Windows x64.');
}
const tools = toolPaths(root, resolve(root, '../verify-home'));
for (const file of [tools.node, tools.git, tools.pnpm, resolve(root, 'dsh/apps/web/dist/index.html'),
  resolve(root, expected === 'win32' ? 'dsh/.launcher-links.json' : 'dsh/node_modules/tsx/package.json')]) await access(file);
execFileSync(tools.node, ['--version'], { stdio: 'inherit', windowsHide: true });
execFileSync(tools.git, ['--version'], { stdio: 'inherit', windowsHide: true });
console.log(`Payload verified: ${manifest.version} ${manifest.platform}-${manifest.arch}`);
