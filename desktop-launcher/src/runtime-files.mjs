/** Keep in-place maintenance confined to an owned directory and detach legacy shared file contents. */
import { copyFile, lstat, readdir, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LauncherError, retryOnBusy } from './core.mjs';

/**
 * Reject redirected runtime roots before destructive maintenance.
 * @param versions - owned parent directory.
 * @param root - selected runtime directory.
 * @returns after confirming the runtime is a real child of the owned parent.
 */
export async function assertRuntimeDirectory(versions, root) {
  if (!(await lstat(versions)).isDirectory() || !(await lstat(root)).isDirectory()) throw new LauncherError('state');
  const suffix = relative(await realpath(versions), await realpath(root));
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new LauncherError('state');
}

/**
 * Replace multiply-linked regular files with independent copies before an in-place build can write them.
 * @param root - owned stopped runtime; directory links are not traversed.
 * @param signal - cancellation checked between files, leaving already detached files valid.
 * @returns the number of detached files.
 */
export async function detachRuntimeFiles(root, signal) {
  let detached = 0;
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (signal?.aborted) throw new LauncherError('cancelled');
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (await lstat(path)).nlink > 1) {
        const temporary = `${path}.detach-${randomUUID()}`;
        await copyFile(path, temporary);
        await retryOnBusy(() => rename(temporary, path));
        detached++;
      }
    }
  }
  await visit(root);
  return detached;
}
