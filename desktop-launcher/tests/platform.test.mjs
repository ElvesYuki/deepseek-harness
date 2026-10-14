/** Platform resolution is testable without executing foreign binaries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolPaths } from '../src/platform.mjs';
import { childEnvironment, DEFAULTS } from '../src/core.mjs';
test('Windows tool paths and child PATH retain one case-insensitive environment entry', () => {
  const paths = toolPaths('C:\\Program Files\\DSH\\payload', 'C:\\Users\\Person\\AppData\\DSH', 'win32');
  assert.equal(paths.node, 'C:\\Program Files\\DSH\\payload\\node\\node.exe');
  assert.match(paths.git, /git\\cmd\\git.exe$/);
  assert.match(paths.gitExec, /mingw64\\libexec\\git-core$/);
  assert.match(paths.gitTemplates, /mingw64\\share\\git-core\\templates$/);
  const env = childEnvironment({ Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }, DEFAULTS, 'update', paths, 'win32');
  assert.equal(env.Path, undefined);
  assert.equal(env.PATH, `${paths.nodeBin};${paths.gitBin};C:\\Windows\\System32`);
  assert.equal(env.GIT_CONFIG_GLOBAL, 'NUL');
  assert.equal(env.SystemRoot, 'C:\\Windows');
});
test('macOS tools keep their existing archive layout', () => {
  const paths = toolPaths('/payload', '/home', 'darwin');
  assert.equal(paths.node, '/payload/node/bin/node');
  assert.equal(paths.git, '/payload/git/bin/git');
  assert.equal(paths.gitTemplates, '/payload/git/share/git-core/templates');
  assert.throws(() => toolPaths('/payload', '/home', 'linux'), { code: 'platform' });
});
