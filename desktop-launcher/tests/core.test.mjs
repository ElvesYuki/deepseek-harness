/** Configuration and update admission reject unsafe input before any subprocess runs. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, validateSettings, releaseTag, selectRelease, childEnvironment, redact, saveJson, loadJson } from '../src/core.mjs';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('proxy configuration rejects credentials and non-proxy URLs', () => {
  for (const proxy of ['file:///tmp/a', 'http://user:pass@localhost:7890', 'http://localhost/x', 'http://localhost/?token=x']) {
    assert.throws(() => validateSettings({ ...DEFAULTS, proxy }), { code: 'settings' });
  }
  assert.equal(validateSettings({ ...DEFAULTS, proxy: ' http://127.0.0.1:7890/ ' }).proxy, 'http://127.0.0.1:7890');
  assert.throws(() => validateSettings({ ...DEFAULTS, port: 80 }), { code: 'settings' });
});
test('release selection ignores drafts, other product tags and option-like input', () => {
  assert.throws(() => releaseTag('--upload-pack=evil'), { code: 'release' });
  const release = selectRelease([
    { tag_name: 'dsh-v1.0.0', published_at: '2026-10-01', draft: false },
    { tag_name: 'dsh-v2.0.0-alpha.1', published_at: '2026-10-02', draft: false },
    { tag_name: 'vendor-v9.0.0', published_at: '2026-10-03' },
    { tag_name: 'dsh-v3.0.0', published_at: '2026-10-04', draft: true },
  ]);
  assert.equal(release.version, '2.0.0-alpha.1');
  assert.equal(release.url, 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v2.0.0-alpha.1');
});
test('child proxies are scoped, loopback bypassed and inherited credentials removed', () => {
  const paths = { nodeBin: '/node', gitBin: '/git', gitExec: '/exec', home: '/home' };
  const base = { PATH: '/bin', API_KEY: 'secret', DEEPSEEK_API_KEY: 'secret', GITHUB_TOKEN: 'secret', HTTPS_PROXY: 'http://old', NODE_OPTIONS: '--inspect' };
  const config = { ...DEFAULTS, proxy: 'http://localhost:7890', proxyService: false };
  const update = childEnvironment(base, config, 'update', paths);
  assert.equal(update.HTTPS_PROXY, config.proxy);
  assert.equal(update.API_KEY, undefined);
  assert.equal(childEnvironment(base, config, 'service', paths).DEEPSEEK_API_KEY, undefined);
  assert.equal(update.GITHUB_TOKEN, undefined);
  assert.equal(update.NODE_OPTIONS, undefined);
  assert.equal(update.CI, 'true');
  assert.equal(update.GIT_CONFIG_GLOBAL, process.platform === 'win32' ? 'NUL' : '/dev/null');
  assert.equal(childEnvironment(base, config, 'service', paths).GIT_CONFIG_GLOBAL, undefined);
  assert.match(update.NO_PROXY, /127\.0\.0\.1/);
  assert.equal(childEnvironment(base, config, 'service', paths).HTTPS_PROXY, undefined);
});
test('authentication URLs and assignments are redacted', () => {
  const text = redact('http://user:pass@127.0.0.1:3088/?token=secret api_key=another');
  assert.ok(!text.includes('secret') && !text.includes('pass') && !text.includes('another'));
});
test('corrupt configuration is surfaced rather than silently replaced', async t => {
  const root = await mkdtemp(join(tmpdir(), 'launcher-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'settings.json');
  assert.deepEqual(await loadJson(path, DEFAULTS), DEFAULTS);
  await saveJson(path, DEFAULTS);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), DEFAULTS);
  await writeFile(path, '{broken');
  await assert.rejects(loadJson(path, DEFAULTS), { code: 'state' });
});
