/** DSH runtime preparation, service ownership, and journaled in-place updates from the official repository. */
import { access, lstat, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { toolPaths } from './platform.mjs';
import { restoreRuntimeLinks } from './runtime-links.mjs';
import { materializeTree } from './materialize.mjs';
import { homedir } from 'node:os';
import { inspectHome, importHome, recoverImport } from './data-import.mjs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULTS, UPSTREAM, LauncherError, childEnvironment, loadJson, retryOnBusy, saveJson, validateSettings } from './core.mjs';
import { readyUrl } from './readiness.mjs';
import { launch, run } from './process.mjs';
import semver from 'semver';
import { assertRuntimeDirectory, detachRuntimeFiles } from './runtime-files.mjs';
import { updateTarget, targetRef } from './update-target.mjs';
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
  constructor(root, payload, publish, log, { requireInstallation = false } = {}) {
    this.requireInstallation = requireInstallation;
    this.root = root; this.payload = payload; this.publish = publish; this.log = log;
    this.settings = { ...DEFAULTS }; this.registry = {}; this.phase = 'idle'; this.busy = false;
    this.service = null; this.url = null; this.prepared = null; this.failure = null; this.failurePath = null;
    this.paths = toolPaths(payload, join(root, 'dsh-home'));
    this.node = this.paths.node; this.git = this.paths.git; this.pnpm = this.paths.pnpm;
  }
  snapshot() {
    return { phase: this.phase, busy: this.busy, settings: this.settings, active: this.registry.active ?? null,
      defaultData: this.defaultData ?? null, prepared: this.registry.prepared ?? null, recoveryRequired: !!this.registry.recoveryRequired || !!this.registry.maintenance, maintenance: this.registry.maintenance ?? null,
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
    if (this.registry.maintenance) {
      const pending = this.registry.maintenance;
      if (!['update', 'repair', 'restore'].includes(pending.kind) || pending.id !== this.registry.active?.id) throw new LauncherError('state');
      if (pending.kind !== 'restore') updateTarget(pending.target);
    }
    await this.sweepStaging();
    await recoverImport(this);
    await this.discoverData();
    if (this.registry.active?.verified === false) this.failure = 'payloadIncomplete';
    if (this.registry.recoveryRequired) this.failure = 'recovery';
    if (this.registry.maintenance) this.failure = 'maintenance';
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
  async importData(source) {
    if (this.registry.maintenance) throw new LauncherError('maintenance');
    await importHome(this, source);
  }
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
  /** Refuse known incomplete versions; failed materialization remains staged and never becomes active. */
  async ensureInitial(install = false) {
    if (this.registry.active?.verified === false) throw new LauncherError('payloadIncomplete');
    if (this.registry.active) return;
    if (this.requireInstallation && !install) throw new LauncherError('installationRequired');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
      for (const path of [this.node, this.git, this.pnpm, join(this.payload, 'dsh/apps/web/dist/index.html')]) await access(path);
    } catch (cause) { throw new LauncherError('payload', '', { cause }); }
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new LauncherError('platform');
    this.phase = 'preparing'; this.emit();
    const active = { id: 'current', version: manifest.version, commit: manifest.commit };
    const staging = this.directory({ id: `copy-${randomUUID()}` });
    await mkdir(join(this.root, 'versions'), { recursive: true });
    const materialized = await materializeTree(join(this.payload, 'dsh'), staging, this.controller?.signal);
    this.log(`Materialized ${materialized.files} files (${materialized.linked} linked, ${materialized.copied} copied`
      + `${materialized.fallback ? `, ${materialized.fallback} forced copies` : ''})`);
    // The build recorded the payload's file count; a payload that lost files before materialization
    // (a dropped extraction, a partial copy) is reported rather than served.
    const verified = typeof manifest.files !== 'number' || manifest.files === materialized.files;
    if (!verified) {
      this.log(`Payload holds ${materialized.files} files but the build recorded ${manifest.files}`);
      throw new LauncherError('payloadIncomplete');
    }
    active.files = materialized.files; active.verified = verified;
    // A scanner can hold a handle inside the freshly written tree; the refusal clears on its own.
    // An interrupted first publication may leave an unregistered program at this fixed path.
    await rm(this.directory(active), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await retryOnBusy(() => rename(staging, this.directory(active)));
    await restoreRuntimeLinks(this.directory(active));
    this.registry.active = active; await this.persist();
  }
  /** Prepare the fixed runtime during installation, without starting services or replacing an existing version. */
  async installRuntime() {
    if (this.registry.maintenance) throw new LauncherError('maintenance');
    if (this.registry.recoveryRequired) throw new LauncherError('recovery');
    if (this.registry.importPending) throw new LauncherError('importRecovery');
    await this.ensureInitial(true);
    const root = this.directory(this.registry.active);
    await assertRuntimeDirectory(join(this.root, 'versions'), root);
    await access(join(root, 'apps/web/dist/index.html'));
    await access(join(root, 'apps/cli/src/bin.ts'));
    this.log('INSTALL_RUNTIME_READY');
  }
  async start() {
    if (this.registry.maintenance) throw new LauncherError('maintenance');
    if (this.registry.recoveryRequired) throw new LauncherError('recovery');
    await this.startService();
  }
  async startService(maintenance = false) {
    if (this.registry.maintenance && !maintenance) throw new LauncherError('maintenance');
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
  /** Execute within the fixed runtime; capture only bounded output needed for Git identity. */
  async runtimeCommand(binary, args, signal, capture = false) {
    let output = '';
    await run(binary, args, { cwd: this.directory(this.registry.active), env: this.env('update') }, chunk => {
      this.log(chunk);
      if (capture) output = (output + chunk).slice(-4096);
    }, signal);
    return output.trim();
  }
  /** Persist the interruption marker before any source or dependency mutation. */
  async beginMaintenance(kind, target) {
    if (this.registry.importPending) throw new LauncherError('importRecovery');
    await this.stop();
    if (!this.registry.active) await this.ensureInitial(true);
    const root = this.directory(this.registry.active);
    await assertRuntimeDirectory(join(this.root, 'versions'), root);
    const pending = { kind, id: this.registry.active.id, ...(target ? { target } : {}) };
    this.registry.maintenance = pending;
    await this.persist();
    this.emit();
    return root;
  }
  /** Keep the marker until the rebuilt runtime starts and its successful state is durable. */
  async finishMaintenance(record, signal) {
    if (signal?.aborted) throw new LauncherError('cancelled');
    this.registry.active = { ...record, id: this.registry.active.id, verified: true };
    await this.persist();
    await this.startService(true);
    if (signal?.aborted) { await this.stop(); throw new LauncherError('cancelled'); }
    const pending = this.registry.maintenance;
    const recoveryRequired = this.registry.recoveryRequired;
    delete this.registry.maintenance;
    this.registry.recoveryRequired = false;
    try { await this.persist(); }
    catch (error) {
      this.registry.maintenance = pending;
      this.registry.recoveryRequired = recoveryRequired;
      await this.stop();
      throw error;
    }
  }
  /** Update the fixed runtime without backups; failed or interrupted work blocks ordinary startup. */
  async update(value, signal, kind = 'update') {
    const target = updateTarget(value);
    const root = await this.beginMaintenance(kind, target);
    this.phase = 'preparing'; this.emit();
    await detachRuntimeFiles(root, signal);
    const hooks = join(this.root, 'empty-git-hooks');
    await mkdir(hooks, { recursive: true });
    const metadata = await lstat(join(root, '.git')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (metadata && !metadata.isDirectory()) throw new LauncherError('state');
    const git = args => this.runtimeCommand(this.git, ['-c', `core.hooksPath=${hooks}`, '-c', 'credential.helper=', ...args], signal);
    this.phase = 'fetching'; this.emit();
    await git(['init', '-q']);
    await git(['fetch', '--progress', '--depth=1', '--no-tags', UPSTREAM, targetRef(target)]);
    const commit = await this.runtimeCommand(this.git, ['rev-parse', 'FETCH_HEAD'], signal, true);
    if (!/^[a-f0-9]{40}$/.test(commit) || (target.kind === 'commit' && commit !== target.commit)) throw new LauncherError('state');
    this.registry.maintenance.target = { kind: 'commit', commit };
    await this.persist();
    await git(['reset', '--hard', commit]);
    // This directory owns program files only. Remove obsolete generated files before rebuilding.
    await git(['clean', '-ffdx']);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (target.kind === 'release' && manifest.version !== target.version) throw new LauncherError('release');
    const bundled = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
    if (manifest.packageManager !== bundled.packageManager || !manifest.engines?.node
      || !semver.satisfies(bundled.nodeVersion, manifest.engines.node)) throw new LauncherError('toolchain');
    this.phase = 'building'; this.emit();
    await this.runtimeCommand(this.node, [this.pnpm, 'install', '--frozen-lockfile'], signal);
    await this.runtimeCommand(this.node, [this.pnpm, 'run', 'build'], signal);
    await access(join(root, 'apps/web/dist/index.html'));
    await this.runtimeCommand(this.node, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--help'], signal);
    await this.finishMaintenance({ version: manifest.version, commit, ...(target.kind === 'release' ? { tag: target.tag } : {}) }, signal);
  }
  /** Retry the interrupted target, or rebuild the exact commit of the current version. */
  async repair(signal) {
    if (this.registry.importPending) throw new LauncherError('importRecovery');
    if (this.registry.maintenance?.kind === 'restore') return this.restoreBundled(signal);
    if (!this.registry.maintenance) {
      const bundled = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
      // Fork snapshots may not be fetchable from the official repository; their exact source is bundled.
      if (bundled.commit && bundled.commit === this.registry.active?.commit) return this.restoreBundled(signal);
    }
    const target = this.registry.maintenance?.target ?? { kind: 'commit', commit: this.registry.active?.commit };
    return this.update(target, signal, 'repair');
  }
  /** Recreate program files from the offline payload at the same path; user data is untouched. */
  async restoreBundled(signal) {
    const manifest = JSON.parse(await readFile(join(this.payload, 'manifest.json'), 'utf8'));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new LauncherError('platform');
    await access(join(this.payload, 'dsh/apps/web/dist/index.html'));
    const firstPreparation = !this.registry.active;
    const root = await this.beginMaintenance('restore');
    if (firstPreparation) {
      await this.finishMaintenance(this.registry.active, signal);
      return;
    }
    this.phase = 'restoring'; this.emit();
    for (const name of await readdir(root)) {
      if (signal?.aborted) throw new LauncherError('cancelled');
      await rm(join(root, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    const result = await materializeTree(join(this.payload, 'dsh'), root, signal);
    if (typeof manifest.files === 'number' && manifest.files !== result.files) throw new LauncherError('payloadIncomplete');
    await restoreRuntimeLinks(root);
    await this.finishMaintenance({ version: manifest.version, commit: manifest.commit, files: result.files }, signal);
  }
  async retry(signal) { return this.repair(signal); }
  async close() {
    this.controller?.abort();
    await this.stop();
    await this.pending?.catch(() => {});
    await this.stop();
  }
}
