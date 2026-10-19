/** Admit only official release tags or pinned commits before invoking Git. */
import { LauncherError, releaseTag } from './core.mjs';

/**
 * Normalize a queued update target before it reaches a subprocess or durable journal.
 * @param value - target from the release API or maintenance journal.
 * @returns a validated tag target or exact commit target.
 */
export function updateTarget(value) {
  if (value?.kind === 'release') {
    const tag = releaseTag(value.tag);
    return { kind: 'release', tag, version: tag.slice(5) };
  }
  if (value?.kind === 'commit' && typeof value.commit === 'string' && /^[a-f0-9]{40}$/.test(value.commit)) {
    return { kind: 'commit', commit: value.commit };
  }
  throw new LauncherError('release');
}

/**
 * Resolve the bounded Git fetch argument for a validated target.
 * @param value - release or commit target.
 * @returns the tag ref or full commit hash.
 */
export function targetRef(value) {
  const target = updateTarget(value);
  return target.kind === 'release' ? `refs/tags/${target.tag}` : target.commit;
}
