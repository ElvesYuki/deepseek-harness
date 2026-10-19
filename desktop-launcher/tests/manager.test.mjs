/** Runtime startup preserves process ownership and validates stored directory selection. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';
import { saveJson } from '../src/core.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'launcher-manager-'));
  const manager = new Manager(root, join(root, 'payload'), () => {}, () => {});
  t.after(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await manager.initialize();
  return manager;
}
test('missing payload reports an actionable failure without publishing an active version', async t => {
  const manager = await fixture(t);
  await assert.rejects(manager.exclusive(() => manager.start()), { code: 'payload' });
  assert.equal(manager.registry.active, undefined);
  assert.equal(manager.busy, false);
  assert.equal(manager.failure, 'payload');
});
test('concurrent mutations are refused while a preparation is pending', async t => {
  const manager = await fixture(t);
  let release;
  const pending = manager.exclusive(() => new Promise(resolve => { release = resolve; }));
  try { await assert.rejects(manager.exclusive(() => {}), { code: 'busy' }); }
  finally { release(); await pending; }
  assert.equal(manager.busy, false);
});
test('stored runtime paths cannot escape the owned versions directory', async t => {
  const manager = await fixture(t);
  await saveJson(join(manager.root, 'runtime.json'), { active: { id: '../../external' } });
  await assert.rejects(manager.initialize(), { code: 'state' });
});

async function runningFixture(t, occupied = false, incompatible = false) {
  const manager = await fixture(t);
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  t.after(() => server.listening ? new Promise(resolve => server.close(resolve)) : undefined);
  if (!occupied) await new Promise(resolve => server.close(resolve));
  manager.settings.port = port;
  manager.registry.active = { id: 'fixture', version: '0.0.0' };
  manager.node = process.execPath;
  const root = manager.directory(manager.registry.active);
  await mkdir(join(root, 'node_modules/tsx'), { recursive: true });
  await mkdir(join(root, 'apps/cli/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  await writeFile(join(root, 'node_modules/tsx/package.json'), '{"type":"module","exports":{"./esm":"./noop.mjs"}}');
  await writeFile(join(root, 'node_modules/tsx/noop.mjs'), '');
  await writeFile(join(root, 'apps/cli/src/bin.ts'), `import { createServer } from 'node:http'; process.stderr.write('warning without newline'); const server = createServer((req,res) => res.end('fixture')); server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', () => console.log('dsh web: ${incompatible ? 'https' : 'http'}://127.0.0.1:' + server.address().port + '/?token=fixture'));`);
  if (incompatible) {
    await assert.rejects(manager.exclusive(() => manager.start()), { code: 'readyAddress' });
  } else await manager.exclusive(() => manager.start());
  return manager;
}
test('partial stderr cannot hide stdout readiness and an intentional stop is not a crash', { timeout: 10000 }, async t => {
  const manager = await runningFixture(t);
  assert.equal(manager.snapshot().running, true);
  assert.equal(manager.snapshot().actualPort, manager.settings.port);
  assert.match(manager.url, /token=fixture/);
  await manager.exclusive(() => manager.stop());
  assert.equal(manager.failure, null);
  assert.equal(manager.snapshot().running, false);
});
test('unexpected service exit preserves an active build phase so preparation remains cancellable', { timeout: 10000 }, async t => {
  const manager = await runningFixture(t);
  manager.phase = 'building';
  const service = manager.service;
  await service.stop();
  assert.equal(manager.failure, 'exited');
  assert.equal(manager.phase, 'building');
});

test('occupied preferred port uses an OS-assigned port without replacing the saved preference', { timeout: 10000 }, async t => {
  const manager = await runningFixture(t, true);
  const preferred = manager.settings.port;
  const actual = manager.snapshot().actualPort;
  assert.ok(actual > 0);
  assert.notEqual(actual, preferred);
  assert.equal(await (await fetch(manager.url)).text(), 'fixture');
  await manager.exclusive(() => manager.stop());
  assert.equal(manager.snapshot().actualPort, null);
  await manager.exclusive(() => manager.start());
  assert.notEqual(manager.snapshot().actualPort, preferred);
  assert.equal(manager.settings.port, preferred);
  assert.equal(await (await fetch(manager.url)).text(), 'fixture');
});

test('incompatible readiness fails promptly and stops the child service', { timeout: 10000 }, async t => {
  const manager = await runningFixture(t, false, true);
  assert.equal(manager.service, null);
  assert.equal(manager.url, null);
  assert.equal(manager.snapshot().running, false);
});
