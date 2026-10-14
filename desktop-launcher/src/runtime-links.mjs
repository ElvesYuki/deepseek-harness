/** Store package links as relative metadata so Windows installations never retain build-machine junctions. */
import { readdir, realpath, stat, unlink, copyFile, mkdir, symlink, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
const manifestName = '.launcher-links.json';
function inside(root, target) {
  const name = relative(root, target);
  if (!name || name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name)) throw new Error('Runtime link escapes its payload');
  return name;
}

/** Remove links from a built staging tree while recording internal directory targets.
 * @param {string} root Built runtime root, mutated only after all build checks finish.
 * @returns {Promise<void>} Resolves when all directory links are recorded and file links materialized.
 */
export async function sealRuntimeLinks(root) {
  const canonical = await realpath(root), links = [], files = [];
  async function visit(folder) {
    for (const item of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, item.name);
      if (item.isSymbolicLink()) {
        const target = await realpath(path);
        const entry = { path: inside(canonical, path), target: inside(canonical, target) };
        if ((await stat(target)).isDirectory()) links.push(entry);
        else files.push(entry);
      } else if (item.isDirectory()) await visit(path);
    }
  }
  await visit(canonical);
  for (const entry of files) { await unlink(join(canonical, entry.path)); await copyFile(join(canonical, entry.target), join(canonical, entry.path)); }
  await writeFile(join(canonical, manifestName), JSON.stringify(links, null, 2) + '\n');
  for (const entry of links) await unlink(join(canonical, entry.path));
}

/** Restore package links after the runtime reaches its permanent installation directory.
 * @param {string} root Installed runtime root.
 * @returns {Promise<void>} Resolves after every recorded directory target is checked and linked.
 */
export async function restoreRuntimeLinks(root) {
  let raw;
  try { raw = await readFile(join(root, manifestName), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT' && process.platform !== 'win32') return; throw error; }
  const records = JSON.parse(raw), canonical = await realpath(root);
  if (!Array.isArray(records)) throw new Error('Invalid runtime links');
  for (const entry of records) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.target !== 'string' || isAbsolute(entry.path) || isAbsolute(entry.target)) throw new Error('Invalid runtime link path');
    const location = resolve(canonical, entry.path), target = resolve(canonical, entry.target);
    inside(canonical, location); inside(canonical, target);
    inside(canonical, await realpath(target));
    if (!(await stat(target)).isDirectory()) throw new Error('Runtime link target is not a directory');
    await mkdir(dirname(location), { recursive: true });
    // Check real parents too: a previous restored link must not redirect a later write outside the payload.
    const parent = await realpath(dirname(location));
    if (parent !== canonical) inside(canonical, parent);
    await symlink(process.platform === 'win32' ? target : relative(dirname(location), target), location, process.platform === 'win32' ? 'junction' : 'dir');
  }
}
