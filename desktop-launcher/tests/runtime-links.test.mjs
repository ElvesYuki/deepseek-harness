/** Package links must survive relocation without referencing the build machine. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sealRuntimeLinks, restoreRuntimeLinks } from '../src/runtime-links.mjs';
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'launcher-links-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'build'); await mkdir(root); return { base, root };
}
test('directory links are sealed and recreated against the relocated runtime', async t => {
  const { base, root } = await fixture(t);
  await mkdir(join(root, 'packages', 'example'), { recursive: true });
  await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'packages/example/index.js'), 'export default 42');
  await symlink(join(root, 'packages/example'), join(root, 'node_modules/example'), process.platform === 'win32' ? 'junction' : 'dir');
  await sealRuntimeLinks(root);
  await assert.rejects(lstat(join(root, 'node_modules/example')), { code: 'ENOENT' });
  const installed = join(base, 'installed'); await rename(root, installed);
  await restoreRuntimeLinks(installed);
  assert.equal(await readFile(join(installed, 'node_modules/example/index.js'), 'utf8'), 'export default 42');
});
test('escaping links and escaping serialized targets are rejected', async t => {
  const { base, root } = await fixture(t);
  const outside = join(base, 'outside'); await mkdir(outside);
  await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(sealRuntimeLinks(root), /escapes/);
  await writeFile(join(root, '.launcher-links.json'), JSON.stringify([{ path: 'new', target: '../outside' }]));
  await assert.rejects(restoreRuntimeLinks(root), /escapes/);
  await assert.rejects(lstat(join(root, 'new')), { code: 'ENOENT' });
});
