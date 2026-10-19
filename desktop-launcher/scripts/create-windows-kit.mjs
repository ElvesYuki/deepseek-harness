/** Export a clean tracked source snapshot and the independent launcher as a Windows build kit. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { c } from 'tar';
import { extractSource, zipDirectory } from './archive.mjs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..'), repository = resolve(root, '..');
const cache = join(root, '.cache');
await mkdir(cache, { recursive: true });
const temporary = await mkdtemp(join(cache, 'windows-kit-'));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const kit = join(temporary, `DSH-Launcher-${version}-Windows-Build-Kit`), source = join(temporary, 'source');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository, encoding: 'utf8' }).trim()) throw new Error('Commit tracked changes before exporting the DSH source snapshot');
await mkdir(source); await mkdir(kit);
execFileSync('git', ['archive', '--format=tar', '--output', join(temporary, 'source.tar'), commit], { cwd: repository });
await extractSource(join(temporary, 'source.tar'), source);
await rm(join(source, 'desktop-launcher'), { recursive: true, force: true });
const archive = join(kit, 'source.tar.gz');
await c({ gzip: true, file: archive, cwd: source, portable: true }, ['.']);
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
await writeFile(join(kit, 'source.json'), JSON.stringify({ commit, version: manifest.version, sha256: createHash('sha256').update(await readFile(archive)).digest('hex') }, null, 2) + '\n');
const launcher = join(kit, 'desktop-launcher'); await mkdir(launcher);
for (const name of ['src', 'ui', 'scripts', 'tests', 'installer', 'package.json', 'package-lock.json', 'toolchain.json', 'pnpm-workspace.yaml', 'README.md', 'README.zh.md', 'README.i18n.yaml', '.gitignore', '.npmrc', 'oxlint.launcher.json']) {
  await cp(join(root, name), join(launcher, name), { recursive: true });
}
for (const name of ['Build-Windows.cmd', 'Continue-Packaging.cmd', 'Build-Windows.ps1', 'README.txt']) await cp(join(root, 'windows', name), join(kit, name));
await writeFile(join(kit, 'proxy.txt'), '');
const dist = join(cache, 'dist'); await mkdir(dist, { recursive: true });
const output = join(dist, `DSH-Launcher-${version}-Windows-Build-Kit.zip`);
if (process.argv.includes('--directory')) {
  console.log(`WINDOWS_BUILD_DIRECTORY: ${kit}`);
} else {
  await zipDirectory(kit, output + '.partial', `DSH-Launcher-${version}-Windows-Build-Kit`);
  const { rename } = await import('node:fs/promises');
  await rename(output + '.partial', output);
  console.log(`WINDOWS_BUILD_KIT: ${output}`);
  console.log(`SHA256: ${createHash('sha256').update(await readFile(output)).digest('hex')}`);
  await rm(temporary, { recursive: true, force: true });
}
