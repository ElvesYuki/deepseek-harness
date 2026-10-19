/** Bind a reusable Windows payload to the exact source archive and build inputs. */
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Hash source bytes, manifests and launcher build/runtime code in stable path order. */
export async function buildFingerprint(launcher) {
  const hash = createHash('sha256');
  async function add(path, label) { hash.update(label + '\0'); hash.update(await readFile(path)); hash.update('\0'); }
  for (const name of ['source.json', 'source.tar.gz']) await add(join(launcher, '..', name), name);
  for (const name of ['package.json', 'package-lock.json', 'toolchain.json', '.npmrc']) await add(join(launcher, name), name);
  async function visit(folder) {
    const entries = await readdir(join(launcher, folder), { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const key = `${folder}/${entry.name}`;
      if (entry.isDirectory()) await visit(key);
      else if (entry.isFile()) await add(join(launcher, key), key);
      else throw new Error('Build inputs must contain ordinary files');
    }
  }
  for (const folder of ['src', 'scripts', 'installer']) await visit(folder);
  return hash.digest('hex');
}

/** Record inputs only after the complete payload has passed preparation checks. */
export async function recordBuild(launcher, payload) {
  await writeFile(join(payload, 'build-input.json'), JSON.stringify({ version: 1, fingerprint: await buildFingerprint(launcher) }) + '\n');
}

/** Refuse reuse when source or build inputs changed, or no completed record exists. */
export async function verifyBuild(launcher, payload) {
  const record = JSON.parse(await readFile(join(payload, 'build-input.json'), 'utf8'));
  if (record.version !== 1 || record.fingerprint !== await buildFingerprint(launcher)) {
    throw new Error('Build inputs changed. Run Build-Windows.cmd to rebuild; cached downloads are retained.');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const launcher = resolve(import.meta.dirname, '..');
  await verifyBuild(launcher, join(launcher, '.cache/payload'));
  console.log('PAYLOAD_INPUTS_MATCH');
}
