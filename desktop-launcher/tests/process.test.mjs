/** Real child processes exercise cancellation, failures, and owned descendant cleanup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, launch } from '../src/process.mjs';

/** Accept one complete stdout PID record; pipe chunks and stderr are not records. */
function readPid(onPid) {
  let pending = '', received = false;
  return (text, stream) => {
    if (stream !== 'stdout' || received) return;
    pending += text;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '');
      pending = pending.slice(end + 1);
      const match = /^FIXTURE_PID:([1-9][0-9]*)$/.exec(line);
      if (!match || !Number.isSafeInteger(Number(match[1]))) continue;
      received = true; onPid(Number(match[1])); return;
    }
  };
}

test('PID records survive split stdout and interleaved stderr without being overwritten', () => {
  const pids = [];
  const output = readPid(pid => pids.push(pid));
  output('FIXTURE_PID:999\n', 'stderr');
  output('unrelated output\nFIXTURE_', 'stdout');
  output('PID:12', 'stdout');
  output('warning\n', 'stderr');
  assert.deepEqual(pids, []);
  output('34\r', 'stdout');
  output('\ntrailing output\n', 'stdout');
  output('FIXTURE_PID:5678\n', 'stdout');
  assert.deepEqual(pids, [1234]);
});

test('nonzero command exit rejects instead of reporting completion', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.exit(7)'], {}, () => {}), { code: 'command' });
});
test('cancellation waits for child shutdown', async () => {
  const controller = new AbortController();
  let pid;
  await assert.rejects(run(process.execPath, ['-e', `process.stderr.write('fixture warning\\n'); console.log('FIXTURE_PID:' + process.pid); process.stderr.write('trailing warning\\n'); setInterval(()=>{},1000)`], {}, readPid(value => {
    pid = value; controller.abort();
  }), controller.signal, 10000), { code: 'cancelled' });
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});
test('deadline terminates a child that remains running', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {}, () => {}, undefined, 200), { code: 'timeout' });
});
test('stop terminates descendants as well as the leader', async t => {
  let descendant;
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const child = launch(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); process.stderr.write('fixture warning\\n'); console.log('FIXTURE_PID:' + p.pid); process.stderr.write('trailing warning\\n'); setInterval(()=>{},1000);`], {}, readPid(value => {
    descendant = value; ready();
  }));
  t.after(() => child.stop());
  let timer;
  try {
    await Promise.race([started, child.done.then(() => { throw new Error('Fixture exited before reporting its descendant PID'); }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Fixture did not report its descendant PID')), 10000); })]);
  } finally { clearTimeout(timer); }
  assert.ok(Number.isSafeInteger(descendant) && descendant > 0);
  await child.stop();
  // A reparented child may briefly remain visible until the OS reaps it.
  for (let i = 0; i < 20; i++) {
    try { process.kill(descendant, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('descendant remained alive');
});
