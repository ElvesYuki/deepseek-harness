/** Materialize a payload tree for a launched version, keeping the recovery payload independent. */
import { constants } from 'node:fs';
import { LauncherError } from './core.mjs';
import { copyFile, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Create an independent writable runtime without sharing file contents with the recovery payload.
 * @param source - payload directory holding the launched version's files.
 * @param target - destination directory; created recursively and expected to be absent.
 * @param signal - optional cancellation checked between entries.
 * @returns counts after all writes have settled; failures also await in-flight writes before rejecting.
 */
export async function materializeTree(source, target, signal) {
  let files = 0, copied = 0, failure;
  const pending = new Set();
  async function copy(src, dst) {
    const task = copyFile(src, dst, constants.COPYFILE_FICLONE)
      .then(() => { copied++; files++; })
      .catch(error => { failure ??= error; })
      .finally(() => pending.delete(task));
    pending.add(task);
    if (pending.size >= 16) await Promise.race(pending);
    if (failure) throw failure;
  }
  async function visit(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (signal?.aborted) throw new LauncherError('cancelled');
      const src = join(from, entry.name), dst = join(to, entry.name);
      // Linked directories are not Directory entries, so a link never pulls content from outside.
      if (entry.isDirectory()) { await visit(src, dst); continue; }
      if (entry.isSymbolicLink()) {
        // Windows payloads are sealed before packing, so this path carries POSIX payload links.
        const location = relative(resolve(source), resolve(dirname(src), await readlink(src)));
        if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) throw new LauncherError('payload');
        const destination = resolve(target, location);
        await symlink(process.platform === 'win32' ? destination : relative(dirname(dst), destination), dst, process.platform === 'win32' ? 'junction' : undefined);
        files += 1; continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported payload entry: ${dst}`);
      await copy(src, dst);
    }
  }
  try { await visit(source, target); }
  finally { await Promise.all(pending); }
  if (failure) throw failure;
  if (signal?.aborted) throw new LauncherError('cancelled');
  return { files, linked: 0, copied, fallback: null };
}
