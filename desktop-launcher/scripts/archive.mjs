/** Portable source extraction and ZIP creation without requiring symlink privileges. */
import { cp, mkdir, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';
import yazl from 'yazl';

function inside(root, path) {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || resolve(root, rel) !== path) throw new Error('Source link escapes the snapshot');
  return path;
}

/** Extract a Git archive, materializing internal links as ordinary copies; reject cycles and escapes. */
export async function extractSource(file, destination) {
  const root = resolve(destination), links = new Map();
  await mkdir(root, { recursive: true });
  await x({ file, cwd: root, strict: true, filter(path, entry) {
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      const location = resolve(root, path);
      links.set(location, resolve(entry.type === 'Link' ? root : dirname(location), entry.linkpath));
      return false;
    }
    return true;
  } });
  for (const [path, target] of links) { inside(root, path); inside(root, target); }
  const active = new Set(), done = new Set();
  async function materialize(path) {
    if (done.has(path)) return;
    if (active.has(path)) throw new Error('Cyclic source link');
    active.add(path);
    const target = links.get(path);
    if (target === path || path.startsWith(target + sep)) throw new Error('Cyclic source link');
    for (const candidate of links.keys()) {
      if (candidate === target || candidate.startsWith(target + sep)) await materialize(candidate);
    }
    await mkdir(dirname(path), { recursive: true });
    await cp(target, path, { recursive: true, errorOnExist: true, force: false });
    active.delete(path); done.add(path);
  }
  for (const path of links.keys()) await materialize(path);
}

/** Archive a directory as ZIP with portable separators and one enclosing directory. */
export async function zipDirectory(folder, output, name) {
  const zip = new yazl.ZipFile();
  const writing = pipeline(zip.outputStream, createWriteStream(output));
  // Observe output failures even while the input tree is still being enumerated.
  writing.catch(error => { void error; /* Awaited by the completion or cleanup path below. */ });
  try {
    async function visit(path, archivePath) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const next = join(path, entry.name), key = `${archivePath}/${entry.name}`;
        if (entry.isDirectory()) { zip.addEmptyDirectory(key); await visit(next, key); }
        else if (entry.isFile()) zip.addFile(next, key);
        else throw new Error(`Unsupported ZIP entry: ${key}`);
      }
    }
    await visit(folder, name); zip.end(); await writing;
  } catch (error) {
    zip.outputStream.destroy(error); await writing.catch(error => { void error; /* Awaited by the completion or cleanup path below. */ }); throw error;
  }
}
