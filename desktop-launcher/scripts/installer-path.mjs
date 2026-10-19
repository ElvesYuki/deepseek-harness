/** Resolve the Windows installer for the current launcher version without selecting stale artifacts. */
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Require the current version's x64 artifact, or an explicitly supplied installer.
 * @param dist - installer output directory.
 * @param version - launcher package version.
 * @param explicit - optional installer path relative to the working directory.
 * @returns the existing installer path; missing artifacts reject without falling back to older versions.
 */
export async function installerPath(dist, version, explicit) {
  const path = explicit === undefined
    ? join(dist, `DSH-Launcher-${version}-Windows-x64-Setup.exe`)
    : resolve(explicit);
  await access(path);
  return path;
}
