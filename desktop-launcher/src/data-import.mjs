/** Copy stopped DSH homes without merging databases; journaled swaps preserve the previous home. */
import { cp, lstat, mkdir, readdir, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LauncherError, saveJson } from './core.mjs';

async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function contains(parent, child) {
  const suffix = relative(parent, child);
  return !suffix || (suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Validate a selected data root, rejecting overlaps with launcher-owned files.
 * @param {string} source User-selected home directory.
 * @param {string} root Launcher user-data directory.
 * @returns {Promise<string>} Canonical source directory.
 */
export async function inspectHome(source, root) {
  try {
    if (typeof source !== 'string' || !isAbsolute(source)) throw new Error('Expected an absolute directory');
    const canonical = await realpath(source), target = await realpath(root);
    if (contains(canonical, target) || contains(target, canonical)) throw new Error('Data directories overlap');
    const entries = await readdir(canonical, { withFileTypes: true });
    if (!entries.some(entry => ['sessions', 'storages', 'profiles'].includes(entry.name) && entry.isDirectory())) {
      throw new Error('Select a DSH home containing sessions, storages, or profiles');
    }
    return canonical;
  } catch (cause) { throw new LauncherError('importSource', '', { cause }); }
}

/** Admit persistent data while excluding the shared generated profile dependency directory.
 * @param {string} source Canonical source home.
 * @param {string} path Entry being inspected; no file contents are read.
 * @returns {Promise<boolean>} False for generated shared dependencies; unsupported persistent entries throw with a relative path.
 */
export async function includeImportEntry(source, path) {
  const name = relative(source, path);
  const parts = name.split(sep);
  if (parts[0] === 'profiles' && parts[1] === 'node_modules') return false;
  const info = await lstat(path);
  if (!info.isFile() && !info.isDirectory()) {
    const error = new LauncherError('importLinks', `Unsupported import entry: ${name}`);
    error.relativePath = name;
    throw error;
  }
  return true;
}

/** Restore an interrupted import before permitting service startup.
 * @param {import('./manager.mjs').Manager} manager Stopped runtime owner.
 * @returns {Promise<void>} Resolves after the old home is restored and the journal is cleared.
 */
export async function recoverImport(manager) {
  const pending = manager.registry.importPending;
  if (!pending) return;
  if (typeof pending.id !== 'string' || !/^import-[a-f0-9-]+$/.test(pending.id) || typeof pending.hadData !== 'boolean') {
    throw new LauncherError('state');
  }
  const backup = join(manager.root, 'backups', pending.id), old = join(backup, 'dsh-home');
  const home = manager.paths.home;
  if (await exists(old)) {
    if (await exists(home)) await rename(home, join(backup, `uncommitted-${randomUUID()}`));
    await rename(old, home);
  } else if (!pending.hadData && await exists(home)) {
    await rename(home, join(backup, `uncommitted-${randomUUID()}`));
  } else if (pending.hadData && !await exists(home)) {
    throw new LauncherError('importRecovery');
  }
  delete manager.registry.importPending;
  try { await manager.persist(); }
  catch (error) { manager.registry.importPending = pending; throw error; }
}

/** Import an externally stopped home; leave the client service stopped for explicit startup.
 * @param {import('./manager.mjs').Manager} manager Owner held through exclusive().
 * @param {string} source Selected DSH home. Its files are never modified.
 * @returns {Promise<void>} Resolves after replacement and durable backup; failures restore the old home or block startup.
 */
export async function importHome(manager, source) {
  if (manager.registry.recoveryRequired || manager.registry.importPending) throw new LauncherError('recovery');
  const canonical = await inspectHome(source, manager.root);
  await manager.stop();
  manager.phase = 'importing'; manager.emit();
  const id = `import-${randomUUID()}`, backup = join(manager.root, 'backups', id);
  const incoming = join(backup, 'incoming');
  await mkdir(backup, { recursive: true, mode: 0o700 });
  try {
    await cp(canonical, incoming, { recursive: true, preserveTimestamps: true, filter: async path => {
      if (manager.controller?.signal.aborted) throw new LauncherError('cancelled');
      return includeImportEntry(canonical, path);
    } });
    const hadData = await exists(manager.paths.home);
    await saveJson(join(backup, 'recovery.json'), { source: canonical, createdAt: new Date().toISOString(), hadDataDirectory: hadData, active: manager.registry.active ?? null });
    manager.registry.importPending = { id, hadData };
    await manager.persist();
    if (hadData) await rename(manager.paths.home, join(backup, 'dsh-home'));
    await rename(incoming, manager.paths.home);
    delete manager.registry.importPending;
    try { await manager.persist(); }
    catch (error) { manager.registry.importPending = { id, hadData }; throw error; }
  } catch (cause) {
    try { await recoverImport(manager); }
    catch (recoveryError) {
      manager.failure = 'importRecovery';
      throw new LauncherError('importRecovery', '', { cause: recoveryError });
    }
    if (cause instanceof LauncherError) throw cause;
    throw new LauncherError('importFailed', '', { cause });
  }
}
