/** Exercise the bundled runtime without a developer Node, pnpm, or Git on PATH. */
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { Manager } from '../src/manager.mjs';
const base = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(base, '.cache/test-results/runtime');
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
const server = createServer();
await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
const port = server.address().port;
await new Promise(done => server.close(done));
let output = '';
for (const key of Object.keys(process.env)) if (key.toUpperCase() === 'PATH') delete process.env[key];
process.env.PATH = process.platform === 'win32' ? join(process.env.SystemRoot || 'C:\\Windows', 'System32') : '/usr/bin:/bin';
const manager = new Manager(root, join(base, '.cache/payload'), () => {}, line => { output += line + '\n'; }, { requireInstallation: true });
try {
  await manager.initialize();
  await manager.saveSettings({ ...manager.settings, port });
  const installing = performance.now();
  await manager.exclusive(() => manager.installRuntime());
  console.log(`RUNTIME_INSTALL_MS: ${Math.round(performance.now() - installing)}`);
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = performance.now();
    await manager.exclusive(() => manager.start());
    const login = await fetch(manager.url, { redirect: 'manual' });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    const response = await fetch(new URL('/', manager.url), { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<html/i);
    console.log(`RUNTIME_HTTP_READY_${attempt + 1}_MS: ${Math.round(performance.now() - started)}`);
    await manager.exclusive(() => manager.stop());
    assert.equal(manager.snapshot().running, false);
    assert.equal(manager.failure, null);
  }
  const runtime = manager.directory(manager.registry.active);
  await writeFile(join(manager.paths.home, 'restore-smoke-marker'), 'preserve');
  await manager.exclusive(signal => manager.restoreBundled(signal));
  assert.equal(manager.directory(manager.registry.active), runtime);
  assert.equal(await readFile(join(manager.paths.home, 'restore-smoke-marker'), 'utf8'), 'preserve');
  const restored = await fetch(manager.url, { redirect: 'manual' });
  assert.equal(restored.status, 303);
  assert.equal(manager.registry.maintenance, undefined);
  console.log('BUNDLED_OFFLINE_RESTORE_OK');
} finally {
  await manager.close();
  await writeFile(join(root, 'smoke.log'), output);
}
console.log('BUNDLED_RUNTIME_START_RESTART_OK');
