/** Parse the CLI's authenticated ready URL without accepting a remote workspace. */
import { LauncherError } from './core.mjs';

/** Return null for ordinary output; reject an incompatible announced address immediately. */
export function readyUrl(line, port) {
  // The CLI may color its output on interactive hosts.
  // eslint-disable-next-line no-control-regex
  const match = line.replace(/\x1b\[[0-9;]*m/g, '').match(/^dsh web: (\S+:\/\/\S+)\s*$/);
  if (!match) return null;
  let url;
  try { url = new URL(match[1]); }
  catch (cause) { throw new LauncherError('readyAddress', '', { cause }); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || (port !== 0 && Number(url.port) !== port)) throw new LauncherError('readyAddress');
  return url.href;
}
