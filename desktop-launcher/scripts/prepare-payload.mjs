/** Build an offline first-run payload from the current tracked checkout and pinned platform tools. */
import { mkdir, readFile, writeFile, rm, rename, access, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { run } from '../src/process.mjs';
import { childEnvironment, DEFAULTS } from '../src/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(root, '..');
const cache = join(root, '.cache');
const stage = join(cache, 'payload-staging');
const target = join(cache, 'payload');
const gitRelease = 'v2.53.0-4';
const gitName = `dugite-native-v2.53.0-4098283-macOS-${process.arch}.tar.gz`;
const gitHashes = { arm64: 'f9dc64635a5b62fbd7ad95db73268bbb8912255ac516d65d37bf7af22fcb8ffe',
  x64: 'ae6686718aa34f4140424db16b92a47dcffd6d1f312eb8b5f3b267f7404e2680' };
const nodeVersion = '24.14.1';
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const output = chunk => process.stdout.write(chunk);

async function command(binary, args, cwd = root, env = process.env) {
  return run(binary, args, { cwd, env }, output, abort.signal);
}
async function download(url, path) {
  try { await access(path); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await command('/usr/bin/curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '30', '--max-time', '1800', '--output', path + '.part', url]);
  await rename(path + '.part', path);
}
async function verify(path, expected, algorithm = 'sha256', encoding = 'hex') {
  const digest = createHash(algorithm).update(await readFile(path)).digest(encoding);
  if (digest !== expected) throw new Error(`Integrity mismatch: ${path}. Remove the cached file and retry.`);
}
async function main() {
  if (process.platform !== 'darwin' || !gitHashes[process.arch]) throw new Error('Payload preparation requires macOS arm64 or x64.');
  await mkdir(cache, { recursive: true });
  const lock = await open(join(cache, 'prepare.lock'), 'wx');
  try {
    const manifest = JSON.parse(await readFile(join(repository, 'package.json'), 'utf8'));
    const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager)?.[1];
    if (!pnpmVersion) throw new Error('Unsupported package manager declaration.');
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repository, encoding: 'utf8' }).trim();
    if (dirty) throw new Error('Commit tracked changes before preparing the bundled snapshot. Untracked launcher files are excluded.');
    await rm(stage, { recursive: true, force: true });
    for (const folder of ['node', 'git', 'pnpm', 'dsh']) await mkdir(join(stage, folder), { recursive: true });
    const nodeName = `node-v${nodeVersion}-darwin-${process.arch}.tar.gz`;
    await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`, join(cache, 'node-shasums.txt'));
    const hashes = await readFile(join(cache, 'node-shasums.txt'), 'utf8');
    const hash = hashes.split('\n').find(line => line.endsWith(`  ${nodeName}`))?.split(' ')[0];
    if (!hash) throw new Error('Node archive is absent from official checksums.');
    await download(`https://nodejs.org/dist/v${nodeVersion}/${nodeName}`, join(cache, nodeName));
    await verify(join(cache, nodeName), hash);
    await command('/usr/bin/tar', ['-xzf', join(cache, nodeName), '--strip-components=1', '-C', join(stage, 'node')]);
    await download(`https://github.com/desktop/dugite-native/releases/download/${gitRelease}/${gitName}`, join(cache, gitName));
    await verify(join(cache, gitName), gitHashes[process.arch]);
    await command('/usr/bin/tar', ['-xzf', join(cache, gitName), '-C', join(stage, 'git')]);
    const metadata = join(cache, `pnpm-${pnpmVersion}.json`);
    await download(`https://registry.npmjs.org/pnpm/${pnpmVersion}`, metadata);
    const dist = JSON.parse(await readFile(metadata, 'utf8')).dist;
    const archive = join(cache, `pnpm-${pnpmVersion}.tgz`);
    const url = new URL(dist.tarball);
    if (url.origin !== 'https://registry.npmjs.org') throw new Error('Unexpected pnpm artifact origin.');
    await download(url.href, archive);
    const integrity = /^sha512-(.+)$/.exec(dist.integrity);
    if (!integrity) throw new Error('Missing pnpm SHA-512 integrity.');
    await verify(archive, integrity[1], 'sha512', 'base64');
    await command('/usr/bin/tar', ['-xzf', archive, '--strip-components=1', '-C', join(stage, 'pnpm')]);
    const snapshot = join(cache, 'source.tar');
    await command('git', ['archive', '--format=tar', '--output', snapshot, commit], repository);
    await command('/usr/bin/tar', ['-xf', snapshot, '-C', join(stage, 'dsh')]);
    // A committed launcher must not recursively enter its own distribution payload.
    await rm(join(stage, 'dsh/desktop-launcher'), { recursive: true, force: true });
    const nodeBin = join(stage, 'node/bin');
    const gitBin = join(stage, 'git/bin');
    const paths = { nodeBin, gitBin, gitExec: join(stage, 'git/libexec/git-core'), home: join(cache, 'build-home') };
    const env = childEnvironment(process.env, { ...DEFAULTS, proxy: process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '' }, 'update', paths);
    env.GIT_CEILING_DIRECTORIES = stage;
    env.DSH_CLIENT_COMMIT_HASH = commit;
    const node = join(nodeBin, 'node');
    const pnpm = join(stage, 'pnpm/bin/pnpm.cjs');
    await command(node, ['--version'], stage, env);
    await command(join(gitBin, 'git'), ['--version'], stage, env);
    await command(node, [pnpm, '--version'], join(stage, 'dsh'), env);
    await command(node, [pnpm, 'install', '--frozen-lockfile'], join(stage, 'dsh'), env);
    await command(node, [pnpm, 'run', 'build'], join(stage, 'dsh'), env);
    await command(node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--help'], join(stage, 'dsh'), env);
    await access(join(stage, 'dsh/apps/web/dist/index.html'));
    await writeFile(join(stage, 'manifest.json'), JSON.stringify({ version: manifest.version, commit,
      packageManager: manifest.packageManager, nodeVersion, platform: process.platform, arch: process.arch,
      gitSource: 'https://github.com/desktop/dugite-native', gitRelease, gitSha256: gitHashes[process.arch] }, null, 2) + '\n');
    await rm(target + '.previous', { recursive: true, force: true });
    try { await rename(target, target + '.previous'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rename(stage, target);
    console.log(`PAYLOAD_READY: ${target}`);
  } finally { await lock.close(); await rm(join(cache, 'prepare.lock')); }
}
await main().catch(error => { console.error(error); process.exitCode = 1; });
