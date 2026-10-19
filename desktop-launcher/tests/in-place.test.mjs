/** In-place maintenance preserves data and blocks startup until a complete runtime has started. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, link, access, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';
import { LauncherError } from '../src/core.mjs';
import { detachRuntimeFiles } from '../src/runtime-files.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { UPSTREAM } from '../src/core.mjs';
const exec = promisify(execFile);
const oldCommit = '1'.repeat(40), newCommit = '2'.repeat(40);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-inplace-'));
  const manager = new Manager(root, join(root, 'payload'), () => {}, () => {});
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await manager.initialize();
  manager.registry.active = { id: 'existing-runtime', version: '1.0.0', commit: oldCommit };
  const runtime = manager.directory(manager.registry.active);
  await mkdir(join(runtime, 'apps/web/dist'), { recursive: true });
  await writeFile(join(runtime, 'apps/web/dist/index.html'), '<html>fixture</html>');
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ version: '2.0.0', packageManager: 'pnpm@11.28.5', engines: { node: '>=24' } }));
  await mkdir(manager.payload);
  await writeFile(join(manager.payload, 'manifest.json'), JSON.stringify({ packageManager: 'pnpm@11.28.5', nodeVersion: '24.14.1' }));
  await mkdir(manager.paths.home);
  await writeFile(join(manager.paths.home, 'session'), 'preserve');
  await manager.persist();
  const commands = [];
  manager.runtimeCommand = async (binary, args) => {
    commands.push(args);
    const saved = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
    assert.ok(saved.maintenance);
    assert.equal(manager.directory(manager.registry.active), runtime);
    return args[0] === 'rev-parse' ? newCommit : '';
  };
  manager.startService = async maintenance => { assert.equal(maintenance, true); };
  return { manager, runtime, commands };
}

test('updates keep the runtime path, shallow-fetch only the selected tag, and create no backup', async t => {
  const { manager, runtime, commands } = await fixture(t);
  await manager.exclusive(signal => manager.update({ kind: 'release', tag: 'dsh-v2.0.0' }, signal));
  assert.equal(manager.directory(manager.registry.active), runtime);
  assert.equal(manager.registry.active.commit, newCommit);
  assert.equal(manager.registry.maintenance, undefined);
  const fetch = commands.find(args => args.includes('fetch'));
  assert.ok(fetch.includes('--depth=1') && fetch.includes('--no-tags'));
  assert.equal(fetch.at(-1), 'refs/tags/dsh-v2.0.0');
  assert.equal(await readFile(join(manager.paths.home, 'session'), 'utf8'), 'preserve');
  await assert.rejects(access(join(manager.root, 'backups')), { code: 'ENOENT' });
});

test('failed builds block normal startup after reopening; repair retries the interrupted commit', async t => {
  const { manager, runtime, commands } = await fixture(t);
  const command = manager.runtimeCommand;
  manager.runtimeCommand = async (binary, args) => {
    if (args.includes('build')) throw new LauncherError('command');
    return command(binary, args);
  };
  await assert.rejects(manager.exclusive(signal => manager.update({ kind: 'commit', commit: newCommit }, signal)), { code: 'command' });
  const reopened = new Manager(manager.root, manager.payload, () => {}, () => {});
  t.after(() => reopened.close());
  await reopened.initialize();
  assert.equal(reopened.failure, 'maintenance');
  await assert.rejects(reopened.start(), { code: 'maintenance' });
  await assert.rejects(reopened.startService(), { code: 'maintenance' });
  reopened.runtimeCommand = command;
  reopened.startService = async () => {};
  await reopened.exclusive(signal => reopened.repair(signal));
  assert.equal(reopened.directory(reopened.registry.active), runtime);
  assert.equal(commands.filter(args => args.includes('fetch')).at(-1).at(-1), newCommit);
  assert.equal(reopened.registry.maintenance, undefined);
});

test('a failed new runtime start retains the journal and leaves user data intact', async t => {
  const { manager } = await fixture(t);
  manager.startService = async () => { throw new LauncherError('start'); };
  await assert.rejects(manager.exclusive(signal => manager.update({ kind: 'release', tag: 'dsh-v2.0.0' }, signal)), { code: 'start' });
  assert.ok(JSON.parse(await readFile(join(manager.root, 'runtime.json'), 'utf8')).maintenance);
  assert.equal(await readFile(join(manager.paths.home, 'session'), 'utf8'), 'preserve');
});

test('legacy hardlinks are detached before in-place writes', async t => {
  const { manager, runtime } = await fixture(t);
  const original = join(manager.payload, 'original');
  await writeFile(original, 'original');
  await link(original, join(runtime, 'shared'));
  assert.equal(await detachRuntimeFiles(runtime), 1);
  await writeFile(join(runtime, 'shared'), 'updated');
  assert.equal(await readFile(original, 'utf8'), 'original');
});

test('offline restoration reuses the exact runtime directory and never copies user data', async t => {
  const { manager, runtime } = await fixture(t);
  await mkdir(join(manager.payload, 'dsh/apps/web/dist'), { recursive: true });
  await writeFile(join(manager.payload, 'dsh/apps/web/dist/index.html'), 'bundled');
  await writeFile(join(manager.payload, 'dsh/.launcher-links.json'), '[]');
  await writeFile(join(manager.payload, 'manifest.json'), JSON.stringify({ version: '1.0.0', commit: oldCommit, platform: process.platform, arch: process.arch, files: 2 }));
  manager.runtimeCommand = async () => { throw new Error('Offline restore must not run Git or pnpm'); };
  await manager.exclusive(signal => manager.restoreBundled(signal));
  assert.equal(manager.directory(manager.registry.active), runtime);
  assert.equal(manager.registry.active.commit, oldCommit);
  assert.equal(await readFile(join(runtime, 'apps/web/dist/index.html'), 'utf8'), 'bundled');
  assert.deepEqual((await readdir(runtime)).sort(), ['.launcher-links.json', 'apps']);
  assert.equal(await readFile(join(manager.paths.home, 'session'), 'utf8'), 'preserve');
  assert.equal(manager.registry.maintenance, undefined);
});

test('cancellation preserves an interruption marker for repair', async t => {
  const { manager } = await fixture(t);
  await assert.rejects(manager.exclusive(() => manager.update({ kind: 'commit', commit: newCommit }, AbortSignal.abort())), { code: 'cancelled' });
  assert.ok(manager.registry.maintenance);
});

test('repair of the bundled fork commit uses its exact offline payload', async t => {
  const { manager } = await fixture(t);
  await writeFile(join(manager.payload, 'manifest.json'), JSON.stringify({ commit: oldCommit }));
  let restored = false;
  manager.restoreBundled = async () => { restored = true; };
  manager.runtimeCommand = async () => { throw new Error('Fork repair must not fetch its SHA from upstream'); };
  await manager.exclusive(signal => manager.repair(signal));
  assert.equal(restored, true);
});

test('first offline restoration recovers an unregistered interrupted initial directory', async t => {
  const { manager } = await fixture(t);
  manager.registry = {};
  const current = join(manager.root, 'versions/current');
  await mkdir(current);
  await writeFile(join(current, 'partial'), 'interrupted');
  for (const path of [manager.node, manager.git, manager.pnpm, join(manager.payload, 'dsh/apps/web/dist/index.html')]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  await writeFile(join(manager.payload, 'dsh/.launcher-links.json'), '[]');
  await writeFile(join(manager.payload, 'manifest.json'), JSON.stringify({ version: '1.0.0', commit: oldCommit, platform: process.platform, arch: process.arch, files: 2 }));
  await manager.exclusive(signal => manager.restoreBundled(signal));
  assert.equal(manager.directory(manager.registry.active), current);
  assert.equal(manager.registry.maintenance, undefined);
  await assert.rejects(access(join(current, 'partial')), { code: 'ENOENT' });
  assert.equal(await readFile(join(current, 'apps/web/dist/index.html'), 'utf8'), 'fixture');
});

test('failure to save completion stops the service and retains the durable journal', async t => {
  const { manager } = await fixture(t);
  const persist = manager.persist.bind(manager);
  manager.persist = async () => {
    if (!manager.registry.maintenance && manager.registry.active.commit === newCommit) throw new Error('disk failure');
    await persist();
  };
  let stops = 0;
  manager.stop = async () => { stops++; };
  await assert.rejects(manager.exclusive(signal => manager.update({ kind: 'commit', commit: newCommit }, signal)), /disk failure/);
  assert.equal(stops, 2);
  assert.ok(manager.registry.maintenance);
  assert.ok(JSON.parse(await readFile(join(manager.root, 'runtime.json'), 'utf8')).maintenance);
});

test('a source snapshot without Git metadata can fetch and reset in place, then repair the pinned commit', async t => {
  const { manager, runtime } = await fixture(t);
  const remote = join(manager.root, 'remote');
  const hooks = join(manager.root, 'test-hooks');
  await mkdir(remote); await mkdir(hooks);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args, cwd) => exec('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'commit.gpgsign=false', ...args], { cwd, env });
  await git(['init', '-q'], remote);
  await mkdir(join(remote, 'apps/web/dist'), { recursive: true });
  await writeFile(join(remote, 'package.json'), await readFile(join(runtime, 'package.json')));
  await writeFile(join(remote, 'apps/web/dist/index.html'), 'new');
  await git(['add', '.'], remote);
  await git(['-c', 'user.name=Launcher test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], remote);
  await git(['tag', 'dsh-v2.0.0'], remote);
  const commit = (await git(['rev-parse', 'HEAD'], remote)).stdout.trim();
  await writeFile(join(runtime, 'obsolete.txt'), 'remove');
  manager.runtimeCommand = async (binary, args) => {
    if (binary !== manager.git) return '';
    return (await git(args.map(arg => arg === UPSTREAM ? remote : arg), runtime)).stdout.trim();
  };
  await manager.exclusive(signal => manager.update({ kind: 'release', tag: 'dsh-v2.0.0' }, signal));
  assert.equal(manager.registry.active.commit, commit);
  assert.equal((await git(['rev-parse', '--is-shallow-repository'], runtime)).stdout.trim(), 'true');
  await assert.rejects(access(join(runtime, 'obsolete.txt')), { code: 'ENOENT' });
  await writeFile(join(runtime, 'apps/web/dist/index.html'), 'broken');
  await manager.exclusive(signal => manager.repair(signal));
  assert.equal(await readFile(join(runtime, 'apps/web/dist/index.html'), 'utf8'), 'new');
  assert.equal(manager.directory(manager.registry.active), runtime);
});
