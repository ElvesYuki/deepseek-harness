/** Exercise official release preparation and activation in disposable launcher state. */
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';
import { Manager } from '../src/manager.mjs';
const base = resolve(import.meta.dirname, '..');
const root = join(base, '.cache/test-results/update');
await rm(root, { recursive: true, force: true });
await mkdir(join(root, 'versions/fixture'), { recursive: true });
const server = createServer();
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const port = server.address().port;
await new Promise(done => server.close(done));
process.env.PATH = '/usr/bin:/bin';
let output = '';
const manager = new Manager(root, join(base, '.cache/payload'), () => {}, line => { output += line + '\n'; process.stdout.write(line + '\n'); });
try {
  await manager.initialize();
  await manager.saveSettings({ ...manager.settings, port, proxy: process.env.LAUNCHER_TEST_PROXY || '' });
  manager.registry.active = { id: 'fixture', version: '0.0.0' };
  await manager.persist();
  await mkdir(manager.paths.home, { recursive: true });
  await writeFile(join(manager.paths.home, 'launcher-smoke-marker'), 'preserve');
  await manager.exclusive(signal => manager.prepareUpdate({ tag: 'dsh-v0.2.1-alpha.2', version: '0.2.1-alpha.2' }, signal));
  assert.equal(manager.registry.active.id, 'fixture');
  assert.ok(manager.registry.prepared);
  await manager.exclusive(() => manager.activate());
  assert.equal(manager.registry.recoveryRequired, false);
  assert.equal(await readFile(join(manager.registry.backup, 'dsh-home/launcher-smoke-marker'), 'utf8'), 'preserve');
  assert.equal(manager.snapshot().running, true);
  console.log('OFFICIAL_RELEASE_BUILD_ACTIVATE_OK');
} finally {
  await manager.close();
  await writeFile(join(root, 'update.log'), output);
}
