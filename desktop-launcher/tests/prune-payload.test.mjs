/** Pruning removes debugger and repository-only content while keeping the runtime skill roots. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prunePayload } from '../scripts/prune-payload.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-prune-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

const exists = path => access(path).then(() => true, () => false);

test('pruning drops source maps and repository-only trees while keeping skills', async t => {
  const root = await fixture(t);
  for (const folder of ['packages/core/lib', '.agents/notes/archived', '.agents/skills/dsh-doc', 'snapshots/session', 'docs']) {
    await mkdir(join(root, folder), { recursive: true });
  }
  await writeFile(join(root, 'packages/core/lib/index.js'), 'code');
  await writeFile(join(root, 'packages/core/lib/index.js.map'), 'map');
  await writeFile(join(root, 'packages/core/lib/.gitkeep'), '');
  await writeFile(join(root, '.agents/notes/archived/note.md'), 'note');
  await writeFile(join(root, '.agents/skills/dsh-doc/SKILL.md'), 'skill');
  await writeFile(join(root, 'snapshots/session/case.jsonl'), 'case');
  await writeFile(join(root, 'docs/guide.md'), 'guide');
  const result = await prunePayload(root);
  assert.equal(result.files, 4);
  assert.equal(await exists(join(root, 'packages/core/lib/index.js.map')), false);
  assert.equal(await exists(join(root, 'packages/core/lib/.gitkeep')), false);
  assert.equal(await exists(join(root, '.agents/notes')), false);
  assert.equal(await exists(join(root, 'snapshots')), false);
  assert.equal(await exists(join(root, 'packages/core/lib/index.js')), true);
  assert.equal(await exists(join(root, '.agents/skills/dsh-doc/SKILL.md')), true);
  assert.equal(await exists(join(root, 'docs/guide.md')), true);
});

test('pruning an already pruned payload reports nothing removed', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'packages'), { recursive: true });
  await writeFile(join(root, 'packages/index.js'), 'code');
  assert.deepEqual(await prunePayload(root), { files: 0, bytes: 0 });
});
