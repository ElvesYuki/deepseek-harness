/** Installation owns deployment; opening an installed app never creates a runtime tree. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-install-'));
  const payload = join(root, 'payload');
  const manager = new Manager(join(root, 'data'), payload, () => {}, () => {}, { requireInstallation: true });
  t.after(async () => { await manager.close(); await rm(root, { recursive: true, force: true }); });
  for (const path of [manager.node, manager.git, manager.pnpm, join(payload, 'dsh/apps/web/dist/index.html'), join(payload, 'dsh/apps/cli/src/bin.ts')]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'fixture');
  }
  await writeFile(join(payload, 'manifest.json'), JSON.stringify({ platform: process.platform, arch: process.arch, version: '1.0.0', files: 2 }));
  await manager.initialize();
  return manager;
}

test('packaged startup refuses missing installation without creating a runtime', async t => {
  const manager = await fixture(t);
  await assert.rejects(manager.exclusive(() => manager.start()), { code: 'installationRequired' });
  assert.equal(manager.registry.active, undefined);
  assert.equal(manager.service, null);
  assert.ok(!(await readdir(manager.root)).includes('versions'));
});

test('installation prepares once; reopening and reinstalling preserve the fixed runtime and data', async t => {
  const manager = await fixture(t);
  await manager.exclusive(() => manager.installRuntime());
  const path = manager.directory(manager.registry.active);
  assert.equal(manager.service, null);
  await writeFile(join(path, 'local-marker'), 'keep');
  await mkdir(manager.paths.home, { recursive: true });
  await writeFile(join(manager.paths.home, 'data-marker'), 'keep');
  // Ordinary startup and repeated installation must not even read the original source tree.
  await rm(join(manager.payload, 'dsh'), { recursive: true });
  const reopened = new Manager(manager.root, manager.payload, () => {}, () => {}, { requireInstallation: true });
  await reopened.initialize();
  await reopened.ensureInitial();
  await reopened.exclusive(() => reopened.installRuntime());
  assert.equal(reopened.directory(reopened.registry.active), path);
  assert.equal(await readFile(join(path, 'local-marker'), 'utf8'), 'keep');
  assert.equal(await readFile(join(manager.paths.home, 'data-marker'), 'utf8'), 'keep');
  assert.equal(reopened.service, null);
  await reopened.close();
});

test('installer retries cannot overwrite interrupted maintenance', async t => {
  const manager = await fixture(t);
  await manager.exclusive(() => manager.installRuntime());
  manager.registry.maintenance = { kind: 'restore', id: manager.registry.active.id };
  await manager.persist();
  await assert.rejects(manager.exclusive(() => manager.installRuntime()), { code: 'maintenance' });
  assert.ok(manager.registry.maintenance);
});
