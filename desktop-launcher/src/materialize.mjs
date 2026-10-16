/** Materialize a payload tree for a launched version, sharing bytes with the payload when the volume allows. */
import { copyFile, link, mkdir, readdir, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Create `target` from `source`, hardlinking regular files so linked bytes are not written twice.
 * @param source - payload directory holding the launched version's files.
 * @param target - destination directory; created recursively and expected to be absent.
 * @returns the written file count, the hardlinked and copied subsets, and the first fallback code.
 */
export async function materializeTree(source, target) {
  let files = 0, linked = 0, copied = 0, fallback = null;
  async function visit(from, to) {
    await mkdir(to, { recursive: true });
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const src = join(from, entry.name), dst = join(to, entry.name);
      // Linked directories are not Directory entries, so a link never pulls content from outside.
      if (entry.isDirectory()) { await visit(src, dst); continue; }
      if (entry.isSymbolicLink()) {
        // Windows payloads are sealed before packing, so this path carries POSIX payload links.
        await symlink(await readlink(src), dst, process.platform === 'win32' ? 'junction' : undefined);
        files += 1; continue;
      }
      if (!entry.isFile()) throw new Error(`Unsupported payload entry: ${dst}`);
      try { await link(src, dst); linked += 1; }
      catch (error) {
        // A refused link costs bandwidth, never correctness: copying is the behavior without linking,
        // and Windows reports some refusals (a second hard link to one name) as UV_UNKNOWN.
        fallback ??= error.code ?? 'link';
        await copyFile(src, dst); copied += 1;
      }
      files += 1;
    }
  }
  await visit(source, target);
  return { files, linked, copied, fallback };
}
