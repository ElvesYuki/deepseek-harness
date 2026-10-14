/** Measure the existing offline payload without deleting runtime or update dependencies. */
import { readdir, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../.cache/payload');
async function bytes(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return 0;
  if (stat.isFile()) return stat.size;
  let size = 0;
  for (const entry of await readdir(path)) size += await bytes(join(path, entry));
  return size;
}
for (const entry of await readdir(root)) {
  console.log(`${entry}: ${(await bytes(join(root, entry)) / 1024 / 1024).toFixed(1)} MiB`);
}
