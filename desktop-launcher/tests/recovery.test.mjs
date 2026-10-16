/** Failed preparation leaves recoverable residue: transient refusals retry, interrupted staging is swept. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Manager } from '../src/manager.mjs';
import { retryOnBusy } from '../src/core.mjs';

const exists = path => access(path).then(() => true, () => false);
const refusal = code => { const error = new Error(code); error.code = code; return error; };

test('a transient sharing refusal is retried until it clears', async () => {
  let calls = 0;
  const result = await retryOnBusy(() => {
    calls += 1;
    if (calls < 3) throw refusal('EPERM');
    return 'renamed';
  }, { attempts: 5, delayMs: 1 });
  assert.equal(result, 'renamed');
  assert.equal(calls, 3);
});

test('retries stop at the attempt limit and preserve the last refusal', async () => {
  let calls = 0;
  await assert.rejects(retryOnBusy(() => { calls += 1; throw refusal('EPERM'); }, { attempts: 3, delayMs: 1 }), { code: 'EPERM' });
  assert.equal(calls, 3);
});

test('an unrelated failure surfaces without a retry', async () => {
  let calls = 0;
  await assert.rejects(retryOnBusy(() => { calls += 1; throw refusal('ENOENT'); }, { attempts: 5, delayMs: 1 }), { code: 'ENOENT' });
  assert.equal(calls, 1);
});

test('an interrupted materialization directory is swept while a prepared update survives', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-sweep-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  await mkdir(join(root, 'versions/copy-stale'), { recursive: true });
  await writeFile(join(root, 'versions/copy-stale/partial.txt'), 'partial');
  await mkdir(join(root, 'versions/update-kept'), { recursive: true });
  const manager = new Manager(root, join(root, 'payload'), () => {}, () => {});
  t.after(() => manager.close());
  await manager.initialize();
  assert.equal(await exists(join(root, 'versions/copy-stale')), false);
  assert.equal(await exists(join(root, 'versions/update-kept')), true);
});
