/** Build a Windows x64 offline payload from the checksum-verified source snapshot in a build kit. */
import { access, cp, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { run } from '../src/process.mjs';
import { childEnvironment, DEFAULTS } from '../src/core.mjs';
import { toolPaths } from '../src/platform.mjs';
import { sealRuntimeLinks } from '../src/runtime-links.mjs';

const root = resolve(import.meta.dirname, '..'), kit = resolve(root, '..');
const cache = join(root, '.cache'), stage = join(cache, 'payload-staging'), target = join(cache, 'payload');
const gitRelease = 'v2.53.0-4', gitName = 'dugite-native-v2.53.0-4098283-windows-x64.tar.gz';
const gitHash = '7b76bc5c32c0d7c5984efdc2a8a32697cf1e8a43bc55176fbf9869c0ee995130';
const nodeVersion = '24.14.1';
const output = text => process.stdout.write(text);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort()); process.once('SIGTERM', () => abort.abort());
const command = (binary, args, cwd = root, env = process.env) => run(binary, args, { cwd, env }, output, abort.signal);
const tar = join(process.env.SystemRoot || 'C:\\Windows', 'System32/tar.exe');
const curl = join(process.env.SystemRoot || 'C:\\Windows', 'System32/curl.exe');
async function verify(path, expected, algorithm = 'sha256', encoding = 'hex') {
  if (createHash(algorithm).update(await readFile(path)).digest(encoding) !== expected) throw new Error(`Checksum mismatch: ${path}`);
}
async function download(url, file) {
  try { await access(file); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await command(curl, ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '1800', '--output', file + '.part', url]);
  await rename(file + '.part', file);
}
async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Run this build kit on Windows x64 using its bundled Node.');
  if (process.versions.node !== nodeVersion) throw new Error('Use Build-Windows.cmd to select the pinned Node version.');
  await mkdir(cache, { recursive: true });
  const lockPath = join(cache, 'prepare-windows.lock'), lock = await open(lockPath, 'wx');
  try {
    const snapshot = JSON.parse(await readFile(join(kit, 'source.json'), 'utf8'));
    if (!/^[a-f0-9]{40}$/.test(snapshot.commit) || !/^[a-f0-9]{64}$/.test(snapshot.sha256)) throw new Error('Invalid source snapshot metadata');
    await verify(join(kit, 'source.tar.gz'), snapshot.sha256);
    await rm(stage, { recursive: true, force: true });
    for (const name of ['node', 'git', 'pnpm', 'dsh']) await mkdir(join(stage, name), { recursive: true });
    await command(tar, ['-xzf', join(kit, 'source.tar.gz'), '-C', join(stage, 'dsh')]);
    const manifest = JSON.parse(await readFile(join(stage, 'dsh/package.json'), 'utf8'));
    const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
    if (!pnpmVersion || manifest.version !== snapshot.version) throw new Error('Source snapshot metadata does not match package.json');
    // Bootstrap verified the pinned Node archive. Copy that private installation, not an ambient Node.
    await cp(dirname(process.execPath), join(stage, 'node'), { recursive: true });
    await download(`https://github.com/desktop/dugite-native/releases/download/${gitRelease}/${gitName}`, join(cache, gitName));
    await verify(join(cache, gitName), gitHash);
    await command(tar, ['-xzf', join(cache, gitName), '-C', join(stage, 'git')]);
    const metadata = join(cache, `pnpm-${pnpmVersion}.json`);
    await download(`https://registry.npmjs.org/pnpm/${pnpmVersion}`, metadata);
    const dist = JSON.parse(await readFile(metadata, 'utf8')).dist;
    if (new URL(dist.tarball).origin !== 'https://registry.npmjs.org') throw new Error('Unexpected pnpm download origin');
    const integrity = /^sha512-(.+)$/.exec(dist.integrity);
    if (!integrity) throw new Error('Missing pnpm integrity');
    const archive = join(cache, `pnpm-${pnpmVersion}.tgz`);
    await download(dist.tarball, archive); await verify(archive, integrity[1], 'sha512', 'base64');
    await command(tar, ['-xzf', archive, '--strip-components=1', '-C', join(stage, 'pnpm')]);
    const paths = toolPaths(stage, join(cache, 'build-home'));
    const env = childEnvironment(process.env, { ...DEFAULTS, proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '' }, 'update', paths);
    env.GIT_CEILING_DIRECTORIES = stage; env.DSH_CLIENT_COMMIT_HASH = snapshot.commit;
    await command(paths.node, ['--version'], stage, env);
    await command(paths.git, ['--version'], stage, env);
    await command(paths.node, [paths.pnpm, '--version'], join(stage, 'dsh'), env);
    await command(paths.node, [paths.pnpm, 'install', '--frozen-lockfile', '--registry=https://registry.npmjs.org'], join(stage, 'dsh'), env);
    await command(paths.node, [paths.pnpm, 'run', 'build'], join(stage, 'dsh'), env);
    await command(paths.node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--help'], join(stage, 'dsh'), env);
    await access(join(stage, 'dsh/apps/web/dist/index.html'));
    await sealRuntimeLinks(join(stage, 'dsh'));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ version: manifest.version, commit: snapshot.commit,
      packageManager: manifest.packageManager, nodeVersion, platform: 'win32', arch: 'x64',
      gitSource: 'https://github.com/desktop/dugite-native', gitRelease, gitSha256: gitHash }, null, 2) + '\n');
    await rm(target + '.previous', { recursive: true, force: true });
    try { await rename(target, target + '.previous'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, target);
    console.log(`WINDOWS_PAYLOAD_READY: ${target}`);
  } finally { await lock.close(); await rm(lockPath); }
}
await main().catch(error => { console.error(error); process.exitCode = 1; });
