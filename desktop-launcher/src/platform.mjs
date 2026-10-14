/** Platform-specific locations for the self-contained tools shipped with the launcher. */
import { posix, win32 } from 'node:path';
import { LauncherError } from './core.mjs';

/** Resolve packaged executables and Git support directories.
 * @param {string} payload Absolute payload directory.
 * @param {string} home Private DSH home.
 * @param {string} platform Target OS identifier.
 * @returns {object} Executable and environment paths for the selected platform.
 */
export function toolPaths(payload, home, platform = process.platform) {
  if (!['darwin', 'win32'].includes(platform)) throw new LauncherError('platform');
  const windows = platform === 'win32', path = windows ? win32 : posix;
  const nodeBin = path.join(payload, windows ? 'node' : 'node/bin');
  const gitBin = path.join(payload, windows ? 'git/cmd' : 'git/bin');
  return { nodeBin, gitBin, home,
    node: path.join(nodeBin, windows ? 'node.exe' : 'node'),
    git: path.join(gitBin, windows ? 'git.exe' : 'git'),
    gitExec: path.join(payload, windows ? 'git/mingw64/libexec/git-core' : 'git/libexec/git-core'),
    gitTemplates: path.join(payload, windows ? 'git/mingw64/share/git-core/templates' : 'git/share/git-core/templates'),
    pnpm: path.join(payload, 'pnpm/bin/pnpm.cjs') };
}
