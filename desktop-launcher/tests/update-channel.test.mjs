/** Update channels never substitute prereleases for a missing stable release. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverUpdate } from '../src/update-channel.mjs';
import { targetRef } from '../src/update-target.mjs';
import { DEFAULTS, validateSettings } from '../src/core.mjs';
const stable = { tag_name: 'dsh-v1.0.0', draft: false, prerelease: false, published_at: '2026-01-01' };
const preview = { tag_name: 'dsh-v2.0.0-alpha.1', draft: false, prerelease: true, published_at: '2026-02-01' };

test('stable and preview channels select different releases from the same API response', async () => {
  const request = async () => [null, { tag_name: 42, prerelease: false }, preview, stable];
  assert.equal((await discoverUpdate('stable', request)).tag, stable.tag_name);
  assert.equal((await discoverUpdate('preview', request)).tag, preview.tag_name);
  await assert.rejects(discoverUpdate('stable', async () => [preview]), { code: 'noStable' });
  await assert.rejects(discoverUpdate('stable', async () => [{ ...preview, prerelease: false }]), { code: 'noStable' });
});

test('stable lookup paginates past unrelated and prerelease products', async () => {
  const urls = [];
  const target = await discoverUpdate('stable', async url => {
    urls.push(url);
    return urls.length === 1 ? Array.from({ length: 100 }, () => preview) : [stable];
  });
  assert.equal(target.tag, stable.tag_name);
  assert.match(urls[1], /page=2$/);
});

test('main pins the displayed commit and rejects invalid hashes', async () => {
  const commit = 'a'.repeat(40);
  const target = await discoverUpdate('main', async () => ({ sha: commit, commit: { message: 'change' } }));
  assert.equal(targetRef(target), commit);
  await assert.rejects(discoverUpdate('main', async () => ({ sha: '--upload-pack=bad' })), { code: 'release' });
  assert.throws(() => targetRef({ kind: 'release', tag: 'master' }), { code: 'release' });
});

test('existing settings default to stable; unknown channels are refused', () => {
  const { channel: _channel, ...old } = DEFAULTS;
  assert.equal(validateSettings(old).channel, 'stable');
  assert.throws(() => validateSettings({ ...old, channel: 'other' }), { code: 'settings' });
});
