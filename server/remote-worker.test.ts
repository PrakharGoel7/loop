import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteWorkerConfig, remoteCommandSpec, cleanupRemoteWorkspace, type RemoteWorkspace } from './remote-worker.js';

const workspace: RemoteWorkspace = { host: 'loop-worker', warmRoot: '/opt/loop-worker', root: '/opt/loop-worker/.loop-workspaces/job-test', localRoot: '/tmp/loop-123', localProjectRoot: '/app' };
test('remote execution is opt-in and incomplete or unsafe SSH configuration fails closed', () => {
  assert.equal(remoteWorkerConfig({}), undefined);
  assert.throws(() => remoteWorkerConfig({ LOOP_WORKER_SSH_HOST: 'loop-worker' }), /both/);
  assert.throws(() => remoteWorkerConfig({ LOOP_WORKER_SSH_HOST: '-oProxyCommand=bad', LOOP_WORKER_REMOTE_ROOT: '/opt/loop' }), /Invalid/);
  assert.throws(() => remoteWorkerConfig({ LOOP_WORKER_SSH_HOST: 'loop-worker', LOOP_WORKER_REMOTE_ROOT: '/opt/../bad' }), /absolute/);
  assert.deepEqual(remoteWorkerConfig({ LOOP_WORKER_SSH_HOST: 'worker@host', LOOP_WORKER_REMOTE_ROOT: '/opt/loop/' }), { host: 'worker@host', warmRoot: '/opt/loop' });
});
test('remote commands map workspace and dependencies without rewriting unrelated arguments', () => {
  const spec = remoteCommandSpec(workspace, process.execPath, ['/app/node_modules/typescript/bin/tsc', '-b', '/tmp/loop-123/.loop/schema.json', '/tmp/loop-1234/nope']);
  assert.equal(spec.executable, 'node');
  assert.deepEqual(spec.args, ['/opt/loop-worker/node_modules/typescript/bin/tsc', '-b', workspace.root + '/.loop/schema.json', '/tmp/loop-1234/nope']);
});
test('cleanup rejects roots outside this remote job namespace', async () => {
  let called = false;
  await assert.rejects(cleanupRemoteWorkspace({ ...workspace, root: '/opt/loop-worker' }, async () => { called = true; return { stdout: '', stderr: '' }; }), /Refusing/);
  assert.equal(called, false);
});

test('remote wrapper streams input and cleans its active process record', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { runRemoteCommand } = await import('./remote-worker.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-transport-test-'));
  fs.mkdirSync(path.join(root, '.loop'));
  const execute = promisify(execFile);
  const run = async (_command: string, args: string[], options?: { input?: string }) => {
    // Execute the exact SSH-side command locally, exercising generated wrapper syntax.
    const promise = execute('/bin/sh', ['-c', args.at(-1)!]);
    promise.child.stdin?.end(options?.input);
    return await promise;
  };
  try {
    const actual = await runRemoteCommand({ ...workspace, root }, 'node', ['-e', 'process.stdin.pipe(process.stdout)'], run, { input: 'test prompt', timeoutMs: 1000 });
    assert.equal(actual.stdout, 'test prompt');
    assert.equal(fs.existsSync(path.join(root, '.loop/active-process.json')), false);
    await assert.rejects(runRemoteCommand({ ...workspace, root }, 'node', ['-e', 'setInterval(()=>{},1000)'], run, { timeoutMs: 40 }));
    assert.equal(fs.existsSync(path.join(root, '.loop/active-process.json')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('explicit cancellation stops running work and prevents later commands', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const { runRemoteCommand, cancelRemoteWorkspace } = await import('./remote-worker.js');
  const warmRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-cancel-test-'));
  const root = path.join(warmRoot, '.loop-workspaces/job-test');
  fs.mkdirSync(path.join(root, '.loop'), { recursive: true });
  const execute = promisify(execFile);
  const run = async (_command: string, args: string[], options?: { input?: string }) => {
    const promise = execute('/bin/sh', ['-c', args.at(-1)!]); promise.child.stdin?.end(options?.input); return await promise;
  };
  const handle = { ...workspace, root, warmRoot };
  try {
    const work = runRemoteCommand(handle, 'node', ['-e', 'setInterval(()=>{},1000)'], run, { timeoutMs: 10_000 });
    const rejected = assert.rejects(work);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(root, '.loop/active-process.json')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    await cancelRemoteWorkspace(handle, run); await rejected;
    await assert.rejects(runRemoteCommand(handle, 'node', ['-e', 'process.stdout.write("should not run")'], run));
  } finally { fs.rmSync(warmRoot, { recursive: true, force: true }); }
});
