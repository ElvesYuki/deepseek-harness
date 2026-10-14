/** Owned process trees with awaited shutdown and bounded command execution. */
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { LauncherError } from './core.mjs';

async function settledWithin(done, milliseconds) {
  const controller = new AbortController();
  try { return await Promise.race([done.then(() => true), delay(milliseconds, false, { signal: controller.signal })]); }
  finally { controller.abort(); }
}

/** Spawn without a shell; retain process-group ownership until shutdown completes. */
export function launch(command, args, options, onOutput = () => {}) {
  const child = spawn(command, args, { ...options, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let ended = false;
  const done = new Promise(resolve => {
    child.once('error', error => { ended = true; resolve({ error }); });
    child.once('close', (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', text => onOutput(text, stream === child.stdout ? 'stdout' : 'stderr'));
  }
  const signalGroup = signal => {
    if (!child.pid) return;
    try { process.kill(-child.pid, signal); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  let stopping;
  return {
    child, done, get ended() { return ended; },
    stop() {
      return stopping ??= (async () => {
        if (process.platform === 'win32') {
          if (ended || !child.pid) return;
          const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const killed = new Promise((resolve, reject) => { killer.once('error', reject); killer.once('close', code => resolve(code)); });
          if (!await settledWithin(killed, 10000)) {
            killer.kill(); await killed; throw new LauncherError('stop');
          }
          const code = await killed;
          if ((code !== 0 && !ended) || !await settledWithin(done, 5000)) throw new LauncherError('stop');
          return;
        }
        signalGroup('SIGTERM');
        await settledWithin(done, 8000);
        // The leader may have exited while descendants still own the group's pipes.
        signalGroup('SIGKILL');
        if (!await settledWithin(done, 5000)) throw new LauncherError('stop');
      })();
    },
  };
}

/** Execute a finite build/update command; cancellation awaits child exit before rejecting. */
export async function run(command, args, options, onOutput, signal, timeoutMs = 30 * 60 * 1000) {
  if (signal?.aborted) throw new LauncherError('cancelled');
  const owned = launch(command, args, options, onOutput);
  let reason;
  let cleanup;
  const cancel = code => { reason ??= code; cleanup ??= owned.stop(); cleanup.catch(() => {}); };
  const abort = () => cancel('cancelled');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => cancel('timeout'), timeoutMs);
  try {
    const result = await owned.done;
    await cleanup;
    if (reason) throw new LauncherError(reason);
    if (result.error || result.code !== 0) throw new LauncherError('command', `${command}: ${result.error?.message || result.code || result.signal}`);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
