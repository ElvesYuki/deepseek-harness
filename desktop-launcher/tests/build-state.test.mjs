/** A completed build may only be reused with matching source and build inputs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordBuild, verifyBuild } from '../scripts/build-state.mjs';
test('resume refuses missing records and changed inputs, while unrelated logs do not invalidate it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-build-state-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const launcher = join(root, 'desktop-launcher'), payload = join(root, 'payload');
  for (const dir of ['src', 'scripts', 'installer']) await mkdir(join(launcher, dir), { recursive: true });
  await mkdir(payload);
  for (const name of ['source.json', 'source.tar.gz']) await writeFile(join(root, name), name);
  for (const name of ['package.json', 'package-lock.json', 'toolchain.json', '.npmrc', 'src/main.mjs', 'scripts/build.mjs', 'installer/windows.nsh']) await writeFile(join(launcher, name), name);
  await assert.rejects(verifyBuild(launcher, payload), { code: 'ENOENT' });
  await recordBuild(launcher, payload); await verifyBuild(launcher, payload);
  await writeFile(join(root, 'build.log'), 'diagnostics'); await verifyBuild(launcher, payload);
  for (const path of [join(root, 'source.tar.gz'), join(launcher, 'package-lock.json'), join(launcher, 'toolchain.json'), join(launcher, '.npmrc'), join(launcher, 'scripts/build.mjs'), join(launcher, 'installer/windows.nsh')]) {
    await writeFile(path, 'changed');
    await assert.rejects(verifyBuild(launcher, payload), /Build inputs changed/);
    await recordBuild(launcher, payload); await verifyBuild(launcher, payload);
  }
});
