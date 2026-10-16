/** DSH runtime preparation, service ownership, and staged updates from the official repository. */
import { access, cp, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { toolPaths } from './platform.mjs';
import { restoreRuntimeLinks } from './runtime-links.mjs';
import { materializeTree } from './materialize.mjs';
import { homedir } from 'node:os';
import { inspectHome, importHome, recoverImport } from './data-import.mjs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULTS, UPSTREAM, LauncherError, childEnvironment, loadJson, retryOnBusy, saveJson, validateSettings, releaseTag } from './core.mjs';
import { readyUrl } from './readiness.mjs';
import { launch, run } from './process.mjs';
import semver from 'semver';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Use OS allocation when the preferred loopback port is already occupied. */
async function requestedPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', cause => {
      if (cause.code === 'EADDRINUSE') resolve(0);
      else reject(new LauncherError('port', '', { cause }));
    });
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve(port)));
  });
}

/** Application-owned runtime registry. All public mutations must run through exclusive(). */
export class Manager {
  constructor(root, payload, publish, log) {
    this.root = root; this.payload = payload; this.publish = publish; this.log = log;
    this.settings = { ...DEFAULTS }; this.registry = {}; this.phase = 'idle'; this.busy = false;
    this.service = null; this.url = null; this.prepared = null; this.failure = null; this.failurePath = null;
    this.paths = toolPaths(payload, join(root, 'dsh-home'));
    this.node = this.paths.node; this.git = this.paths.git; this.pnpm = this.paths.pnpm;
  }
  snapshot() {
    return { phase: this.phase, busy: this.busy, settings: this.settings, active: this.registry.active ?? null,
      defaultData: this.defaultData ?? null, prepared: this.registry.prepared ?? null, recoveryRequired: !!this.registry.recoveryRequired,
      actualPort: this.url ? Number(new URL(this.url).port) : null, failure: this.failure, failurePath: this.failurePath, running: !!this.service && !this.service.ended };
  }
  emit() { this.publish(this.snapshot()); }
  env(purpose) { return childEnvironment(process.env, this.settings, purpose, this.paths); }
  directory(record) {
    if (!record || typeof record.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(record.id)) throw new LauncherError('state');
    return join(this.root, 'versions', record.id);
  }
  async persist() { await saveJson(join(this.root, 'runtime.json'), this.registry); }
  async initialize() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.settings = validateSettings(await loadJson(join(this.root, 'settings.json'), DEFAULTS));
    this.registry = await loadJson(join(this.root, 'runtime.json'), {});
    if (!this.registry || typeof this.registry !== 'object') throw new LauncherError('state');
    if (this.registry.active) this.directory(this.registry.active);
    if (this.registry.prepared) this.directory(this.registry.prepared);
    await this.sweepStaging();
    await recoverImport(this);
    await this.discoverData();
    if (this.registry.recoveryRequired) this.failure = 'recovery';
    this.emit();
  }
  /**
   * Delete interrupted materialization directories. initialize() runs only while this process owns the
   * single-instance lock, so no other instance can be writing one; prepared update directories stay,
   * because the registry references them.
   */
  async sweepStaging() {
    const versions = join(this.root, 'versions');
    let names;
    try { names = await readdir(versions); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!name.startsWith('copy-')) continue;
      await rm(join(versions, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }
  async discoverData() {
    const path = join(homedir(), '.dsh');
    try { this.defaultData = { path: await inspectHome(path, this.root), available: true }; }
    catch (error) {
      if (!(error instanceof LauncherError)) throw error;
      this.defaultData = { path, available: false };
    }
    this.emit();
  }
  async importData(source) { await importHome(this, source); }
  async exclusive(operation) {
    if (this.registry.importPending) throw new LauncherError('importRecovery');
    if (this.busy) throw new LauncherError('busy');
    this.busy = true; this.failure = null; this.failurePath = null; this.controller = new AbortController(); this.emit();
    const pending = (async () => {
      try { return await operation(this.controller.signal); }
      catch (error) { this.failure = error instanceof LauncherError ? error.code : 'unexpected'; this.failurePath = error instanceof LauncherError && error.code === 'importLinks' ? error.relativePath : null; this.log(error.message); throw error; }
      finally { this.phase = this.service && !this.service.ended ? 'running' : 'stopped'; this.busy = false; this.controller = null; this.pending = null; this.emit(); }
    })();
    this.pending = pending;
    return pending;
  }
  async saveSettings(value) {
    const settings = validateSettings(value);
    if (this.service && settings.port !== this.settings.port) throw new LauncherError('running');
    await saveJson(join(this.root, 'settings.json'), settings);
    this.settings = settings; this.emit();
  }
  async ensureInitial() {
    if (this.registry.active) return;
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
      for (const path of [this.node, this.git, this.pnpm, join(this.payload, 'dsh/apps/web/dist/index.html')]) await access(path);
    } catch (cause) { throw new LauncherError('payload', '', { cause }); }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new LauncherError('platform');
    this.phase = 'preparing'; this.emit();
    const active = { id: `bundled-${randomUUID()}`, version: manifest.version, commit: manifest.commit };
    const staging = this.directory({ id: `copy-${randomUUID()}` });
    await mkdir(join(this.root, 'versions'), { recursive: true });
    const materialized = await materializeTree(join(this.payload, 'dsh'), staging);
    this.log(`Materialized ${materialized.files} files (${materialized.linked} linked, ${materialized.copied} copied`
      + `${materialized.fallback ? `, ${materialized.fallback} forced copies` : ''})`);
    // A scanner can hold a handle inside the freshly written tree; the refusal clears on its own.
    await retryOnBusy(() => rename(staging, this.directory(active)));
    await restoreRuntimeLinks(this.directory(active));
    this.registry.active = active; await this.persist();
  }
  async start() {
    if (this.registry.recoveryRequired) throw new LauncherError('recovery');
    await this.startService();
  }
  async startService() {
    if (this.registry.importPending) throw new LauncherError('importRecovery');
    if (this.service && !this.service.ended) return;
    await this.ensureInitial();
    const port = await requestedPort(this.settings.port);
    if (this.controller?.signal.aborted) throw new LauncherError('cancelled');
    this.phase = 'starting'; this.emit();
    const root = this.directory(this.registry.active);
    const buffers = { stdout: '', stderr: '' };
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const workspace = join(this.root, 'workspace');
    await mkdir(workspace, { recursive: true });
    const tsx = createRequire(join(root, 'package.json')).resolve('tsx/esm');
    const env = { ...this.env('service'), TSX_TSCONFIG_PATH: join(root, 'tsconfig.json') };
    const service = launch(this.node, ['--import', pathToFileURL(tsx).href, join(root, 'apps/cli/src/bin.ts'), 'web',
      '--no-open', '--host', '127.0.0.1', '--port', String(port)], { cwd: workspace, env }, (chunk, channel) => {
      buffers[channel] += chunk;
      const lines = buffers[channel].split(/\r?\n/); buffers[channel] = lines.pop().slice(-16384);
      for (const line of lines) {
        if (channel === 'stdout') {
          try { const url = readyUrl(line, port); if (url) resolveReady(url); }
          catch (error) { rejectReady(error); }
        }
        this.log(line);
      }
    });
    this.service = service;
    service.done.then(() => {
      if (this.service !== service) return;
      const expected = this.phase === 'stopping';
      this.service = null; this.url = null;
      if (!['fetching', 'building'].includes(this.phase)) this.phase = 'stopped';
      if (!expected) this.failure = 'exited';
      this.emit();
    });
    const timeout = new AbortController();
    try {
      const url = await Promise.race([ready, service.done.then(() => { throw new LauncherError('start'); }),
        delay(120000, null, { signal: timeout.signal }).then(() => { throw new LauncherError('timeout'); })]);
      this.url = url; this.phase = 'running'; this.emit();
    } catch (error) { await this.stop(); throw error; }
    finally { timeout.abort(); }
  }
  async stop() {
    const service = this.service;
    if (!service) { this.phase = 'stopped'; this.emit(); return; }
    this.phase = 'stopping'; this.emit();
    await service.stop();
    this.service = null; this.url = null; this.phase = 'stopped'; this.emit();
  }
  async prepareUpdate(release, signal) {
    const tag = releaseTag(release.tag);
    if (this.registry.active?.version === release.version) throw new LauncherError('current');
    await this.ensureInitial();
    const record = { id: `update-${randomUUID()}`, version: release.version, tag };
    const root = this.directory(record);
    await mkdir(root, { recursive: true });
    const options = { cwd: root, env: this.env('update') };
    const command = (binary, args) => run(binary, args, options, this.log, signal);
    this.phase = 'fetching'; this.emit();
    await command(this.git, ['init', '-q']);
    await command(this.git, ['-c', 'credential.helper=', 'fetch', '--progress', '--depth=1', UPSTREAM, `refs/tags/${tag}`]);
    const hooks = join(this.root, 'empty-git-hooks');
    await mkdir(hooks, { recursive: true });
    await command(this.git, ['-c', `core.hooksPath=${hooks}`, 'checkout', '--detach', 'FETCH_HEAD']);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const bundled = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
    if (manifest.packageManager !== bundled.packageManager || !manifest.engines?.node
      || !semver.satisfies(bundled.nodeVersion, manifest.engines.node)) throw new LauncherError('toolchain');
    this.phase = 'building'; this.emit();
    await command(this.node, [this.pnpm, 'install', '--frozen-lockfile']);
    await command(this.node, [this.pnpm, 'run', 'build']);
    await access(join(root, 'apps/web/dist/index.html'));
    await command(this.node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--help']);
    this.registry.prepared = record; await this.persist();
    this.phase = this.service ? 'running' : 'stopped'; this.emit();
  }
  async activate() {
    if (!this.registry.prepared) throw new LauncherError('release');
    await this.stop();
    this.phase = 'backup'; this.emit();
    const backup = join(this.root, 'backups', randomUUID());
    await mkdir(backup, { recursive: true, mode: 0o700 });
    const homeExists = await access(this.paths.home).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (homeExists) await cp(this.paths.home, join(backup, 'dsh-home'), { recursive: true, verbatimSymlinks: true });
    await saveJson(join(backup, 'recovery.json'), { previous: this.registry.active, target: this.registry.prepared,
      createdAt: new Date().toISOString(), hadDataDirectory: homeExists });
    this.registry.previous = this.registry.active;
    this.registry.active = this.registry.prepared;
    this.registry.prepared = null;
    this.registry.backup = backup;
    this.registry.recoveryRequired = true;
    await this.persist();
    await this.startService();
    this.registry.recoveryRequired = false; await this.persist();
  }
  async retry() {
    await this.startService();
    this.registry.recoveryRequired = false; await this.persist();
  }
  async close() {
    this.controller?.abort();
    await this.stop();
    await this.pending?.catch(() => {});
    await this.stop();
  }
}
