/** Discover official update targets without treating a missing stable release as a preview. */
import { LauncherError, selectRelease } from './core.mjs';
import { updateTarget } from './update-target.mjs';
const api = 'https://api.github.com/repos/deepseek-ai/deepseek-harness';

/**
 * Query all release pages or pin the main branch to the commit shown to the user.
 * @param channel - stable, preview, or main.
 * @param request - JSON request using the caller's proxy and shared deadline.
 * @returns a validated target with user-facing version and release information.
 */
export async function discoverUpdate(channel, request) {
  if (channel === 'main') {
    const row = await request(`${api}/commits/master`);
    const target = updateTarget({ kind: 'commit', commit: row?.sha });
    return { ...target, channel, version: `master ${target.commit.slice(0, 10)}`,
      notes: typeof row.commit?.message === 'string' ? row.commit.message.slice(0, 24000) : '',
      url: `https://github.com/deepseek-ai/deepseek-harness/commit/${target.commit}` };
  }
  if (!['stable', 'preview'].includes(channel)) throw new LauncherError('settings');
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await request(`${api}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new LauncherError('release');
    rows.push(...batch);
    if (batch.length < 100) return selectRelease(rows, channel);
  }
}
