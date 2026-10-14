/** Validation, private process environment, and durable launcher configuration. */
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPSTREAM = 'https://github.com/deepseek-ai/deepseek-harness.git';
export const RELEASES = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30';
export const DEFAULTS = Object.freeze({ port: 3088, proxy: '', proxyUpdates: true, proxyService: true, proxyBrowser: false });

/** Stable error code used by the localized management UI. */
export class LauncherError extends Error {
  constructor(code, detail = '', options) { super(detail || code, options); this.code = code; }
}

/** Validate settings received over IPC; credentials in proxy URLs are intentionally unsupported. */
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535
    || typeof value.proxy !== 'string' || value.proxy.length > 2048
    || ['proxyUpdates', 'proxyService', 'proxyBrowser'].some(key => typeof value[key] !== 'boolean')) {
    throw new LauncherError('settings');
  }
  let proxy = value.proxy.trim();
  if (proxy) {
    let url;
    try { url = new URL(proxy); } catch (cause) { throw new LauncherError('settings', '', { cause }); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw new LauncherError('settings');
    proxy = url.origin;
  }
  return { port: value.port, proxy, proxyUpdates: value.proxyUpdates, proxyService: value.proxyService, proxyBrowser: value.proxyBrowser };
}

/** Atomic replacement preserves the previous JSON file when writing fails. */
export async function saveJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}

/** Missing state uses a default; corrupt state fails explicitly. */
export async function loadJson(path, fallback) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
  try { return JSON.parse(raw); } catch (cause) { throw new LauncherError('state', path, { cause }); }
}

/** Only release tags are accepted as Git input, never arbitrary refs or executable arguments. */
export function releaseTag(tag) {
  if (typeof tag !== 'string' || !/^dsh-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(tag)) throw new LauncherError('release');
  return tag;
}

/** Return the most recently published product release, including previews, from official API data. */
export function selectRelease(rows) {
  if (!Array.isArray(rows)) throw new LauncherError('release');
  const release = rows.filter(row => row && !row.draft && typeof row.tag_name === 'string'
    && /^dsh-v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/.test(row.tag_name)
    && Number.isFinite(Date.parse(row.published_at)))
    .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))[0];
  if (!release) throw new LauncherError('release');
  return { tag: releaseTag(release.tag_name), version: release.tag_name.slice(5),
    published: release.published_at, notes: typeof release.body === 'string' ? release.body.slice(0, 24000) : '',
    url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/${release.tag_name}` };
}

/** Drop inherited credentials and proxy choices; apply proxy only to the selected child processes. */
export function childEnvironment(base, settings, purpose, paths, platform = process.platform) {
  const env = Object.fromEntries(Object.entries(base).filter(([key]) =>
    !/KEY|SECRET|TOKEN|PASSWORD|PROXY|^NODE_OPTIONS$|^TSX_|^ELECTRON_|^DSH_|^GIT_|^npm_config_/i.test(key)));
  const inheritedPath = Object.entries(base).find(([key]) => key.toUpperCase() === 'PATH')?.[1] || '';
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = [paths.nodeBin, paths.gitBin, inheritedPath].join(platform === 'win32' ? ';' : ':');
  env.DSH_HOME = paths.home;
  env.CI = 'true';
  env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
  env.GIT_TERMINAL_PROMPT = '0';
  if (purpose === 'update') {
    env.GIT_CONFIG_NOSYSTEM = '1';
    env.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  }
  env.GIT_EXEC_PATH = paths.gitExec;
  env.GIT_TEMPLATE_DIR = paths.gitTemplates || join(paths.gitBin, '../share/git-core/templates');
  env.COREPACK_ENABLE_AUTO_PIN = '0';
  env.COREPACK_ENABLE_PROJECT_SPEC = '0';
  env.npm_config_manage_package_manager_versions = 'false';
  if (settings.proxy && (purpose === 'update' ? settings.proxyUpdates : settings.proxyService)) {
    env.HTTP_PROXY = env.HTTPS_PROXY = env.ALL_PROXY = settings.proxy;
    env.http_proxy = env.https_proxy = settings.proxy;
    env.npm_config_proxy = env.npm_config_https_proxy = settings.proxy;
  }
  return env;
}

/** Redact launcher authentication links and common credential assignments before logging. */
export function redact(text) {
  return text.replace(/https?:\/\/[^\s<>"']+/g, raw => {
    try { const url = new URL(raw); url.username = ''; url.password = ''; if (url.search) url.search = '?redacted'; if (url.hash) url.hash = 'redacted'; return url.href; }
    catch { return '[URL]'; }
  }).replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]');
}
