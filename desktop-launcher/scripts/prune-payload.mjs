/** Remove payload content the harness never reads, so the installer and the first run write fewer files. */
import { readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

// Repository-only trees: maintainer notes and the recorded-session corpus. .agents/skills stays,
// because skill-filesystem resolves .agents/skills as a runtime skill root.
const ROOT_DIRECTORIES = ['.agents/notes', 'snapshots'];

// Debugger input. The served runtime resolves modules from lib/ and never opens a map.
const FILE_EXTENSION = '.map';

// Packaging drops git placeholders anyway, which would make the packaged file count differ from the
// count this build records. Removing them here keeps the recorded count exact.
const FILE_NAMES = new Set(['.gitkeep']);

/**
 * Measure one path without following links, so a linked directory cannot pull outside the payload.
 * @param path - absolute path to measure.
 * @returns the summed byte size, or zero when the path is already absent.
 */
async function measure(path) {
  const info = await stat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (info === null) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    // A linked directory is not a Directory entry here, so its target is never traversed.
    total += entry.isDirectory() ? await measure(child) : (await stat(child)).size;
  }
  return total;
}

/**
 * Delete every source map plus the repository-only trees, then report what was removed.
 * @param root - extracted DSH source root inside the payload staging directory.
 * @returns the removed file count and byte total.
 */
export async function prunePayload(root) {
  let files = 0;
  let bytes = 0;
  for (const relative of ROOT_DIRECTORIES) {
    const path = join(root, relative);
    const size = await measure(path);
    if (size === 0) continue;
    const removed = await count(path);
    await rm(path, { recursive: true, force: true });
    files += removed; bytes += size;
  }
  async function walk(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!entry.isFile() || (!entry.name.endsWith(FILE_EXTENSION) && !FILE_NAMES.has(entry.name))) continue;
      bytes += (await stat(path)).size;
      await unlink(path);
      files += 1;
    }
  }
  async function count(path) {
    let total = 0;
    for (const entry of await readdir(path, { withFileTypes: true })) {
      total += entry.isDirectory() ? await count(join(path, entry.name)) : 1;
    }
    return total;
  }
  await walk(root);
  return { files, bytes };
}
