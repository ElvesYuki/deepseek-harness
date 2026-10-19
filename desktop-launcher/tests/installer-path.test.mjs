/** Installer verification must not silently inspect a previous release. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installerPath } from '../scripts/installer-path.mjs';

test('installer selection requires the requested version even when older installers exist', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'DSH-Launcher-0.1.9-Windows-x64-Setup.exe'), 'old');
  await assert.rejects(installerPath(root, '0.1.10'), { code: 'ENOENT' });
  const current = join(root, 'DSH-Launcher-0.1.10-Windows-x64-Setup.exe');
  await writeFile(current, 'current');
  assert.equal(await installerPath(root, '0.1.10'), current);
  const custom = join(root, 'custom.exe');
  await writeFile(custom, 'custom');
  assert.equal(await installerPath(root, '0.1.10', custom), custom);
  await assert.rejects(installerPath(root, '0.1.10', join(root, 'missing.exe')), { code: 'ENOENT' });
});
