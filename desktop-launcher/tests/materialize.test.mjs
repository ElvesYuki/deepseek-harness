/** Materialization must reproduce the payload tree and keep recovery contents independent. */
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

test('materialization creates independent files even on the same volume', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(source, { recursive: true });
  for (const name of ['one.txt', 'two.txt', 'three.txt']) await writeFile(join(source, name), name);
  const result = await materializeTree(source, join(root, 'target'));
  assert.equal(result.linked, 0);
  assert.equal(result.copied, 3);
  await writeFile(join(root, 'target/one.txt'), 'changed');
  assert.equal(await readFile(join(source, 'one.txt'), 'utf8'), 'one.txt');
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
  await writeFile(join(root, 'target/alias/file.txt'), 'updated');
  assert.equal(await readFile(join(source, 'real/file.txt'), 'utf8'), 'content');
});

test('materialization rejects links outside the recovery payload', async t => {
  const root = await fixture(t);
  const source = join(root, 'source');
  await mkdir(source);
  await mkdir(join(root, 'outside'));
  await symlink(join(root, 'outside'), join(source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(materializeTree(source, join(root, 'target')), { code: 'payload' });
});
