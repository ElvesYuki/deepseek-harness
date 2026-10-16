/** Count payload entries so a build records the tree size a launch must reproduce. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Count every file and link below a root without following links, matching materialization's count.
 * @param root - directory to count.
 * @returns the number of non-directory entries.
 */
export async function countPayloadFiles(root) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    total += entry.isDirectory() ? await countPayloadFiles(join(root, entry.name)) : 1;
  }
  return total;
}
