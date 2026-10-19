/** The recorded payload size must match materialization, and a short payload must stay visible. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';
import { materializeTree } from '../src/materialize.mjs';
import { countPayloadFiles } from '../scripts/payload-files.mjs';

async function fixture(t, prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return root;
}

test('the build-time count matches the files materialization reports', async t => {
  const root = await fixture(t, 'launcher-integrity-count-');
  const source = join(root, 'source');
  await mkdir(join(source, 'a/b'), { recursive: true });
  await writeFile(join(source, 'top.txt'), 'top');
  await writeFile(join(source, 'a/b/deep.txt'), 'deep');
  await symlink(join(source, 'a'), join(source, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const counted = await countPayloadFiles(source);
  const materialized = await materializeTree(source, join(root, 'target'));
  assert.equal(materialized.files, counted);
});

test('a payload recorded as unverified keeps reporting an incomplete payload', async t => {
  const root = await fixture(t, 'launcher-integrity-state-');
  await writeFile(join(root, 'runtime.json'), JSON.stringify({
    active: { id: 'bundled-recorded', version: '1.0.0', verified: false, files: 3 },
  }));
  const manager = new Manager(root, join(root, 'payload'), () => {}, () => {});
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal(manager.failure, 'payloadIncomplete');
  for (const start of [() => manager.start(), () => manager.startService()]) {
    await assert.rejects(manager.exclusive(start), { code: 'payloadIncomplete' });
    assert.equal(manager.service, null);
    assert.equal(manager.failure, 'payloadIncomplete');
  }
  manager.registry.recoveryRequired = true;
  await assert.rejects(manager.exclusive(() => manager.startService()), { code: 'payloadIncomplete' });
  assert.equal(manager.registry.recoveryRequired, true);
  assert.equal(manager.service, null);
});

test('an incomplete initial payload never becomes active or starts a service', async t => {
  const root = await fixture(t, 'launcher-integrity-short-');
  const payload = join(root, 'payload');
  const manager = new Manager(join(root, 'data'), payload, () => {}, () => {});
  t.after(() => manager.close());
  for (const path of [manager.node, manager.git, manager.pnpm, join(payload, 'dsh/apps/web/dist/index.html')]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture');
  }
  await writeFile(join(payload, 'manifest.json'), JSON.stringify({
    version: '1.0.0', platform: process.platform, arch: process.arch, files: 2,
  }));
  await manager.initialize();
  await assert.rejects(manager.exclusive(() => manager.start()), { code: 'payloadIncomplete' });
  assert.equal(manager.registry.active, undefined);
  assert.equal(manager.service, null);
  assert.equal(manager.failure, 'payloadIncomplete');
  const staged = await readdir(join(manager.root, 'versions'));
  assert.equal(staged.length, 1);
  assert.ok(staged[0].startsWith('copy-'));
  const reopened = new Manager(manager.root, payload, () => {}, () => {});
  t.after(() => reopened.close());
  await reopened.initialize();
  await assert.rejects(reopened.exclusive(() => reopened.start()), { code: 'payloadIncomplete' });
  assert.equal(reopened.registry.active, undefined);
  assert.equal(reopened.service, null);
});
