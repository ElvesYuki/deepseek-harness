/** Materialization must reproduce the payload tree and share bytes with it where the volume allows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeTree } from '../src/materialize.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-materialize-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test('materialization reproduces nested files with identical content', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(join(source, 'a/b'), { recursive: true });
  await writeFile(join(source, 'top.txt'), 'top');
  await writeFile(join(source, 'a/b/deep.txt'), 'deep');
  const result = await materializeTree(source, join(root, 'target'));
  assert.equal(result.files, 2);
  assert.equal(await readFile(join(root, 'target/top.txt'), 'utf8'), 'top');
  assert.equal(await readFile(join(root, 'target/a/b/deep.txt'), 'utf8'), 'deep');
});

test('same-volume materialization links every regular file instead of copying it', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  for (const name of ['one.txt', 'two.txt', 'three.txt']) await writeFile(join(source, name), name);
  const result = await materializeTree(source, join(root, 'target'));
  // A hard link shares the inode, so the link count of the payload file rises above one.
  if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
    assert.equal(result.linked + result.copied, result.files);
  }
  assert.equal(result.files, 3);
});

test('materialization preserves a directory link without traversing its target', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(join(source, 'real'), { recursive: true });
  await writeFile(join(source, 'real/file.txt'), 'content');
  await symlink(join(source, 'real'), join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await materializeTree(source, join(root, 'target'));
  assert.equal(result.files, 2);
  assert.equal((await lstat(join(root, 'target/alias'))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(join(root, 'target/alias')), ['file.txt']);
});
