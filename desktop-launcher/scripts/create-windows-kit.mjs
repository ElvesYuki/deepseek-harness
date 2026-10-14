/** Export a clean tracked source snapshot and the independent launcher as a Windows build kit. */
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

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
execFileSync('/usr/bin/tar', ['-xf', join(temporary, 'source.tar'), '-C', source]);
await rm(join(source, 'desktop-launcher'), { recursive: true, force: true });
// Windows extraction needs no Developer Mode: materialize only links whose resolved targets stay inside this snapshot.
async function materialize(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path), rel = relative(source, target);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Source link escapes the snapshot');
      const directory = (await stat(target)).isDirectory();
      await unlink(path); await cp(target, path, { recursive: directory, dereference: true });
    } else if (entry.isDirectory()) await materialize(path);
  }
}
await materialize(source);
const archive = join(kit, 'source.tar.gz');
execFileSync('/usr/bin/tar', ['-czf', archive, '-C', source, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
await writeFile(join(kit, 'source.json'), JSON.stringify({ commit, version: manifest.version, sha256: createHash('sha256').update(await readFile(archive)).digest('hex') }, null, 2) + '\n');
const launcher = join(kit, 'desktop-launcher'); await mkdir(launcher);
for (const name of ['src', 'ui', 'scripts', 'tests', 'package.json', 'package-lock.json', 'pnpm-workspace.yaml', 'README.md', 'README.zh.md']) {
  await cp(join(root, name), join(launcher, name), { recursive: true });
}
for (const name of ['Build-Windows.cmd', 'Continue-Packaging.cmd', 'Build-Windows.ps1', 'README.txt']) await cp(join(root, 'windows', name), join(kit, name));
await writeFile(join(kit, 'proxy.txt'), '');
const dist = join(cache, 'dist'); await mkdir(dist, { recursive: true });
const output = join(dist, `DSH-Launcher-${version}-Windows-Build-Kit.zip`);
await rm(output, { force: true });
execFileSync('/usr/bin/zip', ['-q', '-r', output, `DSH-Launcher-${version}-Windows-Build-Kit`], { cwd: temporary });
console.log(`WINDOWS_BUILD_KIT: ${output}`);
console.log(`SHA256: ${createHash('sha256').update(await readFile(output)).digest('hex')}`);
await rm(temporary, { recursive: true, force: true });
