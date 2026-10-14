/** Check the real checkout's Web announcement and authenticated page with the launcher parser. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { childEnvironment, DEFAULTS, redact } from '../src/core.mjs';
import { launch } from '../src/process.mjs';
import { readyUrl } from '../src/readiness.mjs';

const launcher = resolve(import.meta.dirname, '..'), repository = resolve(launcher, '..');
const results = join(launcher, '.cache/test-results');
await mkdir(results, { recursive: true });
const root = await mkdtemp(join(results, 'source-'));
const env = childEnvironment(process.env, DEFAULTS, 'service', {
  nodeBin: dirname(process.execPath), gitBin: dirname(process.execPath), home: join(root, 'home'),
});
delete env.GIT_EXEC_PATH;
delete env.GIT_TEMPLATE_DIR;
env.DSH_TELEMETRY_DISABLED = '1';
env.TSX_TSCONFIG_PATH = join(repository, 'tsconfig.json');
const tsx = createRequire(join(repository, 'package.json')).resolve('tsx/esm');
let output = '', buffer = '', owned, passed = false;
const timeout = new AbortController();
try {
  for (let attempt = 0; attempt < 2; attempt++) {
    buffer = '';
    let accept, reject;
    const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
    owned = launch(process.execPath, ['--import', pathToFileURL(tsx).href,
      join(repository, 'apps/cli/src/bin.ts'), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: root, env }, (chunk, channel) => {
      output += chunk;
      if (channel !== 'stdout') return;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop().slice(-16384);
      for (const line of lines) {
        try { const url = readyUrl(line, 0); if (url) accept(url); }
        catch (error) { reject(error); }
      }
    });
    const url = await Promise.race([
      ready,
      owned.done.then(() => { throw new Error('DSH exited before announcing readiness'); }),
      delay(120000, null, { signal: timeout.signal }).then(() => { throw new Error('DSH readiness announcement timed out'); }),
    ]);
    const login = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert.ok(cookie);
    await login.body?.cancel();
    const page = await fetch(new URL('/', url), { headers: { cookie }, signal: AbortSignal.timeout(15000) });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html/i);
    await owned.stop(); owned = undefined;
  }
  passed = true;
  console.log('SOURCE_RUNTIME_START_RESTART_OK');
} finally {
  timeout.abort();
  try { await owned?.stop(); }
  finally {
    await writeFile(join(root, 'smoke.log'), redact(output));
    if (passed) await rm(root, { recursive: true, force: true });
    else console.error(`Source smoke diagnostics: ${root}`);
  }
}
