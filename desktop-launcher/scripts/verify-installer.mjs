/** Verify the packaged installer carries every payload file the build recorded. */
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const cache = join(root, '.cache');

/**
 * Find the 7-Zip build electron-builder downloads; it lists an NSIS installer without unpacking it.
 * @param folder - directory to search.
 * @returns the absolute 7za path, or null when this subtree holds none.
 */
async function findSevenZip(folder) {
  let entries;
  try { entries = await readdir(folder, { withFileTypes: true }); }
  catch { return null; }
  for (const entry of entries) {
    const path = join(folder, entry.name);
    if (entry.isFile() && entry.name === '7za.exe') return path;
    if (entry.isDirectory()) { const hit = await findSevenZip(path); if (hit) return hit; }
  }
  return null;
}

/**
 * Count the payload files an installer carries, streaming the listing so memory stays bounded.
 * @param seven - absolute 7za path.
 * @param installer - installer to list.
 * @param prefix - archive path prefix identifying the payload.
 * @returns the number of file entries below the prefix.
 */
function countPayloadEntries(seven, installer, prefix) {
  return new Promise((settle, fail) => {
    const child = spawn(seven, ['l', '-slt', installer], { stdio: ['ignore', 'pipe', 'inherit'] });
    let pending = '', current = '', files = 0;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('Path = ')) current = line.slice(7);
        else if (line.trim() === 'Attributes = A' && current.startsWith(prefix)) files += 1;
      }
    });
    child.once('error', fail);
    child.once('close', code => code === 0 ? settle(files) : fail(new Error(`7za exited with ${code}`)));
  });
}

const manifest = JSON.parse(await readFile(join(cache, 'payload/manifest.json'), 'utf8'));
const seven = await findSevenZip(join(cache, 'electron-builder'));
if (!seven) throw new Error(`No 7za.exe below ${join(cache, 'electron-builder')}; run packaging once to download it.`);
const installer = process.argv[2] ?? (await readdir(join(cache, 'dist')))
  .filter(name => name.endsWith('Setup.exe')).map(name => join(cache, 'dist', name))[0];
if (!installer) throw new Error(`No Setup.exe in ${join(cache, 'dist')}.`);
const found = await countPayloadEntries(seven, installer, 'resources\\payload\\dsh\\');
if (found !== manifest.files) {
  throw new Error(`Installer carries ${found} payload files, but the build recorded ${manifest.files};`
    + ' packaging dropped content, so the installed runtime would be incomplete.');
}
console.log(`INSTALLER_PAYLOAD_OK: ${found} files`);
