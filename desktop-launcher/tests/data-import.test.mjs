/** Import tests use private homes and never modify the developer's DSH data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';
import { inspectHome, recoverImport } from '../src/data-import.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'launcher-import-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'client'), source = join(base, 'source');
  await mkdir(join(source, 'sessions'), { recursive: true });
  await mkdir(root);
  await writeFile(join(source, 'sessions', 'chat.jsonl'), 'source conversation');
  const manager = new Manager(root, join(base, 'payload'), () => {}, () => {});
  await mkdir(manager.paths.home);
  await writeFile(join(manager.paths.home, 'old.txt'), 'old data');
  await manager.persist();
  return { base, root, source, manager };
}
test('imports a separate home, backs up the old data and leaves the service stopped', async t => {
  const { manager, source, root } = await fixture(t);
  let stopped = false;
  manager.service = { ended: false, stop: async () => { stopped = true; } };
  await manager.exclusive(() => manager.importData(source));
  assert.equal(stopped, true);
  assert.equal(manager.service, null);
  assert.equal(await readFile(join(manager.paths.home, 'sessions/chat.jsonl'), 'utf8'), 'source conversation');
  assert.equal(await readFile(join(source, 'sessions/chat.jsonl'), 'utf8'), 'source conversation');
  await assert.rejects(readFile(join(manager.paths.home, 'old.txt')), { code: 'ENOENT' });
  const [backup] = await readdir(join(root, 'backups'));
  assert.equal(await readFile(join(root, 'backups', backup, 'dsh-home/old.txt'), 'utf8'), 'old data');
  assert.equal(JSON.parse(await readFile(join(root, 'runtime.json'))).importPending, undefined);
});
test('refuses absent, unrelated, overlapping and symlink-aliased launcher directories', async t => {
  const { manager, base, root } = await fixture(t);
  await mkdir(join(root, 'sessions'));
  const nested = join(root, '..source'); await mkdir(join(nested, 'sessions'), { recursive: true });
  await assert.rejects(inspectHome(nested, root), { code: 'importSource' });
  const alias = join(base, 'alias'); await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of [join(base, 'missing'), base, root, alias, manager.paths.home]) {
    await assert.rejects(inspectHome(path, root), { code: 'importSource' });
  }
  const empty = join(base, 'empty'); await mkdir(empty);
  await assert.rejects(inspectHome(empty, root), { code: 'importSource' });
});
test('refuses links without changing source or existing client data', async t => {
  const { manager, source, base } = await fixture(t);
  const external = join(base, 'external'); await mkdir(external); await writeFile(join(external, 'marker'), 'untouched');
  await symlink(external, join(source, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.exclusive(() => manager.importData(source)), { code: 'importLinks' });
  assert.equal(await readFile(join(manager.paths.home, 'old.txt'), 'utf8'), 'old data');
  assert.equal(await readFile(join(external, 'marker'), 'utf8'), 'untouched');
});
test('a failed commit restores the previous home and clears the import journal', async t => {
  const { manager, source } = await fixture(t);
  const persist = manager.persist.bind(manager); let writes = 0;
  manager.persist = async () => { if (++writes === 2) throw new Error('disk write failed'); await persist(); };
  await assert.rejects(manager.exclusive(() => manager.importData(source)), { code: 'importFailed' });
  assert.equal(await readFile(join(manager.paths.home, 'old.txt'), 'utf8'), 'old data');
  assert.equal(manager.registry.importPending, undefined);
});
for (const phase of ['beforeSwap', 'oldMoved', 'newMoved']) {
  test(`reopening an interrupted import restores the old home: ${phase}`, async t => {
    const { manager, source, root } = await fixture(t);
    const backup = join(root, 'backups/import-abc'); await mkdir(backup, { recursive: true });
    manager.registry.importPending = { id: 'import-abc', hadData: true }; await manager.persist();
    if (phase !== 'beforeSwap') await rename(manager.paths.home, join(backup, 'dsh-home'));
    if (phase === 'newMoved') await rename(source, manager.paths.home);
    await manager.initialize();
    assert.equal(await readFile(join(manager.paths.home, 'old.txt'), 'utf8'), 'old data');
    assert.equal(manager.registry.importPending, undefined);
  });
}
test('failed recovery blocks startup, including explicit retry', async t => {
  const { manager } = await fixture(t);
  await rm(manager.paths.home, { recursive: true });
  manager.registry.importPending = { id: 'import-abc', hadData: true };
  await assert.rejects(recoverImport(manager), { code: 'importRecovery' });
  await assert.rejects(manager.start(), { code: 'importRecovery' });
  await assert.rejects(manager.retry(), { code: 'importRecovery' });
  await assert.rejects(manager.exclusive(() => manager.activate()), { code: 'importRecovery' });
});
test('a new home can be imported without preexisting client data', async t => {
  const { manager, source } = await fixture(t);
  await rm(manager.paths.home, { recursive: true });
  await manager.exclusive(() => manager.importData(source));
  assert.equal(await readFile(join(manager.paths.home, 'sessions/chat.jsonl'), 'utf8'), 'source conversation');
});

test('interrupted first import quarantines uncommitted data without creating a previous home', async t => {
  const { manager, root } = await fixture(t);
  const backup = join(root, 'backups/import-def'); await mkdir(backup, { recursive: true });
  manager.registry.importPending = { id: 'import-def', hadData: false }; await manager.persist();
  await manager.initialize();
  await assert.rejects(readFile(join(manager.paths.home, 'old.txt')), { code: 'ENOENT' });
  const [discarded] = await readdir(backup);
  assert.equal(await readFile(join(backup, discarded, 'old.txt'), 'utf8'), 'old data');
});

test('shared generated dependencies are skipped, including broken links; profiles and sessions survive', async t => {
  const { manager, source, base } = await fixture(t);
  const modules = join(source, 'profiles/node_modules');
  await mkdir(modules, { recursive: true });
  await symlink(join(base, 'removed-installation'), join(modules, 'old-package'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(join(source, 'profiles/web/node_modules/custom-plugin'), { recursive: true });
  await writeFile(join(source, 'profiles/web/package.json'), '{"dependencies":{"custom-plugin":"1.0.0"}}');
  await writeFile(join(source, 'profiles/web/cordis.patch.yml'), 'plugins: {}');
  await writeFile(join(source, 'profiles/web/node_modules/custom-plugin/index.js'), 'export default 1');
  await manager.exclusive(() => manager.importData(source));
  await assert.rejects(readdir(join(manager.paths.home, 'profiles/node_modules')), { code: 'ENOENT' });
  assert.equal(await readFile(join(manager.paths.home, 'sessions/chat.jsonl'), 'utf8'), 'source conversation');
  assert.equal(await readFile(join(manager.paths.home, 'profiles/web/cordis.patch.yml'), 'utf8'), 'plugins: {}');
  assert.equal(await readFile(join(manager.paths.home, 'profiles/web/package.json'), 'utf8'), '{"dependencies":{"custom-plugin":"1.0.0"}}');
  assert.equal(await readFile(join(manager.paths.home, 'profiles/web/node_modules/custom-plugin/index.js'), 'utf8'), 'export default 1');
  assert.deepEqual(await readdir(modules), ['old-package']);
});
test('the shared dependency directory itself can be a broken link', async t => {
  const { manager, source, base } = await fixture(t);
  await mkdir(join(source, 'profiles'));
  await symlink(join(base, 'gone'), join(source, 'profiles/node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  await manager.exclusive(() => manager.importData(source));
  assert.equal(await readFile(join(manager.paths.home, 'sessions/chat.jsonl'), 'utf8'), 'source conversation');
});
test('unsupported persistent links report their relative path and preserve previous data', async t => {
  const { manager, source, base } = await fixture(t);
  await symlink(join(base, 'gone'), join(source, 'sessions/linked-chat'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.exclusive(() => manager.importData(source)), error => error.code === 'importLinks' && error.relativePath === join('sessions', 'linked-chat'));
  assert.equal(manager.snapshot().failurePath, join('sessions', 'linked-chat'));
  assert.equal(await readFile(join(manager.paths.home, 'old.txt'), 'utf8'), 'old data');
});
