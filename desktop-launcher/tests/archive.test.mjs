/** Git-style link archives must export without creating OS links. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Header } from 'tar';
import { extractSource, zipDirectory } from '../scripts/archive.mjs';

async function fixture(t, entries) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data || '');
    const header = new Header({ path: entry.path, type: entry.target ? 'SymbolicLink' : 'File', linkpath: entry.target || '', size: data.length, mode: 0o644 });
    header.encode(); chunks.push(header.block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const file = join(root, 'source.tar'); await writeFile(file, Buffer.concat(chunks));
  return { root, file, output: join(root, 'source') };
}

test('file and directory links become ordinary entries and can be zipped', async t => {
  const { root, file, output } = await fixture(t, [
    { path: 'docs/a.txt', data: 'hello' }, { path: 'docs/b.txt', target: 'a.txt' },
    { path: 'copy', target: 'docs' }, { path: 'alias.txt', target: 'docs/b.txt' },
  ]);
  await extractSource(file, output);
  for (const path of ['docs/b.txt', 'copy/a.txt', 'copy/b.txt', 'alias.txt']) {
    assert.equal(await readFile(join(output, path), 'utf8'), 'hello');
    assert.equal((await lstat(join(output, path))).isSymbolicLink(), false);
  }
  await zipDirectory(output, join(root, 'kit.zip'), 'kit');
  assert.equal((await readFile(join(root, 'kit.zip'))).readUInt32LE(), 0x04034b50);
});
for (const [name, entries] of [
  ['escape', [{ path: 'bad', target: '../outside' }]],
  ['cycle', [{ path: 'a', target: 'b' }, { path: 'b', target: 'a' }]],
]) test(`source ${name} is refused`, async t => {
  const { file, output } = await fixture(t, entries);
  await assert.rejects(extractSource(file, output), /escapes|Cyclic/);
});
