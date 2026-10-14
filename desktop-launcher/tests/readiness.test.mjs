/** Readiness errors must be immediate without broadening the workspace origin. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readyUrl } from '../src/readiness.mjs';
test('readiness distinguishes ordinary output, loopback URLs and incompatible addresses', () => {
  assert.equal(readyUrl('warning', 3088), null);
  assert.equal(readyUrl('dsh web: listening on 127.0.0.1 over plain HTTP', 3088), null);
  assert.equal(readyUrl('dsh web: http://127.0.0.1:4567/?token=test', 0), 'http://127.0.0.1:4567/?token=test');
  assert.equal(readyUrl('dsh web: http://127.0.0.1:3088/', 3088), 'http://127.0.0.1:3088/');
  for (const value of ['https://127.0.0.1:3088/', 'http://example.com:3088/', 'http://127.0.0.1:4567/', 'http://user:pass@127.0.0.1:3088/', 'http://[invalid']) {
    assert.throws(() => readyUrl(`dsh web: ${value}`, 3088), { code: 'readyAddress' });
  }
});
